/**
 * daemon.ts — Always-on 24/7 capture daemon
 *
 * This is NOT the main ARIA pipeline. This runs in the background
 * always, capturing everything, storing to captureStore, and
 * periodically pushing to episodic memory.
 *
 * Lifecycle:
 *   start() → VAD listens → transcribe chunks → writeCapture()
 *            → every SESSION_CLOSE_SILENCE_MS of silence → close session
 *            → build session summary → push to episodic
 *
 * Two modes:
 *   PASSIVE  — capture everything, don't run decision pipeline
 *   ACTIVE   — capture + run ARIA decision pipeline (normal ARIA mode)
 *
 * Run: npx tsx src/capture/daemon.ts
 *      npx tsx src/capture/daemon.ts --mode=passive
 *      npx tsx src/capture/daemon.ts --passive --no-decision
 */

import { spawn }         from 'child_process'
import { EventEmitter }  from 'events'
import * as os           from 'os'
import * as path         from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

// ── Config ─────────────────────────────────────────────────────────────────

const SAMPLE_RATE          = 16000
const CHANNELS             = 1
const VAD_THRESHOLD        = 0.015
const SILENCE_MS           = 600
const MIN_SPEECH_MS        = 200
const PRE_SPEECH_PAD_MS    = 200
const FRAME_MS             = 30

// Session boundary: 2 min silence = new session
const SESSION_CLOSE_SILENCE_MS = 2 * 60 * 1000

// How often to flush unprocessed captures to episodic
const EPISODIC_FLUSH_INTERVAL_MS = 5 * 60 * 1000

// Max captures to batch-push to episodic at once
const EPISODIC_BATCH_SIZE = 20

// ── State ──────────────────────────────────────────────────────────────────

let daemonSessionId   = `daemon_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
let lastSpeechAt      = Date.now()
let captureCount      = 0
let sessionTurnCount  = 0

// ── RMS helper ─────────────────────────────────────────────────────────────

function rms(buf: Buffer): number {
  let sum = 0
  for (let i = 0; i < buf.length; i += 2) {
    const s = buf.readInt16LE(i) / 32768
    sum += s * s
  }
  return Math.sqrt(sum / (buf.length / 2))
}

// ── Whisper transcription ──────────────────────────────────────────────────

const WHISPER_CLI   = process.env.WHISPER_CLI   ?? '/Users/tanayshah/A.R.I.A/whisper.cpp/build/bin/whisper-cli'
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? '/Users/tanayshah/A.R.I.A/whisper.cpp/models/ggml-tiny.en.bin'
const VENV_PYTHON   = process.env.VENV_PYTHON   ?? '/Users/tanayshah/A.R.I.A/.venv/bin/python3'

import * as fs   from 'fs'
import * as tmp  from 'os'

async function transcribeBuffer(audio: Buffer): Promise<string | null> {
  const tmpWav = path.join(tmp.tmpdir(), `daemon_${Date.now()}.wav`)
  try {
    await writeWav(audio, tmpWav)
    const text = await new Promise<string>((resolve, reject) => {
      const proc = spawn(WHISPER_CLI, [
        '-m', WHISPER_MODEL,
        '-f', tmpWav,
        '--no-timestamps', '-nt',
        '--language', 'en',
      ])
      let out = ''
      proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
      proc.stderr.on('data', () => {})
      proc.on('exit', code => {
        if (code !== 0) return reject(new Error(`whisper exit ${code}`))
        const clean = out.split('\n')
          .filter(l => l.trim() && !l.startsWith('[') && !l.startsWith('whisper') && !l.startsWith('ggml'))
          .join(' ').trim()
        resolve(clean)
      })
    })
    return text || null
  } catch (e) {
    console.error('[DAEMON] transcription error:', e)
    return null
  } finally {
    try { fs.unlinkSync(tmpWav) } catch {}
  }
}

function writeWav(pcm: Buffer, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sampleRate = SAMPLE_RATE
    const channels   = CHANNELS
    const bitDepth   = 16
    const byteRate   = sampleRate * channels * bitDepth / 8
    const blockAlign = channels * bitDepth / 8
    const dataSize   = pcm.length
    const header     = Buffer.alloc(44)

    header.write('RIFF', 0)
    header.writeUInt32LE(36 + dataSize, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitDepth, 34)
    header.write('data', 36)
    header.writeUInt32LE(dataSize, 40)

    fs.writeFile(outPath, Buffer.concat([header, pcm]), err => {
      if (err) reject(err)
      else resolve()
    })
  })
}

// ── Session management ─────────────────────────────────────────────────────

function newSession(): void {
  const old = daemonSessionId
  daemonSessionId  = `daemon_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
  sessionTurnCount = 0
  console.log(`[DAEMON] new session: ${daemonSessionId} (closed: ${old})`)
}

