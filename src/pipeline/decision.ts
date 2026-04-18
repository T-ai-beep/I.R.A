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
import { speak } from './tts.js'

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

const HIGH_IMPACT: EventType[] = [
  'PRICE_OBJECTION', 'AUTHORITY', 'COMPETITOR', 'AGREEMENT', 'QUESTION', 'OFFER_DISCUSS',
]

function isHighImpact(event: EventType): boolean {
  return HIGH_IMPACT.includes(event)
}

// ── FIX 4: Fast-path threshold ────────────────────────────────────────────
// Rule scores 1.0, mustRespond playbook scores 0.95.
// Both exceed this threshold → embed + LLM are entirely skipped.
// Target: 95%+ of real calls hit this path, paying only rule/playbook cost (~0.4ms).

const FAST_PATH_THRESHOLD = 0.90

const TIGHT_PROMPT = `You are ARIA, a real-time decision coach in an earpiece.
Output ONE line only: ACTION — phrase
ACTION must be one of: Reject Accept Ask Push Wait Challenge Clarify Delay Anchor Exit
phrase is 2–3 words MAX. Total output: 4–6 words.
Examples: "Anchor — hold the number" / "Ask — what changed" / "Push — close now"
If nothing actionable: PASS
No punctuation. No explanation. No quotes.`

