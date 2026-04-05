/**
 * index.ts
 * ARIA — streaming pipeline
 *
 * Changes from previous version:
 * 1. decide() now calls speak() internally — removed redundant speak() here
 * 2. ariaRespond() uses streaming LLM → TTS via same pattern as llmFallbackStreaming
 * 3. No other logic changed
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

  // ── ariaRespond: streaming LLM → TTS ─────────────────────────────────────
  // Mirrors llmFallbackStreaming — speaks as tokens arrive.
  // Called when snap-activated or QUESTION event with no rule hit.

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

    const systemPrompt = `You are ARIA, a real-time personal AI in an earpiece.
Max ${MAX_SPOKEN_WORDS} words. Format: ACTION — phrase. Example: "Wait — unclear intent"
Use ONLY context provided. If not in context say "not in context".
${memLine}${ragLine}${leverageLine ? '\n\n' + leverageLine : ''}`

    let fullResponse = ''
    let buffer       = ''
    let firstToken   = true
    const t0         = Date.now()

    try {
      const res = await fetch(CONFIG.OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CONFIG.OLLAMA_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: transcript },
          ],
          stream: true,   // ← streaming
        }),
      })

      if (!res.body) throw new Error('no body')

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })

        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue

          let parsed: { message?: { content?: string }; done?: boolean }
          try { parsed = JSON.parse(trimmed) } catch { continue }
          if (parsed.done) break

          const token = parsed.message?.content ?? ''
          if (!token) continue

          if (firstToken) {
            console.log(`[ARIA] first token @ ${Date.now() - t0}ms`)
            firstToken = false
          }

          buffer       += token
          fullResponse += token

          // Speak every 3 words
          const wordCount = buffer.trim().split(/\s+/).filter(Boolean).length
          if (wordCount >= 3) {
            const clean = enforceOutput(buffer.trim())
            if (clean) speak(clean)
            buffer = ''
          }
        }
      }

      // Flush tail
      const tail = enforceOutput(buffer.trim())
      if (tail) speak(tail)

    } catch (e) {
      console.error('[ARIA] stream error', e)
      // Fallback: speak what we have
      if (fullResponse.trim()) speak(enforceOutput(fullResponse.trim()))
    }

    const raw = enforceOutput(fullResponse.trim())
    saveToHistory({ ts: Date.now(), transcript, intent: getContext().lastIntent, response: raw })
    console.log(`[ARIA] "${raw}" total=${Date.now() - t0}ms`)
    return raw
  }

  // ── Pressure poll ─────────────────────────────────────────────────────────
  function startPressureLoop(speakFn: (t: string) => void, isActive: () => boolean): NodeJS.Timeout {
    return setInterval(() => {
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

  async function processAudio(audio: Buffer, label: string) {
    if (processingChunk) {
      console.log(`[SKIP] ${label} — already processing`)
      return
    }
    processingChunk = true
    try {
      const transcript = await transcribe(audio)
      if (!transcript) return

      if (/^\[.*\]$/.test(transcript.trim())) {
        console.log(`[SKIP] ${label} — noise token "${transcript}"`)
        return
      }

      console.log(`[${label}] — "${transcript}"`)
      saveToHistory({ ts: Date.now(), transcript, intent: null, response: null })

      // Active mode: ARIA answers directly
      if (ariaActive) {
        await ariaRespond(transcript)
        deactivateAria()
        return
      }

      // Passive mode: decision pipeline
      // NOTE: decide() now calls speak() internally on every path.
      // We do NOT call speak() here again.
      const decision = await decide(transcript)

      if (!decision) {
        const last = getLastTurn()
        if (last?.intent === 'QUESTION') {
          console.log('[QUESTION] routing to ariaRespond')
          await ariaRespond(transcript)
        }
        return
      }

      if (decision === 'ARIA_QUERY') {
        activateAria()
        await ariaRespond(transcript)
        deactivateAria()
        return
      }

      // decision already spoken inside decide() — just log
      const enforced = enforceOutput(decision)
      console.log(`[FIRE] "${enforced}"`)
      emitARSignal('RED', enforced)
      saveToHistory({ ts: Date.now(), transcript, intent: null, response: enforced })
      // ← NO speak() call here. decide() already spoke it.

    } catch (err) {
      console.error(`[ERROR] ${label}`, err)
    } finally {
      processingChunk = false
    }
  }

  vad.on('speechStart',  () => console.log('\n[VAD] ▶ speech start'))
  vad.on('misfire',      () => console.log('[VAD] ✗ misfire'))
  vad.on('snapDetected', () => ariaActive ? deactivateAria() : activateAria())

  vad.on('speechChunk', async (audio: Buffer) => {
    if (!processingChunk) processAudio(audio, 'CHUNK')
  })

  vad.on('speechEnd', async (audio: Buffer) => {
    const ms = (audio.length / 2 / CONFIG.SAMPLE_RATE * 1000).toFixed(0)
    console.log(`[VAD] ■ speech end — ${ms}ms`)
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