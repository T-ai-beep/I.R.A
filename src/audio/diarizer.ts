/**
 * diarizer.ts — TypeScript wrapper for diarizer.py
 *
 * Spawns the Python diarization process and exposes a simple async API.
 * Used by VAD to tag each audio chunk with speaker identity before
 * passing to the decision pipeline.
 *
 * Speaker labels:
 *   'self'    — Tanay speaking (ARIA should NOT fire)
 *   'other'   — other person speaking (ARIA should fire if signal detected)
 *   'unknown' — couldn't determine (treat as 'other' to avoid missing signals)
 *
 * Usage:
 *   import { getDiarizer } from './diarizer.js'
 *   const d = getDiarizer()
 *   const result = await d.identify(audioBuffer)
 *   if (result.speaker !== 'self') { ... }
 */

import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { CONFIG } from '../config.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)
const SCRIPT     = path.resolve(__dirname, '..', '..', 'src', 'audio', 'diarizer.py')

export type SpeakerLabel = 'self' | 'other' | 'unknown'

export interface DiarizationResult {
  speaker:    SpeakerLabel
  confidence: number
  reason?:    string
}

export interface DiarizerStatus {
  enrolled:             boolean
  profile_exists:       boolean
  enroll_progress_pct:  number
}

// ── Pending request queue ──────────────────────────────────────────────────
// Each request is a resolve/reject pair waiting for the next stdout line.

interface PendingRequest {
  resolve: (result: DiarizationResult) => void
  reject:  (err: Error) => void
  timeout: NodeJS.Timeout
}

class Diarizer {
  private proc:    ChildProcess | null = null
  private queue:   PendingRequest[]    = []
  private buffer:  string              = ''
  private ready:   boolean             = false
  private enabled: boolean             = true

  constructor() {
    if (process.env.NODE_ENV === 'test' || process.env.NO_DIARIZER === '1') {
      this.enabled = false
      console.log('[DIARIZER] disabled (test/env)')
      return
    }
    this.spawn()
  }

  private spawn() {
    try {
      this.proc = spawn(CONFIG.VENV_PYTHON, [SCRIPT])

      this.proc.stdout?.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString()
        const lines = this.buffer.split('\n')
        this.buffer  = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          // Ready signal
          if (trimmed === '[DIARIZER] ready') {
            this.ready = true
            console.log('[DIARIZER] ready')
            continue
          }

          // Try to parse as JSON result
          try {
            const parsed = JSON.parse(trimmed)
            const pending = this.queue.shift()
            if (pending) {
              clearTimeout(pending.timeout)
              pending.resolve(parsed as DiarizationResult)
            }
          } catch {
            // Log line (status/progress messages)
            console.log(trimmed)
          }
        }
      })

      this.proc.stderr?.on('data', (d: Buffer) => {
        const msg = d.toString().trim()
        if (msg && !msg.startsWith('UserWarning') && !msg.startsWith('torch')) {
          console.error('[DIARIZER]', msg)
        }
      })

      this.proc.on('exit', (code) => {
        console.log(`[DIARIZER] process exited (code=${code})`)
        this.proc  = null
        this.ready = false
        // Drain pending with unknown
        for (const p of this.queue) {
          clearTimeout(p.timeout)
          p.resolve({ speaker: 'unknown', confidence: 0, reason: 'process_exited' })
        }
        this.queue = []
        // Respawn after 2s
        setTimeout(() => this.spawn(), 2000)
      })

      console.log('[DIARIZER] spawned')
    } catch (e) {
      console.error('[DIARIZER] failed to spawn:', e)
      this.enabled = false
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async identify(audio: Buffer, timeoutMs = 800): Promise<DiarizationResult> {
    if (!this.enabled || !this.proc) {
      return { speaker: 'unknown', confidence: 0, reason: 'disabled' }
    }

    const audio_b64 = audio.toString('base64')
    const payload   = JSON.stringify({ audio_b64 }) + '\n'

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove from queue
        this.queue = this.queue.filter(p => p.resolve !== resolve)
        // Default to 'other' on timeout so we don't miss signals
        resolve({ speaker: 'other', confidence: 0.5, reason: 'timeout' })
      }, timeoutMs)

      this.queue.push({ resolve, reject, timeout })

      try {
        this.proc?.stdin?.write(payload)
      } catch (e) {
        clearTimeout(timeout)
        this.queue = this.queue.filter(p => p.resolve !== resolve)
        resolve({ speaker: 'unknown', confidence: 0, reason: 'write_error' })
      }
    })
  }

  async reenroll(): Promise<void> {
    if (!this.proc) return
    this.proc.stdin?.write(JSON.stringify({ cmd: 'reenroll' }) + '\n')
    console.log('[DIARIZER] re-enrollment triggered')
  }

  async getStatus(): Promise<DiarizerStatus | null> {
    if (!this.proc) return null

    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 1000)

      // Status response comes back as a JSON line too — intercept next
      const originalResolve = (result: DiarizationResult) => {
        clearTimeout(timeout)
        resolve(result as unknown as DiarizerStatus)
      }

      this.queue.push({ resolve: originalResolve, reject: () => resolve(null), timeout })
      this.proc?.stdin?.write(JSON.stringify({ cmd: 'status' }) + '\n')
    })
  }

  isReady(): boolean {
    return this.ready && this.enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _instance: Diarizer | null = null

export function getDiarizer(): Diarizer {
  if (!_instance) _instance = new Diarizer()
  return _instance
}

// Pre-warm on module load
getDiarizer()