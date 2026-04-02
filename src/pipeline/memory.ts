const MEMORY_TTL_MS = 30000
const MAX_TURNS = 20

export interface Turn {
  transcript: string
  timestamp: number
  intent: string | null
  offer: number | null
  speaker: 'user' | 'other' | 'unknown'
}

interface MemoryState {
  turns: Turn[]
  lastOffer: number | null
  lastIntent: string | null
  lastSpeaker: Turn['speaker']
}

const state: MemoryState = {
  turns: [],
  lastOffer: null,
  lastIntent: null,
  lastSpeaker: 'unknown',
}

function extractOffer(transcript: string): number | null {
  // requires $ sign or explicit price unit — avoids catching random numbers
  const match = transcript.match(/\$\s*([\d,]+)(\s*(k|thousand|million))?/i)
    ?? transcript.match(/\b([\d,]+)\s*(k|thousand|million)?\s*(a month|per month|monthly|a year|annually)\b/i)

  if (!match) return null

  const raw = match[1].replace(/,/g, '')
  const val = parseFloat(raw)
  if (isNaN(val)) return null

  const unit = (match[3] ?? match[2] ?? '').toLowerCase()
  if (unit === 'k' || unit === 'thousand') return val * 1000
  if (unit === 'million') return val * 1_000_000
  return val
}

function extractIntent(transcript: string): string | null {
  const t = transcript.toLowerCase()
  if (/can't afford|too expensive|too much|no budget|price is/.test(t)) return 'PRICE_OBJECTION'
  if (/need to think|get back|not sure|maybe/.test(t)) return 'STALLING'
  if (/check with|my team|my boss|need approval|not my call/.test(t)) return 'AUTHORITY'
  if (/already use|currently use|we have|service.?titan|competitor/.test(t)) return 'COMPETITOR'
  if (/let's do it|sounds good|we're in|i'll take it|deal/.test(t)) return 'AGREEMENT'
  if (/\?$/.test(t.trim())) return 'QUESTION'
  if (/\$|per month|a year|annually|pricing|cost|budget/.test(t)) return 'OFFER_DISCUSS'
  if (/deadline|by (friday|monday|end of|next week)/.test(t)) return 'DEADLINE'
  return null
}

function extractSpeaker(transcript: string): Turn['speaker'] {
  const t = transcript.toLowerCase()
  if (/we can|our (product|service|platform)|let me|i can show|we offer/.test(t)) return 'user'
  if (/you guys|your product|your service|do you|can you/.test(t)) return 'other'
  return 'unknown'
}

function purgeExpired() {
  const now = Date.now()
  state.turns = state.turns.filter(t => now - t.timestamp < MEMORY_TTL_MS)
}

export function remember(transcript: string): Turn {
  purgeExpired()

  const turn: Turn = {
    transcript,
    timestamp: Date.now(),
    intent: extractIntent(transcript),
    offer: extractOffer(transcript),
    speaker: extractSpeaker(transcript),
  }

  state.turns.push(turn)
  if (state.turns.length > MAX_TURNS) state.turns.shift()

  if (turn.offer !== null) state.lastOffer = turn.offer
  if (turn.intent !== null) state.lastIntent = turn.intent
  if (turn.speaker !== 'unknown') state.lastSpeaker = turn.speaker

  console.log(`[MEM] intent=${turn.intent ?? 'none'} offer=${turn.offer ?? 'none'} speaker=${turn.speaker}`)

  return turn
}

export function getContext(): MemoryState {
  purgeExpired()
  return { ...state }
}

export function getRecentTranscripts(n = 5): string[] {
  purgeExpired()
  return state.turns.slice(-n).map(t => t.transcript)
}

export function clearMemory() {
  state.turns = []
  state.lastOffer = null
  state.lastIntent = null
  state.lastSpeaker = 'unknown'
}