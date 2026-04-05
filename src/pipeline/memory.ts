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

export function extractOffer(transcript: string): number | null {
  const t = transcript.toLowerCase()

  const nonPriceCtx = /\d+\s*(years?|employees?|people|percent|%|members?|times?|days?|hours?|weeks?|months? ago|years? ago)/i
  if (nonPriceCtx.test(transcript) && !/\$|per month|monthly|annually|a year|pricing|cost|budget|afford|salary|range/i.test(t)) {
    return null
  }

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

  const wordPat = /\b([\d,]+(?:\.\d+)?)\s*(k|thousand|million)\b/i
  const wordMatch = transcript.match(wordPat)
  if (wordMatch) {
    if (/per month|monthly|a month|a year|annually|salary|wage|price|cost|budget|afford|range|expecting|valuation/i.test(t)) {
      const raw = parseFloat(wordMatch[1].replace(/,/g, ''))
      if (!isNaN(raw)) {
        const unit = wordMatch[2].toLowerCase()
        if (unit === 'k' || unit === 'thousand') return raw * 1_000
        if (unit === 'million') return raw * 1_000_000
      }
    }
  }

  const plainPat = /\b([\d,]+(?:\.\d+)?)\s*(?:a month|per month|monthly|a year|per year|annually)\b/i
  const plainMatch = transcript.match(plainPat)
  if (plainMatch) {
    const raw = parseFloat(plainMatch[1].replace(/,/g, ''))
    if (!isNaN(raw) && raw >= 10) return raw
  }

  const rangePat = /(?:range of|expecting|between)\s*\$?\s*([\d,]+)/i
  const rangeMatch = transcript.match(rangePat)
  if (rangeMatch) {
    const raw = parseFloat(rangeMatch[1].replace(/,/g, ''))
    if (!isNaN(raw)) return raw
  }

  return null
}

export function extractIntent(transcript: string): string | null {
  const t = transcript.toLowerCase()

  // PRICE_OBJECTION — standard + adversarial
  if (
    /can't afford|too expensive|too much|no budget|price is|can't spend/i.test(t) ||
    /fifteen hundred.*too|upfront.*too|valuation.*high|switching cost/i.test(t) ||
    /that is a lot\b|that's a lot\b|a lot for.*company|a lot for.*(size|operation)/i.test(t) ||
    /was not expecting that number|wasn't expecting that number/i.test(t) ||
    /sticker shock|feels like a stretch|not sure.*get that value/i.test(t) ||
    /not sure.*would get.*value|fifteen hundred bucks|lot for us man/i.test(t) ||
    /feels like too much/i.test(t)
  ) return 'PRICE_OBJECTION'

  // STALLING — standard + adversarial
  if (
    /need to think|get back|not sure|maybe|not ready/i.test(t) ||
    /circle back|be in touch|will be in touch/i.test(t) ||
    /sounds interesting.*we will|this is interesting.*we will/i.test(t)
  ) return 'STALLING'

  // AUTHORITY — standard + adversarial
  if (
    /check with|my team|my boss|need approval|not my call|run it by/i.test(t) ||
    /my wife|my husband|she handles|he handles/i.test(t) ||
    /my business partner|my partner.*weigh|partner.*weigh in/i.test(t) ||
    /our team would need to align|team.*align on/i.test(t)
  ) return 'AUTHORITY'

  // COMPETITOR — standard + adversarial
  if (
    /already use|currently use|we have|service.?titan|jobber|housecall/i.test(t) ||
    /competitor|went with|chose.*instead/i.test(t) ||
    /signed with|signed the paperwork|already signed/i.test(t) ||
    /happy with.*current/i.test(t)
  ) return 'COMPETITOR'

  // AGREEMENT
  if (
    /let's do it|sounds good|we're in|i'll take it|deal|move forward/i.test(t) ||
    /i'm in\b|when do we start|ready to sign|close this week/i.test(t) ||
    /could really work for us|this could really work/i.test(t) ||
    /yeah.*i am in|get started/i.test(t)
  ) return 'AGREEMENT'

  if (/\?$/.test(t.trim())) return 'QUESTION'

  if (/\$|per month|a year|annually|pricing|cost|budget|range of|salary|compensation/i.test(t)) return 'OFFER_DISCUSS'

  if (/deadline|by friday|by monday|end of week|next week|asap/i.test(t)) return 'DEADLINE'

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