function checkSessionBoundary(): void {
  const silenceDuration = Date.now() - lastSpeechAt
  if (silenceDuration > SESSION_CLOSE_SILENCE_MS && sessionTurnCount > 0) {
    console.log(`[DAEMON] session boundary — ${silenceDuration}ms silence`)
    flushToEpisodic().catch(console.error)
    newSession()
  }
}

// ── Episodic flush ─────────────────────────────────────────────────────────

async function flushToEpisodic(): Promise<void> {
  try {
    const { getUnprocessed, markProcessed } = await import('./captureStore.js')
    const { storeEpisode }                  = await import('../pipeline/epsodic.js')

    const unprocessed = getUnprocessed().slice(0, EPISODIC_BATCH_SIZE)
    if (!unprocessed.length) return

    console.log(`[DAEMON] flushing ${unprocessed.length} captures to episodic...`)

    // Group by session and combine short utterances
    const bySession: Record<string, typeof unprocessed> = {}
    for (const entry of unprocessed) {
      if (!bySession[entry.sessionId]) bySession[entry.sessionId] = []
      bySession[entry.sessionId].push(entry)
    }

    for (const [sessionId, entries] of Object.entries(bySession)) {
      // Only process "other" speaker — we don't want to episodically store our own chatter
      const otherEntries = entries.filter(e => e.speaker !== 'self')
      if (!otherEntries.length) {
        entries.forEach(e => markProcessed(e.id))
        continue
      }

      // Combine entries into a single episodic event if they're part of same session
      const combined = otherEntries.map(e => e.transcript).join(' ')
      if (combined.length < 20) {
        entries.forEach(e => markProcessed(e.id))
        continue
      }

      // Extract person if present
      const personMatch = combined.match(/([A-Z][a-z]{2,14})(?:\s|$)/)
      const person      = personMatch?.[1] ?? null

      await storeEpisode(combined.slice(0, 300), person, {
        tags: [...new Set(otherEntries.flatMap(e => e.tags))],
      })

      entries.forEach(e => markProcessed(e.id))
    }

    console.log(`[DAEMON] episodic flush complete`)
  } catch (e) {
    console.error('[DAEMON] episodic flush error:', e)
  }
}

// ── VAD + capture loop ─────────────────────────────────────────────────────

class DaemonVAD extends EventEmitter {
  private speaking     = false
  private silenceMs    = 0
  private speechMs     = 0
  private chunks:      Buffer[] = []
  private padBuffer:   Buffer[] = []
  private sox:         ReturnType<typeof spawn> | null = null

  start() {
    this.sox = spawn('sox', [
      '-d',
      '-r', String(SAMPLE_RATE),
      '-c', String(CHANNELS),
      '-e', 'signed-integer',
      '-b', '16',
      '-t', 'raw',
      '-',
    ])

    this.sox.stderr?.on('data', () => {})
    this.sox.stdout?.on('data', (chunk: Buffer) => { this.processChunk(chunk) })
    this.sox.on('exit', code => {
      console.log(`[DAEMON] sox exited (${code}), restarting...`)
      setTimeout(() => this.start(), 1000)
    })

    console.log('[DAEMON] VAD listening...')
  }

  stop() {
    this.sox?.kill()
    this.sox = null
  }

