import { VAD } from './audio/vad.js'
import { transcribe } from './audio/whisper.js'
import { decide, setMode, Mode } from './pipeline/decision.js'
import { speak } from './pipeline/tts.js'
import { CONFIG } from './config.js'

async function init() {
  const modeArg = process.argv.find(a => a.startsWith('--mode='))
  const mode = (modeArg?.split('=')[1] ?? 'negotiation') as Mode
  setMode(mode)

  console.log('[INIT] warming up whisper...')
  const silence = Buffer.alloc(CONFIG.SAMPLE_RATE * 2)
  await transcribe(silence)
  console.log('[INIT] whisper ready')

  speak('online')
  console.log('[INIT] tts ready')

  const vad = new VAD()

  vad.on('speechStart', () => {
    console.log('\n[VAD] ▶ speech start')
  })

  vad.on('misfire', () => {
    console.log('[VAD] ✗ misfire — too short')
  })

  vad.on('speechEnd', async (audio: Buffer) => {
    const t0 = Date.now()
    const tWhisperStart = Date.now()

    console.log(`[VAD] ■ speech end — ${(audio.length / 2 / CONFIG.SAMPLE_RATE * 1000).toFixed(0)}ms of audio`)

    try {
      const transcript = await transcribe(audio)
      const tWhisper = Date.now() - tWhisperStart
      console.log(`[WHISPER] ${tWhisper}ms — "${transcript}"`)

      if (!transcript) {
        console.log('[WHISPER] empty — skipping')
        return
      }

      const tDecisionStart = Date.now()
      const decision = await decide(transcript)
      const tDecision = Date.now() - tDecisionStart
      console.log(`[DECISION] ${tDecision}ms — "${decision ?? 'PASS'}"`)

      if (!decision) {
        console.log(`[PASS] total: ${Date.now() - t0}ms`)
        return
      }

      const tTTSStart = Date.now()
      speak(decision)
      const tTTS = Date.now() - tTTSStart

      const total = Date.now() - t0
      console.log(`[TTS] ${tTTS}ms queued`)
      console.log(`[✓] whisper:${tWhisper}ms + decision:${tDecision}ms + tts:${tTTS}ms = ${total}ms total`)
      console.log(`[✓] "${transcript}" → "${decision}"`)

    } catch (err) {
      console.error('[ERROR]', err)
    }
  })

  vad.on('error', (err: Error) => {
    console.error('[VAD ERROR]', err)
    process.exit(1)
  })

  vad.start()
  console.log(`\nARIA online — mode: ${mode}\n`)

  process.on('SIGINT', () => {
    console.log('\nshutting down')
    vad.stop()
    process.exit(0)
  })
}

init()