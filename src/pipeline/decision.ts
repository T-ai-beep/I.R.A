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
import { storeEpisode, getEpisodicContext } from '../pipeline/epsodic.js'
import { getIdentityContext, getHighImportancePeople } from './identityScore.js'
import { createPressureItem } from './pressure.js'
import { matchPlaybook, executePlay, FORCED_RESPONSE_EVENTS, getForcedFallback } from './playbook.js'

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

export { classifyEvent }

function classifyEvent(transcript: string): EventType {
  const t = transcript.toLowerCase()
  if (/can't afford|too expensive|too much|no budget|price is|can't spend|fifteen hundred.*too|upfront is.*too/.test(t)) return 'PRICE_OBJECTION'
  if (/need to think|get back|not sure|maybe|not ready/.test(t)) return 'STALLING'
  if (/check with|my team|my boss|need approval|not my call|run it by|my wife|my husband/.test(t)) return 'AUTHORITY'
  if (/already use|currently use|we have|service.?titan|competitor|went with|signed with|chose.*instead/.test(t)) return 'COMPETITOR'
  if (/sounds good|we're in|let's do it|i'll take it|deal|move forward|i'm in/.test(t)) return 'AGREEMENT'
  if (/\?$/.test(t.trim())) return 'QUESTION'
  if (/\$|per month|a year|pricing|cost|budget|range of/.test(t)) return 'OFFER_DISCUSS'
  if (/deadline|by friday|by monday|end of week|next week|asap/.test(t)) return 'DEADLINE'
  return 'UNKNOWN'
}

const HIGH_IMPACT: EventType[] = [
  'PRICE_OBJECTION', 'AUTHORITY', 'COMPETITOR', 'AGREEMENT', 'QUESTION', 'OFFER_DISCUSS',
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

// ── LLM fallback ──────────────────────────────────────────────────────────

async function llmFallback(
  transcript: string,
  event: EventType,
  deadline: number
): Promise<string | null> {
  const ctx = getContext()
  const contextLine = ctx.lastOffer
    ? `Last offer: $${ctx.lastOffer}. Last intent: ${ctx.lastIntent}.`
    : ''

  const taskCtx     = getTaskContext()
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

    const actions = ['Reject', 'Accept', 'Ask', 'Push', 'Wait', 'Challenge', 'Clarify', 'Delay', 'Anchor', 'Exit']
    if (!actions.some(a => raw.startsWith(a))) return null

    return raw.split(/\s+/).slice(0, 4).join(' ')
  } catch {
    console.log('[LLM] timed out — rules-only fallback')
    return null
  }
}

// ── Side effects ──────────────────────────────────────────────────────────

function processSideEffects(
  transcript: string,
  intent: string | null,
  offer: number | null,
  person: string | null
): void {
  updatePeopleFromTranscript(transcript, intent, offer)

  const fuDetected = detectFollowUp(transcript)
  if (fuDetected) {
    const pCtx = getPeopleContext(transcript)
    createFollowUp(transcript, fuDetected, pCtx ?? undefined)
      .then(fu => {
        createPressureItem(
          fu.id, 'followup', fu.suggestedAction,
          fu.person, fu.priority, fuDetected.delayHours * 3600_000
        )
      })
      .catch(console.error)
  }

  const taskData = extractTaskFromTranscript(transcript)
  if (taskData) {
    const task = addTask(taskData)
    createPressureItem(
      task.id, 'task', task.description,
      task.person, task.priority,
      (task.resurfaceAt ?? Date.now() + 3_600_000) - Date.now()
    )
  }

  storeEpisode(transcript, person).catch(console.error)
}

// ── Main decide ───────────────────────────────────────────────────────────