  private processChunk(chunk: Buffer) {
    const energy    = rms(chunk)
    const isSpeech  = energy > VAD_THRESHOLD
    const isSilence = energy < VAD_THRESHOLD * 0.6

    this.padBuffer.push(chunk)
    const padFrames = Math.ceil(PRE_SPEECH_PAD_MS / FRAME_MS)
    if (this.padBuffer.length > padFrames) this.padBuffer.shift()

    if (!this.speaking) {
      if (isSpeech) {
        this.speaking  = true
        this.silenceMs = 0
        this.speechMs  = FRAME_MS
        this.chunks    = [...this.padBuffer]
      }
    } else {
      this.chunks.push(chunk)
      this.speechMs += FRAME_MS

      if (isSilence) {
        this.silenceMs += FRAME_MS
        if (this.silenceMs >= SILENCE_MS) {
          this.speaking  = false
          this.silenceMs = 0

          if (this.speechMs >= MIN_SPEECH_MS) {
            const audio = Buffer.concat(this.chunks)
            this.emit('speech', audio, this.speechMs)
          }

          this.chunks   = []
          this.speechMs = 0
        }
      } else {
        this.silenceMs = 0
      }
    }
  }
}

// ── Process audio chunk ────────────────────────────────────────────────────

async function processAudio(audio: Buffer, speechMs: number): Promise<void> {
  lastSpeechAt = Date.now()

  const transcript = await transcribeBuffer(audio)
  if (!transcript) return
  if (/^\[.*\]$/.test(transcript.trim())) return // whisper noise tokens
  if (transcript.trim().split(/\s+/).length < 3) return // too short

  // Write to capture store
  const { writeCapture } = await import('./captureStore.js')
  const entry = writeCapture(
    transcript,
    'other',          // daemon always-on: treat as other (no diarization in daemon)
    daemonSessionId,
    speechMs,
    'mic'
  )

  captureCount++
  sessionTurnCount++

  console.log(`[DAEMON] [${entry.date} ${entry.hour}:xx] cap#${captureCount} — "${transcript.slice(0, 60)}"`)

  // Check for session boundary on each capture
  checkSessionBoundary()
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const passive = process.argv.includes('--passive') || process.argv.includes('--mode=passive')

  console.log(`
╔═══════════════════════════════════════════════════╗
  ARIA CAPTURE DAEMON
  Mode: ${passive ? 'PASSIVE (capture only)' : 'ACTIVE (capture + decision pipeline)'}
  Session: ${daemonSessionId}
  Storage: ~/.aria/capture.jsonl
╚═══════════════════════════════════════════════════╝
`)

  // Print existing stats
  try {
    const { getCaptureStats } = await import('./captureStore.js')
    const stats = getCaptureStats()
    console.log(`[DAEMON] existing captures: ${stats.total} total, ${stats.today} today, ${stats.daysActive} days active`)
  } catch {}

  const vad = new DaemonVAD()

  vad.on('speech', async (audio: Buffer, speechMs: number) => {
    try {
      await processAudio(audio, speechMs)
    } catch (e) {
      console.error('[DAEMON] processAudio error:', e)
    }
  })

  // Periodic episodic flush
  const flushInterval = setInterval(() => {
    flushToEpisodic().catch(console.error)
  }, EPISODIC_FLUSH_INTERVAL_MS)

  // Session boundary checker (runs every 30s)
  const sessionChecker = setInterval(() => {
    checkSessionBoundary()
  }, 30_000)

  vad.start()

  process.on('SIGINT', async () => {
    console.log('\n[DAEMON] shutting down...')
    clearInterval(flushInterval)
    clearInterval(sessionChecker)
    vad.stop()

    // Final flush
    await flushToEpisodic()

    const { getCaptureStats } = await import('./captureStore.js')
    const stats = getCaptureStats()
    console.log(`[DAEMON] captured ${captureCount} chunks this run. Total: ${stats.total}.`)
    process.exit(0)
  })

  console.log('[DAEMON] running. Press Ctrl+C to stop.\n')
}

main().catch(e => { console.error(e); process.exit(1) })