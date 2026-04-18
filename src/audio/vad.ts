/**
 * vad.ts — Voice Activity Detection with speaker diarization
 *
 * Changes from original:
 *   1. Each completed speech segment is tagged with speaker identity
 *      via diarizer.ts before emitting 'speechEnd'
 *   2. Emits 'speechEnd' with { audio, speaker, confidence } instead of
 *      just audio — callers check speaker before running decision pipeline
 *   3. Session manager is notified on every turn
 *   4. 'selfSpeech' event emitted when Tanay is speaking (for HUD indicator)
 *   5. Double-snap still activates ARIA regardless of speaker
 *   6. Wake word mode: when diarizer is not enrolled yet, defaults to
 *      original behavior (treat everything as 'other')
 */

import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { CONFIG } from '../config.js'
import { getDiarizer, SpeakerLabel } from "../audio/diarizer.js"
import { getSessionManager } from "../pipeline/session.js"

const FRAME_MS = 30
const CHUNK_INTERVAL_MS = 2000

const SNAP_ENERGY_THRESHOLD = 0.08
const SNAP_DURATION_MAX_MS  = 150
const SNAP_WINDOW_MS        = 600

function rms(buf: Buffer): number {
  let sum = 0
  for (let i = 0; i < buf.length; i += 2) {
    const s = buf.readInt16LE(i) / 32768
    sum += s * s
  }
  return Math.sqrt(sum / (buf.length / 2))
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface SpeechEndPayload {
  audio:      Buffer
  speaker:    SpeakerLabel
  confidence: number
}

export interface SpeechChunkPayload {
  audio:   Buffer
  speaker: SpeakerLabel   // best guess at chunk time (may update at speechEnd)
}

// ── VAD ────────────────────────────────────────────────────────────────────

export class VAD extends EventEmitter {
  private speaking      = false
  private silenceMs     = 0
  private speechMs      = 0
  private chunks:       Buffer[] = []
  private padBuffer:    Buffer[] = []
  private chunkAccumMs  = 0
  private sox:          ReturnType<typeof spawn> | null = null

  // Snap detection
  private lastSnapAt        = 0
  private snapTransientMs   = 0
  private inSnap            = false

  // Diarization state
  private diarizer          = getDiarizer()
  private sessionMgr        = getSessionManager()

  // Rolling speaker estimate for the current utterance
  // We accumulate votes across chunks and resolve at speechEnd
  private speakerVotes: Record<SpeakerLabel, number> = { self: 0, other: 0, unknown: 0 }
  private speakerConfSum = 0
  private speakerVoteCount = 0

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
    console.log(`[VAD] diarizer ${this.diarizer.isEnabled() ? 'enabled' : 'disabled'}`)
  }

  stop() {
    this.sox?.kill()
    this.sox = null
  }

  // ── Snap detection (unchanged) ───────────────────────────────────────────

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

  // ── Main audio processing ─────────────────────────────────────────────────

  private processChunk(chunk: Buffer) {
    const energy = rms(chunk)

    if (this.detectSnap(energy)) {
      console.log('[VAD] 👆 double snap detected')
      this.emit('snapDetected')
      return
    }

    const isSpeech  = energy > CONFIG.VAD_THRESHOLD
    const isSilence = energy < CONFIG.VAD_THRESHOLD * 0.6

    this.padBuffer.push(chunk)
    const padFrames = Math.ceil(CONFIG.PRE_SPEECH_PAD_MS / FRAME_MS)
    if (this.padBuffer.length > padFrames) this.padBuffer.shift()

    if (!this.speaking) {
      if (isSpeech) {
        this.speaking        = true
        this.silenceMs       = 0
        this.speechMs        = FRAME_MS
        this.chunkAccumMs    = FRAME_MS
        this.chunks          = [...this.padBuffer]
        this.speakerVotes    = { self: 0, other: 0, unknown: 0 }
        this.speakerConfSum  = 0
        this.speakerVoteCount = 0
        this.emit('speechStart')
      }
    } else {
      this.chunks.push(chunk)
      this.speechMs     += FRAME_MS
      this.chunkAccumMs += FRAME_MS

      // Emit intermediate chunk for streaming STT (no diarization — too short)
      if (this.chunkAccumMs >= CHUNK_INTERVAL_MS) {
        this.chunkAccumMs = 0
        const partial = Buffer.concat(this.chunks)
        // For chunks, use current best-guess speaker
        const chunkSpeaker = this.resolveSpeaker()
        this.emit('speechChunk', { audio: partial, speaker: chunkSpeaker } as SpeechChunkPayload)
      }

      if (isSilence) {
        this.silenceMs += FRAME_MS
        if (this.silenceMs >= CONFIG.SILENCE_MS) {
          this.speaking     = false
          this.silenceMs    = 0
          this.chunkAccumMs = 0

          if (this.speechMs < CONFIG.MIN_SPEECH_MS) {
            this.chunks   = []
            this.speechMs = 0
            this.emit('misfire')
            return
          }

          const audio = Buffer.concat(this.chunks)
          this.chunks   = []
          const speechDuration = this.speechMs
          this.speechMs = 0

          // Diarize the completed utterance
          this.handleSpeechEnd(audio, speechDuration)
        }
      } else {
        this.silenceMs = 0
      }
    }
  }

  // ── Diarization on speech end ─────────────────────────────────────────────

  private async handleSpeechEnd(audio: Buffer, speechMs: number): Promise<void> {
    let speaker:    SpeakerLabel = 'other'
    let confidence: number       = 0.5

    if (this.diarizer.isEnabled()) {
      try {
        const result = await this.diarizer.identify(audio)
        speaker    = result.speaker
        confidence = result.confidence

        // Accumulate vote for this utterance
        this.speakerVotes[speaker]++
        this.speakerConfSum   += confidence
        this.speakerVoteCount++

        console.log(`[VAD] speaker=${speaker} conf=${confidence.toFixed(2)} reason=${result.reason ?? ''}`)
      } catch (e) {
        console.error('[VAD] diarization error:', e)
        speaker = 'other'  // safe default
      }
    }

    // Notify session manager
    // (session manager gets the transcript later from index.ts — here we just
    //  log the raw speech event for session timing purposes)
    if (speaker !== 'self') {
      // Only notify session for "other" speech — we track conversation turns
      // self-speech just keeps the session alive (handled via silence timer reset)
      this.sessionMgr.onSpeech('', speaker, null, null)
    }

    if (speaker === 'self') {
      // Don't run the decision pipeline on our own speech
      // Just emit selfSpeech so the HUD can show a mic indicator
      this.emit('selfSpeech', { audio, speechMs })
      console.log(`[VAD] self-speech detected (${speechMs}ms) — skipping pipeline`)
      return
    }

    // Emit to decision pipeline
    this.emit('speechEnd', { audio, speaker, confidence } as SpeechEndPayload)
  }

  // ── Speaker resolution helpers ────────────────────────────────────────────

  private resolveSpeaker(): SpeakerLabel {
    if (this.speakerVoteCount === 0) return 'other'
    const { self, other, unknown } = this.speakerVotes
    if (self > other && self > unknown) return 'self'
    if (other > self && other > unknown) return 'other'
    return 'unknown'
  }

  // ── Re-enrollment trigger ────────────────────────────────────────────────
  // Call this to re-enroll voice profile (e.g. from ARIA command "re-enroll my voice")

  async reenrollVoice(): Promise<void> {
    await this.diarizer.reenroll()
  }

  async getDiarizerStatus() {
    return this.diarizer.getStatus()
  }
}