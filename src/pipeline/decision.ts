import { CONFIG } from '../config.js'
import { matchEmbedding } from './embeddings.js'
import { matchRule } from './rules.js'
import { remember, getContext } from './memory.js'
import { extractTaskFromTranscript, addTask, getTaskContext } from './tasks.js'
import { updatePeopleFromTranscript, getPeopleContext } from './people.js'
import { detectFollowUp, createFollowUp, getFollowUpContext } from './followup.js'
import { logDecision, getPatternContext } from './decisionLog.js'
import { selectBestAction, ActionCandidate, BestAction } from './actionSelector.js'
import { recordSuccess, recordIgnored } from './adaptiveWeights.js'
import { steer, getTrajectoryContext } from './steering.js'
import { storeEpisode, getEpisodicContext } from "../pipeline/epsodic.js"
import { getIdentityContext, getHighImportancePeople } from './identityScore.js'
import { createPressureItem } from './pressure.js'

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

const HIGH_IMPACT: EventType[] = [
  'PRICE_OBJECTION', 'AUTHORITY', 'COMPETITOR', 'AGREEMENT', 'QUESTION', 'OFFER_DISCUSS'
]

function isHighImpact(event: EventType): boolean {
  return HIGH_IMPACT.includes(event)
}

const TIGHT_PROMPT = `You are ARIA, a real-time decision coach.
Output exactly one line: ACTION — phrase
ACTION must be one of: Reject Accept Ask Push Wait Challenge Clarify Delay Anchor Exit
phrase is 2 words max.
If nothing actionable: PASS
No explanation. No punctuation. No quotes.`

// ── LLM fallback — with hard latency cap ─────────────────────────────────

