const COOLDOWN_MS            = 5000
const ACTIVE_MODE_TIMEOUT_MS = 12000
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
  // All imports lazy — nothing resolves at module load time
  const { CONFIG }            = await import('./config.js')
  const { transcribe }        = await import('./audio/whisper.js')
  const { decide, setMode, getTaskContext, getPeopleContext, getFollowUpContext, getTrajectoryContext, getEpisodicContext, getIdentityContext }
                              = await import('./pipeline/decision.js')
  const { warmupEmbeddings }  = await import('./pipeline/embeddings.js')
  const { speak }             = await import('./pipeline/tts.js')
  const { clearMemory, getContext } = await import('./pipeline/memory.js')
  const { loadKnowledgeBase, ragQuery, saveToHistory } = await import('./pipeline/rag.js')
  const { getDueItems, getForcedItems, fireItem } = await import('./pipeline/pressure.js')

  type Mode = 'negotiation' | 'meeting' | 'interview' | 'social'

  const modeArg = process.argv.find(a => a.startsWith('--mode='))
  const mode    = (modeArg?.split('=')[1] ?? 'negotiation') as Mode

  // Demo exits before any audio init
  if (process.argv.includes('--demo')) {
    const scenario = (process.argv.find(a => a.startsWith('--scenario='))?.split('=')[1] ?? 'negotiation') as any
    const { runDemo } = await import('./pipeline/demo.js')
    await runDemo(scenario, { speak: true, verbose: true })
    process.exit(0)
  }

  setMode(mode)

  const { VAD } = await import('./audio/vad.js')

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

  function startPressureLoop(speakFn: (t: string) => void, isActive: () => boolean): NodeJS.Timeout {
    return setInterval(() => {
      const forced = getForcedItems()
      if (forced.length > 0) {
        const result = fireItem(forced[0].id)
        if (result) { emitARSignal('RED', result.message); speakFn(enforceOutput(result.message)) }
        return
      }
      if (isActive()) return
      const due = getDueItems(false)
      if (!due.length) return
      const result = fireItem(due[0].id)
      if (result) { emitARSignal(urgencyToARSignal(result.state), result.message); speakFn(enforceOutput(result.message)) }
    }, PRESSURE_POLL_MS)
  }

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
  let lastFiredAt = 0, processingChunk = false, ariaActive = false
  let activeTimeout: ReturnType<typeof setTimeout> | null = null

  const inCooldown = () => Date.now() - lastFiredAt < COOLDOWN_MS

  function activateAria() {
    ariaActive = true
    if (activeTimeout) clearTimeout(activeTimeout)
    activeTimeout = setTimeout(() => { ariaActive = false; console.log('[MODE] passive — timeout') }, ACTIVE_MODE_TIMEOUT_MS)
    console.log('[MODE] active'); speak('yes')
  }

  function deactivateAria() {
    ariaActive = false
    if (activeTimeout) clearTimeout(activeTimeout)
    console.log('[MODE] passive')
  }

  const pressureTimer = startPressureLoop(speak, () => ariaActive)

  async function processAudio(audio: Buffer, label: string) {
    if (processingChunk) { console.log(`[SKIP] ${label} — already processing`); return }
    processingChunk = true
    try {
      const transcript = await transcribe(audio)
      if (!transcript) return
      console.log(`[${label}] — "${transcript}"`)
      saveToHistory({ ts: Date.now(), transcript, intent: null, response: null })

      if (ariaActive) { await ariaRespond(transcript); deactivateAria(); return }
      if (inCooldown()) { console.log(`[SKIP] ${label} — cooldown`); return }

      const decision = await decide(transcript)
      if (!decision) return

      if (decision === 'ARIA_QUERY') { activateAria(); await ariaRespond(transcript); deactivateAria(); return }

      const enforced = enforceOutput(decision)
      console.log(`[FIRE] "${enforced}"`)
      lastFiredAt = Date.now()
      emitARSignal('RED', enforced)
      saveToHistory({ ts: Date.now(), transcript, intent: null, response: enforced })
      speak(enforced)
    } catch (err) {
      console.error(`[ERROR] ${label}`, err)
    } finally {
      processingChunk = false
    }
  }

  vad.on('speechStart',  () => console.log('\n[VAD] ▶ speech start'))
  vad.on('misfire',      () => console.log('[VAD] ✗ misfire'))
  vad.on('snapDetected', () => ariaActive ? deactivateAria() : activateAria())
  vad.on('speechChunk',  async (audio: Buffer) => processAudio(audio, 'CHUNK'))
  vad.on('speechEnd',    async (audio: Buffer) => {
    console.log(`[VAD] ■ speech end — ${(audio.length / 2 / CONFIG.SAMPLE_RATE * 1000).toFixed(0)}ms`)
    processAudio(audio, 'END')
  })
  vad.on('error', (err: Error) => { console.error('[VAD ERROR]', err); process.exit(1) })

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