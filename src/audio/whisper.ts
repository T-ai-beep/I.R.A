import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CONFIG } from '../config.js'

export async function transcribe(audioBuffer: Buffer): Promise<string> {
  const tmpWav = path.join(os.tmpdir(), `aria_${Date.now()}.wav`)

  try {
    // Write raw PCM as WAV
    await writeWav(audioBuffer, tmpWav)

    const t0 = Date.now()

    const text = await new Promise<string>((resolve, reject) => {
      const proc = spawn(CONFIG.WHISPER_CLI, [
        '-m', CONFIG.WHISPER_MODEL,
        '-f', tmpWav,
        '--no-timestamps',
        '-nt',
        '--language', 'en',
      ])

      let out = ''
      proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
      proc.stderr.on('data', () => {}) // suppress

      proc.on('exit', (code) => {
        if (code !== 0) return reject(new Error(`whisper exited ${code}`))
        const clean = out
          .split('\n')
          .filter(l => l.trim() && !l.startsWith('[') && !l.startsWith('whisper') && !l.startsWith('ggml'))
          .join(' ')
          .trim()
        resolve(clean)
      })
    })

    console.log(`[WHISPER] ${Date.now() - t0}ms — "${text}"`)
    return text

  } finally {
    try { fs.unlinkSync(tmpWav) } catch {}
  }
}

function writeWav(pcm: Buffer, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sampleRate = CONFIG.SAMPLE_RATE
    const channels = CONFIG.CHANNELS
    const bitDepth = 16
    const byteRate = sampleRate * channels * bitDepth / 8
    const blockAlign = channels * bitDepth / 8
    const dataSize = pcm.length
    const header = Buffer.alloc(44)

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

    fs.writeFile(outPath, Buffer.concat([header, pcm]), (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}