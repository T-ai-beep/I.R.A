import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { CONFIG } from '../config.js'

const FRAME_MS = 30
const FRAME_SAMPLES = Math.floor(CONFIG.SAMPLE_RATE * FRAME_MS / 1000)

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
  private sox: ReturnType<typeof spawn> | null = null

  start() {
    this.sox = spawn('sox', [
      '-d',                          // default mic
      '-r', String(CONFIG.SAMPLE_RATE),
      '-c', String(CONFIG.CHANNELS),
      '-e', 'signed-integer',
      '-b', '16',
      '-t', 'raw',
      '-',                           // pipe to stdout
    ])

    this.sox.stderr?.on('data', () => {}) // suppress sox logs

    this.sox.stdout?.on('data', (chunk: Buffer) => {
      this.processChunk(chunk)
    })

    this.sox.on('exit', (code) => {
      if (code !== 0) this.emit('error', new Error(`sox exited ${code}`))
    })

    console.log('[VAD] listening...')
  }

  stop() {
    this.sox?.kill()
    this.sox = null
  }

  private processChunk(chunk: Buffer) {
    const energy = rms(chunk)
    const isSpeech = energy > CONFIG.VAD_THRESHOLD
    const isSilence = energy < CONFIG.VAD_THRESHOLD * 0.6

    // keep a rolling pad buffer
    this.padBuffer.push(chunk)
    const padFrames = Math.ceil(CONFIG.PRE_SPEECH_PAD_MS / FRAME_MS)
    if (this.padBuffer.length > padFrames) this.padBuffer.shift()

    if (!this.speaking) {
      if (isSpeech) {
        this.speaking = true
        this.silenceMs = 0
        this.speechMs = FRAME_MS
        this.chunks = [...this.padBuffer]
        this.emit('speechStart')
      }
    } else {
      this.chunks.push(chunk)
      this.speechMs += FRAME_MS

      if (isSilence) {
        this.silenceMs += FRAME_MS
        if (this.silenceMs >= CONFIG.SILENCE_MS) {
          this.speaking = false
          this.silenceMs = 0

          if (this.speechMs < CONFIG.MIN_SPEECH_MS) {
            this.chunks = []
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