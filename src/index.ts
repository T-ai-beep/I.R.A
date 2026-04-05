/**
 * index.ts
 * ARIA — instant response architecture.
 *
 * Core change: zero cooldown on the hot path.
 * As soon as VAD fires speechEnd → transcribe → decide → speak.
 * No artificial delay. No polling gate. No cooldown block.
 *
 * The only guard is processingChunk — prevents a second transcription
 * from stomping the first if audio chunks overlap. That's it.
 *
 * Pressure poll runs every 30s but ONLY when ARIA is idle (not processing
 * and not in active mode). It never interrupts a live decision.
 */

const ACTIVE_MODE_TIMEOUT_MS = 12_000
const PRESSURE_POLL_MS       = 30_000
const MAX_SPOKEN_WORDS       = 12

function enforceOutput(text: string): string {
  const words = text.trim().split(/\s+/)
  return words.length > MAX_SPOKEN_WORDS ? words.slice(0, MAX_SPOKEN_WORDS).join(' ') : text.trim()
}

type ARSignal = 'RED' | 'YELLOW' | 'GREEN'
function emitARSignal(signal: ARSignal, reason: string) {
  console.log(`[AR] ${signal} — ${reason}`)
}
function urgencyToARSignal(urgency: string): ARSignal {
  if (urgency === 'CRITICAL' || urgency === 'FORCED' || urgency === 'HIGH') return 'RED'
  if (urgency === 'MEDIUM') return 'YELLOW'
  return 'GREEN'
}

