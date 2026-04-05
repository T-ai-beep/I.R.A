/**
 * adaptiveWeights.ts
 * Learns which actions work.
 * weight += 0.1 on success/followed
 * weight -= 0.2 on ignored/lost
 * Biases actionSelector scoring over time.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const ARIA_DIR  = path.join(os.homedir(), '.aria')
const WEIGHTS_FILE = path.join(ARIA_DIR, 'weights.json')

type WeightMap = Record<string, number>

const MIN_WEIGHT = 0.1
const MAX_WEIGHT = 2.0

function ensureDir() {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
}

export function loadWeights(): WeightMap {
  ensureDir()
  if (!fs.existsSync(WEIGHTS_FILE)) return {}
  try {
    return JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf-8')) as WeightMap
  } catch { return {} }
}

function saveWeights(w: WeightMap) {
  ensureDir()
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(w, null, 2))
}

function key(message: string): string {
  return message.toLowerCase().replace(/\s+/g, '_')
}

export function recordSuccess(message: string): void {
  const w = loadWeights()
  const k = key(message)
  const current = w[k] ?? 1.0
  w[k] = Math.min(MAX_WEIGHT, parseFloat((current + 0.1).toFixed(3)))
  saveWeights(w)
  console.log(`[WEIGHTS] ↑ "${message}" → ${w[k]}`)
}

export function recordIgnored(message: string): void {
  const w = loadWeights()
  const k = key(message)
  const current = w[k] ?? 1.0
  w[k] = Math.max(MIN_WEIGHT, parseFloat((current - 0.2).toFixed(3)))
  saveWeights(w)
  console.log(`[WEIGHTS] ↓ "${message}" → ${w[k]}`)
}

export function recordLost(message: string): void {
  // losing is worse than ignoring
  const w = loadWeights()
  const k = key(message)
  const current = w[k] ?? 1.0
  w[k] = Math.max(MIN_WEIGHT, parseFloat((current - 0.3).toFixed(3)))
  saveWeights(w)
  console.log(`[WEIGHTS] ↓↓ "${message}" → ${w[k]}`)
}

export function getWeightSummary(): string {
  const w = loadWeights()
  const entries = Object.entries(w).sort((a, b) => b[1] - a[1])
  if (!entries.length) return 'No weight data yet.'
  const top = entries.slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(', ')
  const bot = entries.slice(-3).map(([k, v]) => `${k}: ${v}`).join(', ')
  return `Top: ${top} | Bottom: ${bot}`
}