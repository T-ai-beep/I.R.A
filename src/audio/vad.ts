import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { CONFIG } from '../config.js'

const FRAME_MS = 30
const CHUNK_INTERVAL_MS = 2000

const SNAP_ENERGY_THRESHOLD = 0.08
const SNAP_DURATION_MAX_MS = 150
const SNAP_WINDOW_MS = 600

function rms(buf: Buffer): number {
  let sum = 0
  for (let i = 0; i < buf.length; i += 2) {
    const s = buf.readInt16LE(i) / 32768
    sum += s * s
  }
  return Math.sqrt(sum / (buf.length / 2))
}

export class VAD extends EventEmitter {
  private speaking = false
  private silenceMs = 0
  private speechMs = 0
  private chunks: Buffer[] = []
  private padBuffer: Buffer[] = []
  private chunkAccumMs = 0
  private sox: ReturnType<typeof spawn> | null = null

  private lastSnapAt = 0
  private snapTransientMs = 0
  private inSnap = false

  start() {
    this.sox = spawn('sox', [
      '-d',
      '-r', String(CONFIG.SAMPLE_RATE),
      '-c', String(CONFIG.CHANNELS),
      '-e', 'signed-integer',
      '-b', '16',
      '-t', 'raw',
      '-',
    ])

    this.sox.stderr?.on('data', () => {})
    this.sox.stdout?.on('data', (chunk: Buffer) => { this.processChunk(chunk) })
    this.sox.on('exit', (code) => {
      if (code !== 0) this.emit('error', new Error(`sox exited ${code}`))
    })

    console.log('[VAD] listening...')
  }

  stop() {
    this.sox?.kill()
    this.sox = null
  }

  private detectSnap(energy: number): boolean {
    const now = Date.now()

    if (energy > SNAP_ENERGY_THRESHOLD) {
      if (!this.inSnap) {
        this.inSnap = true
        this.snapTransientMs = FRAME_MS
      } else {
        this.snapTransientMs += FRAME_MS
      }
    } else {
      if (this.inSnap) {
        this.inSnap = false
        if (this.snapTransientMs <= SNAP_DURATION_MAX_MS) {
          if (this.lastSnapAt > 0 && now - this.lastSnapAt <= SNAP_WINDOW_MS) {
            this.lastSnapAt = 0
            this.snapTransientMs = 0
            return true
          }
          this.lastSnapAt = now
        }
        this.snapTransientMs = 0
      }
    }

    return false
  }

  private processChunk(chunk: Buffer) {
    const energy = rms(chunk)

    if (this.detectSnap(energy)) {
      console.log('[VAD] 👆 double snap detected')
      this.emit('snapDetected')
      return
    }

    const isSpeech = energy > CONFIG.VAD_THRESHOLD
    const isSilence = energy < CONFIG.VAD_THRESHOLD * 0.6

    this.padBuffer.push(chunk)
    const padFrames = Math.ceil(CONFIG.PRE_SPEECH_PAD_MS / FRAME_MS)
    if (this.padBuffer.length > padFrames) this.padBuffer.shift()

    if (!this.speaking) {
      if (isSpeech) {
        this.speaking = true
        this.silenceMs = 0
        this.speechMs = FRAME_MS
        this.chunkAccumMs = FRAME_MS
        this.chunks = [...this.padBuffer]
        this.emit('speechStart')
      }
    } else {
      this.chunks.push(chunk)
      this.speechMs += FRAME_MS
      this.chunkAccumMs += FRAME_MS

      if (this.chunkAccumMs >= CHUNK_INTERVAL_MS) {
        this.chunkAccumMs = 0
        const partial = Buffer.concat(this.chunks)
        this.emit('speechChunk', partial)
      }

      if (isSilence) {
        this.silenceMs += FRAME_MS
        if (this.silenceMs >= CONFIG.SILENCE_MS) {
          this.speaking = false
          this.silenceMs = 0
          this.chunkAccumMs = 0

          if (this.speechMs < CONFIG.MIN_SPEECH_MS) {
            this.chunks = []
            this.speechMs = 0
            this.emit('misfire')
            return
          }

          const audio = Buffer.concat(this.chunks)
          this.chunks = []
          this.speechMs = 0
          this.emit('speechEnd', audio)
        }
      } else {
        this.silenceMs = 0
      }
    }
  }
}