import { CONFIG } from '../config.js'
import { matchEmbedding } from './embeddings.js'
import { matchRule } from './rules.js'
import { remember, getContext } from './memory.js'

export type Mode = 'negotiation' | 'meeting' | 'interview' | 'social'

export type EventType =
  | 'PRICE_OBJECTION'
  | 'STALLING'
  | 'AUTHORITY'
  | 'COMPETITOR'
  | 'AGREEMENT'
  | 'QUESTION'
  | 'OFFER_DISCUSS'
  | 'DEADLINE'
  | 'UNKNOWN'

let currentMode: Mode = 'negotiation'

export function setMode(mode: Mode): void {
  currentMode = mode
  console.log(`[MODE] ${mode}`)
}

export function getMode(): Mode {
  return currentMode
}

function classifyEvent(transcript: string): EventType {
  const t = transcript.toLowerCase()
  if (/can't afford|too expensive|too much|no budget|price is|can't spend/.test(t)) return 'PRICE_OBJECTION'
  if (/need to think|get back|not sure|maybe|not ready/.test(t)) return 'STALLING'
  if (/check with|my team|my boss|need approval|not my call|run it by/.test(t)) return 'AUTHORITY'
  if (/already use|currently use|we have|service.?titan|competitor/.test(t)) return 'COMPETITOR'
  if (/sounds good|we're in|let's do it|i'll take|deal|move forward/.test(t)) return 'AGREEMENT'
  if (/\?$/.test(t.trim())) return 'QUESTION'
  if (/\$|per month|a year|pricing|cost|budget/.test(t)) return 'OFFER_DISCUSS'
  if (/deadline|by friday|by monday|end of week|next week|asap/.test(t)) return 'DEADLINE'
  return 'UNKNOWN'
}

const HIGH_IMPACT: EventType[] = ['PRICE_OBJECTION', 'AUTHORITY', 'COMPETITOR', 'AGREEMENT']

function isHighImpact(event: EventType): boolean {
  return HIGH_IMPACT.includes(event)
}

const TIGHT_PROMPT = `You are ARIA, a real-time decision coach.
Output exactly one line: ACTION — phrase
ACTION must be one of: Reject Accept Ask Push Wait Challenge Clarify Delay Anchor Exit
phrase is 2 words max.
If nothing actionable: PASS
No explanation. No punctuation. No quotes.`

async function llmFallback(transcript: string, event: EventType): Promise<string | null> {
  const ctx = getContext()
  const contextLine = ctx.lastOffer
    ? `Last offer: $${ctx.lastOffer}. Last intent: ${ctx.lastIntent}.`
    : ''

  const res = await fetch(CONFIG.OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CONFIG.OLLAMA_MODEL,
      messages: [
        { role: 'system', content: TIGHT_PROMPT },
        { role: 'user', content: `${contextLine}\nEvent: ${event}\nTranscript: "${transcript}"` },
      ],
      stream: false,
    }),
  })

  const data = await res.json() as { message: { content: string } }
  const raw = data.message.content.trim().replace(/['"`.]/g, '').trim()

  if (!raw || raw.toUpperCase() === 'PASS') return null

  const actions = ['Reject', 'Accept', 'Ask', 'Push', 'Wait', 'Challenge', 'Clarify', 'Delay', 'Anchor', 'Exit']
  if (!actions.some(a => raw.startsWith(a))) return null

  return raw.split(/\s+/).slice(0, 4).join(' ')
}

export async function decide(transcript: string): Promise<string | null> {
  const t0 = Date.now()

  // store in memory
  remember(transcript)
  const event = classifyEvent(transcript)
  console.log(`[EVENT] ${event}`)

  // 1. rules — 0ms, exact patterns
  const ruleHit = matchRule(transcript, currentMode)
  if (ruleHit) {
    console.log(`[RULE] ${Date.now() - t0}ms — "${ruleHit}"`)
    return ruleHit
  }

  // 2. embeddings — ~5ms, semantic matching
  const embedMatch = await matchEmbedding(transcript)
  if (embedMatch) {
    console.log(`[EMBED] ${Date.now() - t0}ms — "${embedMatch.action}" @ ${embedMatch.score.toFixed(3)}`)
    return embedMatch.action
  }

  // 3. LLM — only for high impact events rules + embeddings missed
  if (isHighImpact(event)) {
    console.log(`[LLM] fallback for ${event}`)
    const llmResult = await llmFallback(transcript, event)
    console.log(`[LLM] ${Date.now() - t0}ms — "${llmResult ?? 'PASS'}"`)
    return llmResult
  }

  console.log(`[PASS] ${Date.now() - t0}ms`)
  return null
}