async function llmFallback(
  transcript: string,
  event: EventType,
  deadline: number
): Promise<string | null> {
  const ctx = getContext()
  const contextLine = ctx.lastOffer
    ? `Last offer: $${ctx.lastOffer}. Last intent: ${ctx.lastIntent}.`
    : ''

  const taskCtx    = getTaskContext()
  const followUpCtx = getFollowUpContext()
  const patternCtx  = getPatternContext()
  const extraCtx    = [taskCtx, followUpCtx, patternCtx].filter(Boolean).join('\n')

  const remaining = deadline - Date.now()
  if (remaining <= 50) {
    console.log('[LLM] skipped — latency budget exhausted')
    return null
  }

  try {
    const res = await fetch(CONFIG.OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        messages: [
          { role: 'system', content: TIGHT_PROMPT },
          {
            role: 'user',
            content: `${contextLine}${extraCtx ? '\n' + extraCtx : ''}\nEvent: ${event}\nTranscript: "${transcript}"`,
          },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(remaining),
    })

    const data = await res.json() as { message: { content: string } }
    const raw = data.message.content.trim().replace(/['"`.]/g, '').trim()

    if (!raw || raw.toUpperCase() === 'PASS') return null

    const actions = ['Reject','Accept','Ask','Push','Wait','Challenge','Clarify','Delay','Anchor','Exit']
    if (!actions.some(a => raw.startsWith(a))) return null

    return raw.split(/\s+/).slice(0, 4).join(' ')
  } catch {
    console.log('[LLM] timed out — rules-only fallback')
    return null
  }
}

// ── Side effects ───────────────────────────────────────────────────────────

function processSideEffects(
  transcript: string,
  intent: string | null,
  offer: number | null,
  person: string | null
): void {
  // people
  updatePeopleFromTranscript(transcript, intent, offer)

  // follow-up
  const fuDetected = detectFollowUp(transcript)
  if (fuDetected) {
    const pCtx = getPeopleContext(transcript)
    createFollowUp(transcript, fuDetected, pCtx ?? undefined)
      .then(fu => {
        // register in pressure system
        createPressureItem(
          fu.id, 'followup', fu.suggestedAction,
          fu.person, fu.priority, fuDetected.delayHours * 3600_000
        )
      })
      .catch(console.error)
  }

  // task
  const taskData = extractTaskFromTranscript(transcript)
  if (taskData) {
    const task = addTask(taskData)
    createPressureItem(
      task.id, 'task', task.description,
      task.person, task.priority,
      (task.resurfaceAt ?? Date.now() + 3_600_000) - Date.now()
    )
  }

  // episodic memory — store as structured event
  storeEpisode(transcript, person).catch(console.error)
}

// ── Main decide ───────────────────────────────────────────────────────────

export async function decide(transcript: string): Promise<string | null> {
  const t0       = Date.now()
  const deadline = t0 + CONFIG.LATENCY_BUDGET_MS   // hard cap

  // memory
  const turn  = remember(transcript)
  const event = classifyEvent(transcript)
  console.log(`[EVENT] ${event}`)

  // extract primary person from transcript for context
  const person = turn.speaker !== 'unknown'
    ? null   // speaker known — no name needed
    : transcript.match(/([A-Z][a-z]{1,14})/)?.[1] ?? null

  // side effects (non-blocking)
  processSideEffects(transcript, turn.intent, turn.offer, person)

  // ── steering — predict trajectory ─────────────────────────────────────
  const steering = await steer(transcript, false)
  if (steering.preloadMessage) {
    console.log(`[STEER] preload → "${steering.preloadMessage}"`)
  }

  // ── collect candidates ─────────────────────────────────────────────────
  const candidates: ActionCandidate[] = []

  // 1. Rule (0ms)
  const ruleHit = matchRule(transcript, currentMode)
  if (ruleHit) {
    candidates.push({ command: 'WAIT', message: ruleHit, source: 'rule', score: 1.0 })
    console.log(`[RULE] ${Date.now() - t0}ms — "${ruleHit}"`)
  }

  // 2. Embedding (~5ms)
  if (Date.now() < deadline - 10) {
    const embedMatch = await matchEmbedding(transcript)
    if (embedMatch) {
      candidates.push({ command: 'WAIT', message: embedMatch.action, source: 'embedding', score: embedMatch.score })
      console.log(`[EMBED] ${Date.now() - t0}ms — "${embedMatch.action}" @ ${embedMatch.score.toFixed(3)}`)
    }
  }

  // 3. LLM — only if high impact AND time budget remains
  if (isHighImpact(event) && Date.now() < deadline - 200) {
    const llmResult = await llmFallback(transcript, event, deadline)
    if (llmResult) {
      candidates.push({ command: 'WAIT', message: llmResult, source: 'llm', score: 0.7 })
      console.log(`[LLM] ${Date.now() - t0}ms — "${llmResult}"`)
    }
  } else if (!isHighImpact(event) && !candidates.length) {
    // non-high-impact, no rule/embed hit — use steering preload if available
    if (steering.preloadMessage) {
      candidates.push({ command: 'WAIT', message: steering.preloadMessage, source: 'rule', score: 0.65 })
    }
  }

  if (!candidates.length) {
    console.log(`[PASS] ${Date.now() - t0}ms`)
    return null
  }

  // ── select best ────────────────────────────────────────────────────────
  const best: BestAction | null = selectBestAction(candidates, event)
  if (!best) return null

  const totalMs = Date.now() - t0
  console.log(`[DECIDE] ${totalMs}ms — "${best.message}" urgency=${best.urgency} conf=${best.confidence}`)

  // ── identity boost — mention high-importance person → escalate urgency ──
  const highImportance = getHighImportancePeople(transcript)
  if (highImportance.length) {
    console.log(`[IDENTITY] ${highImportance[0].urgencyLabel}`)
  }

  logDecision(transcript, event, best.message, best.source, currentMode, person, turn.offer)

  return best.message
}

// ── Outcome feedback — wires to adaptive weights ───────────────────────────

export function reportOutcome(message: string, outcome: 'success' | 'ignored' | 'lost'): void {
  if (outcome === 'success') recordSuccess(message)
  else if (outcome === 'ignored') recordIgnored(message)
  else recordIgnored(message) // lost also penalizes
}

// ── Re-export context helpers ─────────────────────────────────────────────

export {
  getTaskContext,
  getPeopleContext,
  getFollowUpContext,
  getPatternContext,
  getTrajectoryContext,
  getEpisodicContext,
  getIdentityContext,
}