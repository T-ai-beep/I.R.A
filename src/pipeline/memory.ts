const MEMORY_TTL_MS = 600_000  // 10 min
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

// ── Offer extraction — handles all formats ─────────────────────────────────
// Formats handled:
//   $5,000 / $5000 / $5k / 5 thousand / 5k / $1.5 million
//   $150 per month / 150 a month / 5,000 monthly
// Excluded:
//   "15 employees" / "15 years" / "40 percent" (context guards)

export function extractOffer(transcript: string): number | null {
  const t = transcript.toLowerCase()

  // Guard: skip if the number is clearly NOT a price
  // "15 years", "15 employees", "40 percent" etc.
  const nonPriceCtx = /\d+\s*(years?|employees?|people|percent|%|members?|times?|days?|hours?|weeks?|months? ago|years? ago)/i
  if (nonPriceCtx.test(transcript) && !/\$|per month|monthly|annually|a year|pricing|cost|budget|afford|salary|range/i.test(t)) {
    return null
  }

  // Pattern 1: $X[.Y][k|thousand|million] [optional: per month/monthly/etc]
  const dollarPat = /\$\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|million|m\b)?/i
  const dollarMatch = transcript.match(dollarPat)
  if (dollarMatch) {
    const raw = parseFloat(dollarMatch[1].replace(/,/g, ''))
    if (!isNaN(raw)) {
      const unit = (dollarMatch[2] ?? '').toLowerCase()
      if (unit === 'k' || unit === 'thousand') return raw * 1_000
      if (unit === 'million' || unit === 'm') return raw * 1_000_000
      return raw
    }
  }

  // Pattern 2: X[.Y] k/thousand/million [per month/annually/etc or price context]
  const wordPat = /\b([\d,]+(?:\.\d+)?)\s*(k|thousand|million)\b/i
  const wordMatch = transcript.match(wordPat)
  if (wordMatch) {
    // Only if there's price context
    if (/per month|monthly|a month|a year|annually|salary|wage|price|cost|budget|afford|range|expecting|valuation/i.test(t)) {
      const raw = parseFloat(wordMatch[1].replace(/,/g, ''))
      if (!isNaN(raw)) {
        const unit = wordMatch[2].toLowerCase()
        if (unit === 'k' || unit === 'thousand') return raw * 1_000
        if (unit === 'million') return raw * 1_000_000
      }
    }
  }

  // Pattern 3: plain number with per-month / annually context
  const plainPat = /\b([\d,]+(?:\.\d+)?)\s*(?:a month|per month|monthly|a year|per year|annually)\b/i
  const plainMatch = transcript.match(plainPat)
  if (plainMatch) {
    const raw = parseFloat(plainMatch[1].replace(/,/g, ''))
    if (!isNaN(raw) && raw >= 10) return raw  // skip tiny numbers like "1 a month"
  }

  // Pattern 4: salary/range context with bare number
  const rangePat = /(?:range of|expecting|between)\s*\$?\s*([\d,]+)/i
  const rangeMatch = transcript.match(rangePat)
  if (rangeMatch) {
    const raw = parseFloat(rangeMatch[1].replace(/,/g, ''))
    if (!isNaN(raw)) return raw
  }

  return null
}

// ── Intent extraction ──────────────────────────────────────────────────────

export function extractIntent(transcript: string): string | null {
  const t = transcript.toLowerCase()

  // Order matters — check most specific first
  if (/can't afford|too expensive|too much|no budget|price is|can't spend|fifteen hundred.*too|upfront.*too|valuation.*high|switching cost|sticker shock|not sure.*value|not get.*value/.test(t)) return 'PRICE_OBJECTION'
  if (/need to think|get back|not sure|maybe|not ready|circle back|be in touch|let us know/.test(t)) return 'STALLING'
  if (/check with|my team|my boss|need approval|not my call|run it by|my wife|my husband|my partner|she handles|he handles/.test(t)) return 'AUTHORITY'
  if (/already use|currently use|we have|service.?titan|jobber|housecall|competitor|signed with|went with|chose.*instead/.test(t)) return 'COMPETITOR'
  if (/let's do it|sounds good|we're in|i'll take it|deal|move forward|i'm in|ready to sign|when do we start|could really work|get started/.test(t)) return 'AGREEMENT'
  if (/\?$/.test(t.trim())) return 'QUESTION'
  if (/\$|per month|a year|annually|pricing|cost|budget|range of|salary|compensation/.test(t)) return 'OFFER_DISCUSS'
  if (/deadline|by friday|by monday|end of week|next week|asap/.test(t)) return 'DEADLINE'
  return null
}

// ── Speaker extraction ─────────────────────────────────────────────────────

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

export function getLastTurn(): Turn | null {
  purgeExpired()
  return state.turns[state.turns.length - 1] ?? null
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