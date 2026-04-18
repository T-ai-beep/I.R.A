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
import { FORCED_RESPONSE_EVENTS, getForcedFallback } from './playbook.js'
import { speak } from './tts.js'
import { getCoachSession } from './negotiationCoach.js'

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

// ── Dedup guard — never speak the same line twice in a row ────────────────
let lastSpoken: string | null = null

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

  if (
    /can't afford|too expensive|too much|no budget|price is|can't spend/i.test(t) ||
    /fifteen hundred.*too|upfront.*too|valuation.*high|switching cost/i.test(t) ||
    /that is a lot\b|that's a lot\b|a lot for.*company|a lot for.*(size|operation)/i.test(t) ||
    /was not expecting that number|sticker shock|feels like a stretch/i.test(t) ||
    /not sure.*get that value|not sure.*would get.*value/i.test(t) ||
    /fifteen hundred bucks is a lot|lot for us man|feels like too much/i.test(t)
  ) return 'PRICE_OBJECTION'

  if (
    /check with|my team|my boss|need approval|not my call|run it by/i.test(t) ||
    /my wife|my husband|my business partner|she handles|he handles/i.test(t) ||
    /partner.*weigh in|our team would need to align|team.*align on/i.test(t)
  ) return 'AUTHORITY'

  if (
    /already use|currently use|we have|service.?titan|jobber|housecall/i.test(t) ||
    /competitor|went with|signed with|chose.*instead/i.test(t) ||
    /signed the paperwork with them|already signed with/i.test(t) ||
    /happy with.*current/i.test(t)
  ) return 'COMPETITOR'

  if (
    /sounds good|we're in|let's do it|i'll take it|deal|move forward/i.test(t) ||
    /i'm in\b|when do we start|ready to sign|close this week/i.test(t) ||
    /could really work for us|this could really work/i.test(t) ||
    /yeah.*i am in|alright.*let's.*do this/i.test(t)
  ) return 'AGREEMENT'

  if (
    /need to think|get back|not sure|maybe|not ready/i.test(t) ||
    /circle back|be in touch|will be in touch/i.test(t) ||
    /sounds interesting.*we will|this is interesting.*we will/i.test(t)
  ) return 'STALLING'

  if (/\?$/.test(t.trim())) return 'QUESTION'

  if (
    /\$|per month|a year|annually|pricing|cost|budget|range of|salary|compensation/i.test(t)
  ) return 'OFFER_DISCUSS'

  if (/deadline|by friday|by monday|end of week|next week|asap/i.test(t)) return 'DEADLINE'

  return 'UNKNOWN'
}

// ── Reversal detection ────────────────────────────────────────────────────

const REVERSAL_PATTERN = /\b(actually|wait|hold on|let me check|never mind|on second thought)\b/i

function detectReversal(transcript: string): boolean {
  return REVERSAL_PATTERN.test(transcript)
}

// ── Strategic WAIT gate ───────────────────────────────────────────────────

function shouldWait(transcript: string, event: EventType): boolean {
  const wordCount = transcript.trim().split(/\s+/).length
  if (wordCount <= 2 && event === 'UNKNOWN') return true
  if (detectReversal(transcript) && event === 'UNKNOWN') return true
  return false
}

// ── Prior-intent contradiction check ─────────────────────────────────────

const CONTRADICTING_PRIOR: Partial<Record<string, EventType[]>> = {
  'AGREEMENT': ['PRICE_OBJECTION', 'STALLING', 'AUTHORITY'],
  'STALLING':  ['AGREEMENT'],
}

function priorContradicts(event: EventType): boolean {
  const ctx = getContext()
  if (!ctx.lastIntent) return false
  return CONTRADICTING_PRIOR[ctx.lastIntent]?.includes(event) ?? false
}

// ── Compound signal detection ─────────────────────────────────────────────

