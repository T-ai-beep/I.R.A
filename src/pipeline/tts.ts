/**
 * tts.ts — TypeScript wrapper for the Python TTS worker
 *
 * OPT-5: Pre-warm on module import.
 * getProc() is called immediately when the module loads, which:
 *   1. Spawns the Python process
 *   2. Python opens the sounddevice OutputStream
 *   3. Python synthesises a silent pre-warm phrase to load Kokoro weights
 *
 * By the time the first real speak() call arrives, the OutputStream is
 * already open and Kokoro weights are paged into RAM. First audio latency
 * is warm, not cold.
 */

import { spawn } from 'child_process'
import * as path from 'path'
import { CONFIG } from '../config.js'

const SCRIPT = path.join(process.cwd(), 'scripts', 'tts.py')

let proc: ReturnType<typeof spawn> | null = null

function getProc() {
  if (proc && !proc.killed) return proc

  proc = spawn(CONFIG.VENV_PYTHON, [SCRIPT])

  proc.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim()
    // Only log non-noise messages
    if (msg && !msg.startsWith('UserWarning') && !msg.startsWith('torch')) {
      console.error('[TTS]', msg)
    }
  })

  proc.stdout?.on('data', (d: Buffer) => {
    // Forward TTS process stdout logs (TTFC timing etc)
    const msg = d.toString().trim()
    if (msg) console.log(msg)
  })

  proc.on('exit', (code) => {
    console.log(`[TTS] process exited (code=${code})`)
    proc = null
  })

  return proc
}

/**
 * speak() — enqueue text for TTS synthesis and playback.
 *
 * Fire-and-forget: returns immediately after writing to the worker's stdin.
 * The Python worker synthesises and plays in a background queue thread.
 *
 * Chunking is handled on the Python side (≤4 words per Kokoro call).
 * The TypeScript side can also pass pre-chunked text (3-word LLM streaming
 * chunks) — Python will re-chunk if needed but typically they arrive
 * already short enough to pass through as single chunks.
 */
export function speak(text: string): void {
  if (!text || !text.trim()) return

  const t0 = Date.now()
  const p  = getProc()

  const payload = JSON.stringify({ text: text.trim() }) + '\n'
  p.stdin?.write(payload)

  console.log(`[TTS] ${Date.now() - t0}ms queued — "${text.slice(0, 60)}"`)
}

// ── OPT-5: Pre-warm immediately on module load ────────────────────────────
// Spawns the Python process and triggers Kokoro weight loading.
// By the time the pipeline processes its first transcript, TTS is warm.
getProc()