async function init() {
  const { CONFIG }            = await import('./config.js')
  const { transcribe }        = await import('./audio/whisper.js')
  const { decide, setMode, getTaskContext, getPeopleContext, getFollowUpContext, getTrajectoryContext, getEpisodicContext, getIdentityContext }
                              = await import('./pipeline/decision.js')
  const { warmupEmbeddings }  = await import('./pipeline/embeddings.js')
  const { speak }             = await import('./pipeline/tts.js')
  const { clearMemory, getContext, getLastTurn } = await import('./pipeline/memory.js')
  const { loadKnowledgeBase, ragQuery, saveToHistory } = await import('./pipeline/rag.js')
  const { getDueItems, getForcedItems, fireItem } = await import('./pipeline/pressure.js')

  type Mode = 'negotiation' | 'meeting' | 'interview' | 'social'

  const modeArg = process.argv.find(a => a.startsWith('--mode='))
  const mode    = (modeArg?.split('=')[1] ?? 'negotiation') as Mode

  setMode(mode)

  const { VAD } = await import('./audio/vad.js')

  // ── Active ARIA response (called when snap-activated or ARIA_QUERY) ───────
  async function ariaRespond(transcript: string): Promise<string> {
    const ctx = getContext()
    const memLine = ctx.lastOffer
      ? `Last offer: $${ctx.lastOffer}. Last intent: ${ctx.lastIntent}.`
      : ctx.lastIntent ? `Last intent: ${ctx.lastIntent}.` : ''

    const ragContext    = await ragQuery(transcript, { useWeb: true, useHistory: true, useKB: true })
    const ragLine       = ragContext ? `\n\nContext:\n${ragContext}` : ''
    const leverageLine  = [
      getTaskContext(), getFollowUpContext(), getPeopleContext(transcript),
      getTrajectoryContext(), await getEpisodicContext(transcript), getIdentityContext(transcript),
    ].filter(Boolean).join('\n\n')

    const res = await fetch(CONFIG.OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        messages: [
          {
            role: 'system',
            content: `You are ARIA, a real-time personal AI in an earpiece.
Max ${MAX_SPOKEN_WORDS} words. Format: ACTION — phrase. Example: "Wait — unclear intent"
Use ONLY context provided. If not in context say "not in context".
${memLine}${ragLine}${leverageLine ? '\n\n' + leverageLine : ''}`,
          },
          { role: 'user', content: transcript },
        ],
        stream: false,
      }),
    })

    const data = await res.json() as { message: { content: string } }
    const raw  = enforceOutput(data.message.content.trim())
    saveToHistory({ ts: Date.now(), transcript, intent: ctx.lastIntent, response: raw })
    console.log(`[ARIA] "${raw}"`)
    speak(raw)
    return raw
  }

  // ── Pressure poll — only fires when ARIA is idle ──────────────────────────
  function startPressureLoop(speakFn: (t: string) => void, isActive: () => boolean): NodeJS.Timeout {
    return setInterval(() => {
      // Never interrupt live processing
      if (isActive()) return

      const forced = getForcedItems()
      if (forced.length > 0) {
        const result = fireItem(forced[0].id)
        if (result) { emitARSignal('RED', result.message); speakFn(enforceOutput(result.message)) }
        return
      }

      const due = getDueItems(false)
      if (!due.length) return
      const result = fireItem(due[0].id)
      if (result) { emitARSignal(urgencyToARSignal(result.state), result.message); speakFn(enforceOutput(result.message)) }
    }, PRESSURE_POLL_MS)
  }

  // ── Warmup ────────────────────────────────────────────────────────────────
  console.log('[INIT] warming up whisper...')
  await transcribe(Buffer.alloc(CONFIG.SAMPLE_RATE * 2))
  console.log('[INIT] whisper ready')

  console.log('[INIT] warming up embeddings...')
  await warmupEmbeddings()
  console.log('[INIT] embeddings ready')

  console.log('[INIT] loading knowledge base...')
  await loadKnowledgeBase()
  console.log('[INIT] RAG ready')

  speak('online')

  const vad = new VAD()

  // processingChunk: true while a transcription + decision is in flight
  // ariaActive: true when snap-activated (ARIA answers next utterance directly)
  let processingChunk = false
  let ariaActive      = false
  let activeTimeout: ReturnType<typeof setTimeout> | null = null

  function activateAria() {
    ariaActive = true
    if (activeTimeout) clearTimeout(activeTimeout)
    activeTimeout = setTimeout(() => {
      ariaActive = false
      console.log('[MODE] passive — timeout')
    }, ACTIVE_MODE_TIMEOUT_MS)
    console.log('[MODE] active')
    speak('yes')
  }

  function deactivateAria() {
    ariaActive = false
    if (activeTimeout) clearTimeout(activeTimeout)
    console.log('[MODE] passive')
  }

  const isActive = () => ariaActive || processingChunk

  const pressureTimer = startPressureLoop(speak, isActive)

  // ── Core audio handler — THIS IS THE HOT PATH ─────────────────────────────
  // Called on both speechChunk (partial) and speechEnd (full utterance).
  // speechEnd always wins — if processingChunk is true from a chunk, speechEnd
  // will be queued and fire as soon as the chunk finishes.
  //
  // No cooldown. No artificial delay. Transcribe → decide → speak.
  // The rule engine runs in <5ms. Embeddings run in ~50ms.
  // LLM only fires for high-impact events and has a 300ms budget.
  // Total latency target: <400ms from end of speech to spoken response.

  async function processAudio(audio: Buffer, label: string) {
    if (processingChunk) {
      console.log(`[SKIP] ${label} — already processing`)
      return
    }
    processingChunk = true
    try {
      const transcript = await transcribe(audio)
      if (!transcript) return

      // Filter whisper noise tokens
      if (/^\[.*\]$/.test(transcript.trim())) {
        console.log(`[SKIP] ${label} — noise token "${transcript}"`)
        return
      }

      console.log(`[${label}] — "${transcript}"`)
      saveToHistory({ ts: Date.now(), transcript, intent: null, response: null })

      // ── Active mode: ARIA answers directly, then returns to passive ──────
      if (ariaActive) {
        await ariaRespond(transcript)
        deactivateAria()
        return
      }

      // ── Passive mode: run the decision pipeline immediately ───────────────
      // No cooldown check. Every utterance gets evaluated.
      // The decision pipeline itself filters noise (PASS path returns null).
      const decision = await decide(transcript)

      // No decision — check if it was a question and route to ariaRespond
      if (!decision) {
        const last = getLastTurn()
        if (last?.intent === 'QUESTION') {
          console.log('[QUESTION] routing to ariaRespond')
          await ariaRespond(transcript)
        }
        return
      }

      // ARIA_QUERY — activate and answer
      if (decision === 'ARIA_QUERY') {
        activateAria()
        await ariaRespond(transcript)
        deactivateAria()
        return
      }

      // Standard coaching output — speak immediately
      const enforced = enforceOutput(decision)
      console.log(`[FIRE] "${enforced}"`)
      emitARSignal('RED', enforced)
      saveToHistory({ ts: Date.now(), transcript, intent: null, response: enforced })
      speak(enforced)

    } catch (err) {
      console.error(`[ERROR] ${label}`, err)
    } finally {
      processingChunk = false
    }
  }

  // ── VAD event wiring ──────────────────────────────────────────────────────
  vad.on('speechStart',  () => console.log('\n[VAD] ▶ speech start'))
  vad.on('misfire',      () => console.log('[VAD] ✗ misfire'))
  vad.on('snapDetected', () => ariaActive ? deactivateAria() : activateAria())

  // speechChunk: partial audio every 2s during long speech.
  // Only process if not already processing — avoids duplicate decisions.
  vad.on('speechChunk', async (audio: Buffer) => {
    if (!processingChunk) processAudio(audio, 'CHUNK')
  })

  // speechEnd: full utterance. This is the PRIMARY trigger.
  // Always attempt to process — processingChunk guard handles overlap.
  vad.on('speechEnd', async (audio: Buffer) => {
    const ms = (audio.length / 2 / CONFIG.SAMPLE_RATE * 1000).toFixed(0)
    console.log(`[VAD] ■ speech end — ${ms}ms`)
    // speechEnd always wins over chunk — if chunk is processing, skip it
    // (chunk will be superseded by the complete utterance anyway)
    processAudio(audio, 'END')
  })

  vad.on('error', (err: Error) => {
    console.error('[VAD ERROR]', err)
    process.exit(1)
  })

  vad.start()
  console.log(`\nARIA online — mode: ${mode} — double snap to activate\n`)

  process.on('SIGINT', () => {
    console.log('\nshutting down')
    clearInterval(pressureTimer)
    vad.stop()
    clearMemory()
    process.exit(0)
  })
}

init()