function detectCompoundSignal(transcript: string): ActionCandidate | null {
  const isPriceChallenge = /beat|match|percent.*lower|come down|beat their price/i.test(transcript)
  const ctx = getContext()
  const priorWasCompetitor = ctx.lastIntent === 'COMPETITOR'

  if (isPriceChallenge && priorWasCompetitor) {
    const fallback = getForcedFallback('PRICE_OBJECTION')
    if (fallback) {
      console.log('[COMPOUND] price challenge after competitor — forcing discount response')
      return { command: 'PUSH', message: fallback, source: 'rule', score: 0.95 }
    }
  }

  return null
}

const HIGH_IMPACT: EventType[] = [
  'PRICE_OBJECTION', 'AUTHORITY', 'COMPETITOR', 'AGREEMENT', 'QUESTION', 'OFFER_DISCUSS',
]

function isHighImpact(event: EventType): boolean {
  return HIGH_IMPACT.includes(event)
}

const FAST_PATH_THRESHOLD = 0.90

// ── OPT-6: Static system prompt — Ollama reuses KV cache across calls ─────
// Never put dynamic content here. Everything dynamic goes in the user message.
const TIGHT_PROMPT = `You are ARIA, a real-time decision coach in an earpiece.
Output ONE line only: ACTION — phrase
ACTION must be one of: Reject Accept Ask Push Wait Challenge Clarify Delay Anchor Exit
phrase is 2–3 words MAX. Total output: 4–6 words.
Examples: "Anchor — hold the number" / "Ask — what changed" / "Push — close now"
If nothing actionable: PASS
No punctuation. No explanation. No quotes.`

// ── Dedup helper ──────────────────────────────────────────────────────────
function speakDeduped(message: string): void {
  if (message === lastSpoken) {
    console.log(`[DEDUP] identical consecutive output suppressed — "${message}"`)
    return
  }
  lastSpoken = message
  speak(message)
}