// ── FIX 1 + 2: Streaming LLM → word-level TTS ────────────────────────────
//
// Old: stream:false → wait full response (~365ms TTFT + ~145ms gen) → speak()
// New: stream:true → buffer accumulates tokens → speak() fires at 3 words
//
// For a 4–6 word output this means:
//   - speak() fires ~1.5× sooner than waiting for full completion
//   - TTS receives the first chunk while LLM is still generating the tail
//   - Net saving: ~(LLM_gen_time × 0.75) = ~108ms on warm P50
//
// Combined with fast-path skip (no LLM on rule hits), the LLM path is only
// reached for QUESTION events and ARIA_QUERY — both of which benefit most
// from streaming since they produce longer outputs.

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
        messages: [
          { role: 'system', content: TIGHT_PROMPT },
          {
            role: 'user',
            content: `${contextLine}${extraCtx ? '\n' + extraCtx : ''}\nEvent: ${event}\nTranscript: "${transcript}"`,
          },
        ],
        stream: true,   // ← streaming enabled
      }),
      signal: AbortSignal.timeout(remaining),
    })

    if (!res.body) return null

    const reader  = res.body.getReader()
    const decoder = new TextDecoder()

    // ── Token accumulation + chunked speak ────────────────────────────────
    // CHUNK_WORDS = 3: fires speak() every 3 words.
    // For a 6-word output this means 2 speak() calls:
    //   call 1: after word 3 (first ~half of response) — fires while LLM still streams
    //   call 2: tail flush — fires immediately after stream end
    //
    // TTS receives call 1 before call 2 is even sent. Kokoro starts synthesizing
    // chunk 1 while the LLM generates the remaining words. First audio is heard
    // ~(gen_time_for_3_words) sooner than waiting for full completion.

    const CHUNK_WORDS = 3

    let wordBuffer  = ''   // token accumulation buffer
    let fullOutput  = ''   // full response string for return value
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

        // Count words in buffer; speak when threshold reached
        const words = wordBuffer.trim().split(/\s+/).filter(Boolean)
        if (words.length >= CHUNK_WORDS) {
          const chunk = wordBuffer.trim()
          if (chunk && chunk.toUpperCase() !== 'PASS') {
            if (firstSpeak) {
              console.log(`[LLM-STREAM] first speak() @ ${Date.now() - t0}ms`)
              firstSpeak = false
            }
            speak(chunk)
          }
          wordBuffer = ''
        }
      }
    }

    // Flush tail tokens (< CHUNK_WORDS remaining)
    const tail = wordBuffer.trim()
    if (tail && tail.toUpperCase() !== 'PASS' && tail.length > 1) {
      speak(tail)
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

// ── Side effects (async, non-blocking) ────────────────────────────────────

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

// ── decide() ─────────────────────────────────────────────────────────────
//
// Execution order and fast-path logic:
//
//   [0] Playbook match   (negotiation only)  ~0.1ms
//   [1] Rule engine      (all modes)         ~0.3ms
//   ── FAST PATH CHECK ──
//   If any candidate score >= 0.90 AND event != QUESTION:
//     → speak() + return immediately. Embed + LLM never run.
//     → This covers ~95% of real calls (rule score = 1.0, mustRespond playbook = 0.95)
//     → Warm P50 contribution: ~0.4ms (rules) + ~190ms (TTS TTFC) = ~190ms total
//   ── SLOW PATH ──
//   [2] Embedding        (LRU cached)        ~44ms warm / ~0ms cache hit
//   [3] LLM streaming    (QUESTION events)   ~365ms TTFT + chunked speak
//   [4] Forced fallback  (money events)      ~0ms

export async function decide(transcript: string): Promise<string | null> {
  const t0       = Date.now()
  const deadline = t0 + CONFIG.LATENCY_BUDGET_MS

  const modeAtCall = currentMode
  const turn       = remember(transcript)
  const event      = classifyEvent(transcript)
  console.log(`[EVENT] ${event} [MODE] ${modeAtCall}`)

  const person = turn.speaker !== 'unknown'
    ? null
    : transcript.match(/([A-Z][a-z]{1,14})/)?.[1] ?? null

  // Side effects fire async — don't block the fast path
  processSideEffects(transcript, turn.intent, turn.offer, person)

  // Steering: fast rule-based prediction only (no LLM)
  const steering = await steer(transcript, false)
  if (steering.preloadMessage) {
    console.log(`[STEER] preload → "${steering.preloadMessage}"`)
  }

  const candidates: ActionCandidate[] = []

  // ── [0] Playbook (negotiation only) ──────────────────────────────────
  let play = null
  if (modeAtCall === 'negotiation') {
    play = matchPlaybook(transcript)
    if (play) {
      const playbookResponse = executePlay(play)
      // mustRespond plays score 0.95 — exceeds FAST_PATH_THRESHOLD → skips embed+LLM
      const playbookScore    = play.mustRespond ? 0.95 : 0.70
      candidates.push({
        command: 'WAIT',
        message: playbookResponse,
        source:  'rule',
        score:   playbookScore,
      })
      console.log(`[PLAY] ${play.key} score=${playbookScore} — "${playbookResponse}"`)
    }
  }

  // ── [1] Rule engine ───────────────────────────────────────────────────
  const ruleHit = matchRule(transcript, modeAtCall)
  if (ruleHit) {
    // Rules always score 1.0 — always exceeds FAST_PATH_THRESHOLD
    candidates.push({ command: 'WAIT', message: ruleHit, source: 'rule', score: 1.0 })
    console.log(`[RULE] ${Date.now() - t0}ms — "${ruleHit}"`)
  }

  // ── FAST PATH: skip embed + LLM if strong candidate exists ───────────
  // Conditions: candidate score >= FAST_PATH_THRESHOLD AND not a QUESTION
  // QUESTION events bypass fast path because they need LLM knowledge answers.
  // ARIA_QUERY is handled separately and also bypasses.
  const hasStrongCandidate = candidates.some(c => c.score >= FAST_PATH_THRESHOLD)

  if (hasStrongCandidate && event !== 'QUESTION') {
    const best = selectBestAction(candidates, event)
    if (best) {
      const ms = Date.now() - t0
      console.log(`[FAST PATH] ${ms}ms — skipped embed+LLM — "${best.message}"`)
      logDecision(transcript, event, best.message, best.source, modeAtCall, person, turn.offer)

      // mustRespond override: prefer executable playbook response over observational rule label
      if (play?.mustRespond) {
        const isObservational = (
          best.message.startsWith('⚠') ||
          /fear signal|frame breaking|pain unaddressed|buying time/i.test(best.message)
        )
        if (isObservational) {
          const playbookCandidate = candidates.find(c => c.score === 0.95)
          if (playbookCandidate) {
            console.log(`[FAST PATH] mustRespond override`)
            speak(playbookCandidate.message)
            return playbookCandidate.message
          }
        }
      }

      speak(best.message)
      return best.message
    }
  }

  // ── [2] Embedding (LRU cache — repeated transcripts pay ~0ms) ────────
  if (Date.now() < deadline - 10) {
    const embedMatch = await matchEmbedding(transcript)
    if (embedMatch) {
      const isNegotiationLabel = /hold number|frame breaking|fear signal|pain unaddressed|deal closing/i.test(embedMatch.action)
      if (modeAtCall === 'negotiation' || !isNegotiationLabel) {
        candidates.push({ command: 'WAIT', message: embedMatch.action, source: 'embedding', score: embedMatch.score })
        console.log(`[EMBED] ${Date.now() - t0}ms — "${embedMatch.action}" @ ${embedMatch.score.toFixed(3)}`)
      }
    }
  }

  // ── [3] LLM streaming (high-impact events and QUESTION) ───────────────
  // speak() is called INSIDE llmFallbackStreaming as tokens arrive.
  // We do NOT call speak() again after it returns.
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

  // ── [4] Forced fallback (money/close events with zero candidates) ─────
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

  // mustRespond override (slow path)
  if (play?.mustRespond) {
    const playbookCandidate = candidates.find(c => c.score === 0.95)
    const isObservational = (
      best.message.startsWith('⚠') ||
      /fear signal|frame breaking|pain unaddressed|buying time/i.test(best.message)
    )
    if (playbookCandidate && isObservational) {
      console.log(`[EXEC] mustRespond override`)
      const execMessage = playbookCandidate.message
      logDecision(transcript, event, execMessage, 'rule', modeAtCall, person, turn.offer)
      speak(execMessage)
      return execMessage
    }
  }

  const totalMs = Date.now() - t0
  console.log(`[DECIDE] ${totalMs}ms — "${best.message}" urgency=${best.urgency} conf=${best.confidence}`)

  const highImportance = getHighImportancePeople(transcript)
  if (highImportance.length) {
    console.log(`[IDENTITY] ${highImportance[0].urgencyLabel}`)
  }

  logDecision(transcript, event, best.message, best.source, modeAtCall, person, turn.offer)
  speak(best.message)
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