import { spawn } from 'child_process'
import * as path from 'path'
import { CONFIG } from '../config.js'

const SCRIPT = path.join(process.cwd(), 'scripts', 'tts.py')

let proc: ReturnType<typeof spawn> | null = null

function getProc() {
  if (proc && !proc.killed) return proc
  proc = spawn(CONFIG.VENV_PYTHON, [SCRIPT])
  proc.stderr?.on('data', (d: Buffer) => console.error('[TTS]', d.toString().trim()))
  proc.on('exit', () => { proc = null })
  return proc
}

export function speak(text: string): void {
  const t0 = Date.now()
  const p = getProc()
  p.stdin?.write(JSON.stringify({ text }) + '\n')
  console.log(`[TTS] ${Date.now() - t0}ms queued — "${text}"`)
}

// warm it up immediately
getProc()