export async function decide(transcript: string): Promise<string | null> {
  const t0       = Date.now()
  const deadline = t0 + CONFIG.LATENCY_BUDGET_MS

  // memory
  const turn  = remember(transcript)
  const event = classifyEvent(transcript)
  console.log(`[EVENT] ${event}`)

  const person = turn.speaker !== 'unknown'
    ? null
    : transcript.match(/([A-Z][a-z]{1,14})/)?.[1] ?? null

  // side effects (non-blocking)
  processSideEffects(transcript, turn.intent, turn.offer, person)

  // ── steering ──────────────────────────────────────────────────────────
  const steering = await steer(transcript, false)
  if (steering.preloadMessage) {
    console.log(`[STEER] preload → "${steering.preloadMessage}"`)
  }

  // ── collect candidates ────────────────────────────────────────────────
  const candidates: ActionCandidate[] = []

  // 0. PLAYBOOK — zero latency, precomputed executable responses
  //    Runs before rules/embeddings/LLM so it always contributes a candidate
  //    mustRespond plays score 0.95 — beat embeddings, lose to rules
  const play = matchPlaybook(transcript)
  if (play) {
    const playbookResponse = executePlay(play)
    const playbookScore    = play.mustRespond ? 0.95 : 0.70
    candidates.push({
      command: 'WAIT',
      message: playbookResponse,
      source:  'rule',
      score:   playbookScore,
    })
    console.log(`[PLAY] ${play.key} score=${playbookScore} — "${playbookResponse}"`)
  }

  // 1. Rule engine (0ms)
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

  // 3. LLM — only high impact events with time budget
  if (isHighImpact(event) && Date.now() < deadline - 200) {
    const llmResult = await llmFallback(transcript, event, deadline)
    if (llmResult) {
      candidates.push({ command: 'WAIT', message: llmResult, source: 'llm', score: 0.7 })
      console.log(`[LLM] ${Date.now() - t0}ms — "${llmResult}"`)
    }
  } else if (!isHighImpact(event) && !candidates.length) {
    if (steering.preloadMessage) {
      candidates.push({ command: 'WAIT', message: steering.preloadMessage, source: 'rule', score: 0.65 })
    }
  }

  // ── FORCED RESPONSE — certain events can NEVER return null ────────────
  //    If we still have no candidates and this is a money/closing moment,
  //    fire the precomputed fallback. No silent moments on critical signals.
  if (!candidates.length && FORCED_RESPONSE_EVENTS.has(event)) {
    const fallback = getForcedFallback(event)
    if (fallback) {
      console.log(`[FORCED] ${event} — no candidates, firing fallback`)
      candidates.push({ command: 'WAIT', message: fallback, source: 'rule', score: 0.60 })
    }
  }

  if (!candidates.length) {
    console.log(`[PASS] ${Date.now() - t0}ms`)
    return null
  }

  // ── select best ───────────────────────────────────────────────────────
  const best: BestAction | null = selectBestAction(candidates, event)
  if (!best) return null

  // ── mustRespond override ──────────────────────────────────────────────
  // If playbook says mustRespond but scoring picked a lower-value observational
  // label (e.g. "⚠ Price objection — fear signal"), override with the
  // playbook's executable response instead.
  if (play?.mustRespond) {
    const playbookCandidate = candidates.find(c => c.score === 0.95)
    const isObservationalLabel = best.message.startsWith('⚠') || best.message.includes('fear signal') || best.message.includes('frame breaking') || best.message.includes('pain unaddressed')
    if (playbookCandidate && isObservationalLabel) {
      console.log(`[EXEC] mustRespond override — swapping label for executable response`)
      const execMessage = playbookCandidate.message
      logDecision(transcript, event, execMessage, 'rule', currentMode, person, turn.offer)
      console.log(`[DECIDE] ${Date.now() - t0}ms — "${execMessage}" [playbook override]`)
      return execMessage
    }
  }

  const totalMs = Date.now() - t0
  console.log(`[DECIDE] ${totalMs}ms — "${best.message}" urgency=${best.urgency} conf=${best.confidence}`)

  const highImportance = getHighImportancePeople(transcript)
  if (highImportance.length) {
    console.log(`[IDENTITY] ${highImportance[0].urgencyLabel}`)
  }

  logDecision(transcript, event, best.message, best.source, currentMode, person, turn.offer)

  return best.message
}

// ── Outcome feedback ──────────────────────────────────────────────────────

export function reportOutcome(message: string, outcome: 'success' | 'ignored' | 'lost'): void {
  if (outcome === 'success') recordSuccess(message)
  else recordIgnored(message)
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