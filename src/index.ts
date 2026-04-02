import { VAD } from './audio/vad.js'
import { transcribe } from './audio/whisper.js'
import { decide, setMode, Mode } from './pipeline/decision.js'
import { warmupEmbeddings } from './pipeline/embeddings.js'
import { speak } from './pipeline/tts.js'
import { clearMemory, getContext } from './pipeline/memory.js'
import { CONFIG } from './config.js'

const COOLDOWN_MS = 5000
const ACTIVE_MODE_TIMEOUT_MS = 10000

async function ariaRespond(transcript: string): Promise<void> {
  const ctx = getContext()
  const memLine = ctx.lastOffer
    ? `Last offer: $${ctx.lastOffer}. Last intent: ${ctx.lastIntent}.`
    : ctx.lastIntent
    ? `Last intent: ${ctx.lastIntent}.`
    : ''

  const res = await fetch(CONFIG.OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CONFIG.OLLAMA_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are ARIA, a personal AI assistant in an earpiece. 
Be extremely concise — max 12 words. Direct answers only. No filler. No preamble.
${memLine}`
        },
        { role: 'user', content: transcript }
      ],
      stream: false,
    })
  })
  const data = await res.json() as { message: { content: string } }
  const response = data.message.content.trim()
  console.log(`[ARIA ACTIVE] "${response}"`)
  speak(response)
}

async function init() {
  const modeArg = process.argv.find(a => a.startsWith('--mode='))
  const mode = (modeArg?.split('=')[1] ?? 'negotiation') as Mode
  setMode(mode)

  console.log('[INIT] warming up whisper...')
  const silence = Buffer.alloc(CONFIG.SAMPLE_RATE * 2)
  await transcribe(silence)
  console.log('[INIT] whisper ready')

  console.log('[INIT] warming up embeddings...')
  await warmupEmbeddings()
  console.log('[INIT] embeddings ready')

  speak('online')

  const vad = new VAD()

  let lastFiredAt = 0
  let processingChunk = false
  let ariaActive = false
  let activeTimeout: ReturnType<typeof setTimeout> | null = null

  function inCooldown(): boolean {
    return Date.now() - lastFiredAt < COOLDOWN_MS
  }

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

  async function processAudio(audio: Buffer, label: string) {
    if (processingChunk) {
      console.log(`[SKIP] ${label} — already processing`)
      return
    }

    processingChunk = true

    try {
      const transcript = await transcribe(audio)
      if (!transcript) return

      console.log(`[${label}] — "${transcript}"`)

      if (ariaActive) {
        await ariaRespond(transcript)
        deactivateAria()
        return
      }

      if (inCooldown()) {
        console.log(`[SKIP] ${label} — cooldown`)
        return
      }

      const decision = await decide(transcript)
      if (!decision) return

      // ARIA_QUERY — user is talking to ARIA directly
      if (decision === 'ARIA_QUERY') {
        activateAria()
        await ariaRespond(transcript)
        deactivateAria()
        return
      }

      console.log(`[FIRE] "${decision}"`)
      lastFiredAt = Date.now()
      speak(decision)

    } catch (err) {
      console.error(`[ERROR] ${label}`, err)
    } finally {
      processingChunk = false
    }
  }

  vad.on('speechStart', () => console.log('\n[VAD] ▶ speech start'))
  vad.on('misfire', () => console.log('[VAD] ✗ misfire'))

  vad.on('snapDetected', () => {
    if (ariaActive) {
      deactivateAria()
    } else {
      activateAria()
    }
  })

  vad.on('speechChunk', async (audio: Buffer) => {
    await processAudio(audio, 'CHUNK')
  })

  vad.on('speechEnd', async (audio: Buffer) => {
    console.log(`[VAD] ■ speech end — ${(audio.length / 2 / CONFIG.SAMPLE_RATE * 1000).toFixed(0)}ms`)
    await processAudio(audio, 'END')
  })

  vad.on('error', (err: Error) => {
    console.error('[VAD ERROR]', err)
    process.exit(1)
  })

  vad.start()
  console.log(`\nARIA online — mode: ${mode} — double snap to activate\n`)

  process.on('SIGINT', () => {
    console.log('\nshutting down')
    vad.stop()
    clearMemory()
    process.exit(0)
  })
}

init()