async function llmFallbackStreaming(
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

  const t0 = Date.now()

  try {
    const res = await fetch(CONFIG.OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        keep_alive: '10m',  // OPT-6: keep model loaded, reuse KV cache
        messages: [
          // OPT-6: system message is static — Ollama caches this
          { role: 'system', content: TIGHT_PROMPT },
          {
            // OPT-6: all dynamic content lives here only
            role: 'user',
            content: `Event: ${event}\n${contextLine}${extraCtx ? '\n' + extraCtx : ''}\nTranscript: "${transcript}"`,
          },
        ],
        stream: true,
      }),
      signal: AbortSignal.timeout(remaining),
    })

    if (!res.body) return null

    const reader  = res.body.getReader()
    const decoder = new TextDecoder()
    const CHUNK_WORDS = 3

    let wordBuffer  = ''
    let fullOutput  = ''
    let firstSpeak  = true
    let firstToken  = true

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      const raw = decoder.decode(value, { stream: true })

      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let parsed: { message?: { content?: string }; done?: boolean }
        try { parsed = JSON.parse(trimmed) } catch { continue }
        if (parsed.done) break

        const token = parsed.message?.content ?? ''
        if (!token) continue

        if (firstToken) {
          console.log(`[LLM-STREAM] first token @ ${Date.now() - t0}ms`)
          firstToken = false
        }

        wordBuffer  += token
        fullOutput  += token

        const words = wordBuffer.trim().split(/\s+/).filter(Boolean)
        if (words.length >= CHUNK_WORDS) {
          const chunk = wordBuffer.trim()
          if (chunk && chunk.toUpperCase() !== 'PASS') {
            if (firstSpeak) {
              console.log(`[LLM-STREAM] first speak() @ ${Date.now() - t0}ms`)
              firstSpeak = false
            }
            speakDeduped(chunk)
          }
          wordBuffer = ''
        }
      }
    }

    const tail = wordBuffer.trim()
    if (tail && tail.toUpperCase() !== 'PASS' && tail.length > 1) {
      speakDeduped(tail)
    }

    const raw = fullOutput.trim().replace(/['"`.]/g, '').trim()
    console.log(`[LLM-STREAM] total=${Date.now() - t0}ms — "${raw}"`)

    if (!raw || raw.toUpperCase() === 'PASS') return null

    const actions = ['Reject','Accept','Ask','Push','Wait','Challenge','Clarify','Delay','Anchor','Exit']
    if (!actions.some(a => raw.startsWith(a))) return null

    return raw.split(/\s+/).slice(0, 6).join(' ')

  } catch (e) {
    console.log('[LLM-STREAM] error/timeout — fast path only')
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
  setImmediate(() => {
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
  })
}

// ── decide() ──────────────────────────────────────────────────────────────

export async function decide(transcript: string): Promise<string | null> {
  if (!transcript || !transcript.trim()) return null
  const t0       = Date.now()
  const deadline = t0 + CONFIG.LATENCY_BUDGET_MS

  const modeAtCall = currentMode
  const turn       = remember(transcript)
  const event      = classifyEvent(transcript)
  console.log(`[EVENT] ${event} [MODE] ${modeAtCall}`)

  const person = turn.speaker !== 'unknown'
    ? null
    : transcript.match(/([A-Z][a-z]{1,14})/)?.[1] ?? null

  processSideEffects(transcript, turn.intent, turn.offer, person)

  // ── Strategic WAIT gate ───────────────────────────────────────────────
  if (shouldWait(transcript, event)) {
    console.log('[WAIT] strategic silence')
    logDecision(transcript, event, 'WAIT', 'rule', modeAtCall, person, turn.offer)
    return null
  }

  const steering = await steer(transcript, false)
  if (steering.preloadMessage) {
    console.log(`[STEER] preload → "${steering.preloadMessage}"`)
  }

  const candidates: ActionCandidate[] = []

  // ── [0] Coach — stateful brain (negotiation only) ─────────────────────
  let coachFired = false
  if (modeAtCall === 'negotiation') {
    const coachTurn = getCoachSession().process(transcript)
    if (!coachTurn.wait && coachTurn.response) {
      candidates.push({
        command: 'WAIT',
        message: coachTurn.response,
        source:  'rule',
        score:   0.96,
      })
      coachFired = true
      console.log(`[COACH] L${coachTurn.level}/${coachTurn.levelName} — "${coachTurn.response}"`)
    } else if (coachTurn.wait) {
      if (!FORCED_RESPONSE_EVENTS.has(event)) {
        console.log('[COACH] strategic silence')
        return null
      }
    }
  }

  // ── [1] Rule engine ───────────────────────────────────────────────────
  const ruleHit = matchRule(transcript, modeAtCall)
  if (ruleHit) {
    candidates.push({ command: 'WAIT', message: ruleHit, source: 'rule', score: 1.0 })
    console.log(`[RULE] ${Date.now() - t0}ms — "${ruleHit}"`)
  }

  // ── [1b] Compound signal detection ───────────────────────────────────
  if (!ruleHit && modeAtCall === 'negotiation') {
    const compound = detectCompoundSignal(transcript)
    if (compound) candidates.push(compound)
  }

  // ── FAST PATH ─────────────────────────────────────────────────────────
  const contradicts        = priorContradicts(event)
  const effectiveThreshold = contradicts ? FAST_PATH_THRESHOLD * 0.92 : FAST_PATH_THRESHOLD
  const hasStrongCandidate = candidates.some(c => c.score >= effectiveThreshold)
  const suppressAgreement  = detectReversal(transcript) && event === 'AGREEMENT'

  if (hasStrongCandidate && event !== 'QUESTION' && !suppressAgreement) {
    const best = selectBestAction(candidates, event)
    if (best) {
      const ms = Date.now() - t0
      console.log(`[FAST PATH] ${ms}ms — "${best.message}"`)
      logDecision(transcript, event, best.message, best.source, modeAtCall, person, turn.offer)

      if (coachFired) {
        const isObservational = (
          best.message.startsWith('⚠') ||
          /fear signal|frame breaking|pain unaddressed|buying time/i.test(best.message)
        )
        if (isObservational) {
          const coachCandidate = candidates.find(c => c.score === 0.96)
          if (coachCandidate) {
            console.log(`[FAST PATH] coach override — dropping observational label`)
            speakDeduped(coachCandidate.message)
            return coachCandidate.message
          }
        }
      }

      speakDeduped(best.message)
      return best.message
    }
  }

  // ── [2] Embedding ─────────────────────────────────────────────────────
  if (Date.now() < deadline - 10) {
    const embedMatch = await Promise.race([
      matchEmbedding(transcript),
      new Promise<null>(r => setTimeout(() => r(null), 150))
    ])
    if (embedMatch) {
      const isNegotiationLabel = /hold number|frame breaking|fear signal|pain unaddressed|deal closing/i.test(embedMatch.action)
      if (modeAtCall === 'negotiation' || !isNegotiationLabel) {
        candidates.push({ command: 'WAIT', message: embedMatch.action, source: 'embedding', score: embedMatch.score })
        console.log(`[EMBED] ${Date.now() - t0}ms — "${embedMatch.action}" @ ${embedMatch.score.toFixed(3)}`)
      }
    }
  }

  // ── [3] LLM streaming ─────────────────────────────────────────────────
  if (isHighImpact(event) && Date.now() < deadline - 200) {
    const llmResult = await llmFallbackStreaming(transcript, event, deadline)
    if (llmResult) {
      candidates.push({ command: 'WAIT', message: llmResult, source: 'llm', score: 0.7 })
      console.log(`[LLM] ${Date.now() - t0}ms — "${llmResult}"`)
      logDecision(transcript, event, llmResult, 'llm', modeAtCall, person, turn.offer)
      return llmResult
    }
  } else if (!isHighImpact(event) && !candidates.length) {
    if (steering.preloadMessage) {
      candidates.push({ command: 'WAIT', message: steering.preloadMessage, source: 'rule', score: 0.65 })
    }
  }

  // ── [4] Forced fallback ───────────────────────────────────────────────
  if (!candidates.length && modeAtCall === 'negotiation' && FORCED_RESPONSE_EVENTS.has(event)) {
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

  const best: BestAction | null = selectBestAction(candidates, event)
  if (!best) return null

  // Slow path coach override
  if (coachFired) {
    const coachCandidate = candidates.find(c => c.score === 0.96)
    const isObservational = (
      best.message.startsWith('⚠') ||
      /fear signal|frame breaking|pain unaddressed|buying time/i.test(best.message)
    )
    if (coachCandidate && isObservational) {
      console.log(`[EXEC] coach override`)
      logDecision(transcript, event, coachCandidate.message, 'rule', modeAtCall, person, turn.offer)
      speakDeduped(coachCandidate.message)
      return coachCandidate.message
    }
  }

  const totalMs = Date.now() - t0
  console.log(`[DECIDE] ${totalMs}ms — "${best.message}" urgency=${best.urgency} conf=${best.confidence}`)

  const highImportance = getHighImportancePeople(transcript)
  if (highImportance.length) {
    console.log(`[IDENTITY] ${highImportance[0].urgencyLabel}`)
  }

  logDecision(transcript, event, best.message, best.source, modeAtCall, person, turn.offer)
  speakDeduped(best.message)
  return best.message
}

export function reportOutcome(message: string, outcome: 'success' | 'ignored' | 'lost'): void {
  if (outcome === 'success') recordSuccess(message)
  else recordIgnored(message)
}

export {
  getTaskContext,
  getPeopleContext,
  getFollowUpContext,
  getPatternContext,
  getTrajectoryContext,
  getEpisodicContext,
  getIdentityContext,
}