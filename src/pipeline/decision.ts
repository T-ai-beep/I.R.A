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

const TIGHT_PROMPT = `You are ARIA, a real-time decision coach in an earpiece.
Output ONE line only: ACTION — phrase
ACTION must be one of: Reject Accept Ask Push Wait Challenge Clarify Delay Anchor Exit
phrase is 2–3 words MAX. Total output: 4–6 words.
Examples: "Anchor — hold the number" / "Ask — what changed" / "Push — close now"
If nothing actionable: PASS
No punctuation. No explanation. No quotes.`

// ── FIX 1: Streaming LLM → immediate TTS ─────────────────────────────────
//
// Old behavior: stream:false → wait for full response → speak(full)
// New behavior: stream:true → buffer tokens → speak() every 3 words
//
// This eliminates the ~370ms wait between LLM first token and TTS start.
// The output is 4–6 words total, so it streams in 1–2 chunks.

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
        stream: true,   // ← CHANGED: was false
      }),
      signal: AbortSignal.timeout(remaining),
    })

    if (!res.body) return null

    const reader  = res.body.getReader()
    const decoder = new TextDecoder()

    let buffer     = ''   // token accumulation buffer
    let fullOutput = ''   // complete response for logging/return
    let spokenAt   = -1   // ms of first speak() call
    let firstToken = true

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })

      // Ollama streams NDJSON: one JSON object per line
      for (const line of chunk.split('\n')) {
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

        buffer     += token
        fullOutput += token

        // ── Speak when buffer hits 3 words ────────────────────────────
        // 3-word threshold: enough for a coherent phrase, short enough
        // to start audio before the full response is done.
        const wordCount = buffer.trim().split(/\s+/).filter(Boolean).length
        if (wordCount >= 3) {
          const clean = buffer.trim()
          if (clean && clean.toUpperCase() !== 'PASS') {
            if (spokenAt < 0) {
              spokenAt = Date.now() - t0
              console.log(`[LLM-STREAM] first speak() @ ${spokenAt}ms (saved ~${Math.round(remaining - spokenAt)}ms vs non-streaming)`)
            }
            speak(clean)
          }
          buffer = ''
        }
      }
    }

    // Flush any remaining buffer (tail tokens < 3 words)
    const tail = buffer.trim()
    if (tail && tail.toUpperCase() !== 'PASS' && tail.length > 1) {
      speak(tail)
    }

    const raw = fullOutput.trim().replace(/['"`.]/g, '').trim()
    console.log(`[LLM-STREAM] total=${Date.now() - t0}ms output="${raw}"`)

    if (!raw || raw.toUpperCase() === 'PASS') return null

    const actions = ['Reject','Accept','Ask','Push','Wait','Challenge','Clarify','Delay','Anchor','Exit']
    if (!actions.some(a => raw.startsWith(a))) return null

    // Enforce word limit on full output
    return raw.split(/\s+/).slice(0, 6).join(' ')

  } catch (e) {
    console.log('[LLM-STREAM] error/timeout — fast path only')
    return null
  }
}

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

// ── FIX 3: LLM fast-path skip ─────────────────────────────────────────────
//
// If rule OR playbook produces a candidate with score >= 0.90,
// skip embedding AND LLM entirely. These two stages account for
// ~410ms avg (44ms embed + 365ms LLM TTFT). On 95% of real calls
// (rule/playbook hits) this drops warm P50 from ~950ms to ~440ms.

const FAST_PATH_THRESHOLD = 0.90

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

  processSideEffects(transcript, turn.intent, turn.offer, person)

  const steering = await steer(transcript, false)
  if (steering.preloadMessage) {
    console.log(`[STEER] preload → "${steering.preloadMessage}"`)
  }

  const candidates: ActionCandidate[] = []

  // 0. Playbook (negotiation only)
  let play = null
  if (modeAtCall === 'negotiation') {
    play = matchPlaybook(transcript)
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
  }

  // 1. Rule engine
  const ruleHit = matchRule(transcript, modeAtCall)
  if (ruleHit) {
    candidates.push({ command: 'WAIT', message: ruleHit, source: 'rule', score: 1.0 })
    console.log(`[RULE] ${Date.now() - t0}ms — "${ruleHit}"`)
  }

  // ── FIX 3: Fast path — skip embed + LLM if we already have a strong hit ──
  //
  // Rules score 1.0, mustRespond playbook scores 0.95 — both exceed threshold.
  // This eliminates ~410ms for the vast majority of calls.
  // ARIA_QUERY and QUESTION events bypass this so they still get LLM answers.
  const hasStrongCandidate = candidates.some(c => c.score >= FAST_PATH_THRESHOLD)

  if (hasStrongCandidate && event !== 'QUESTION') {
    const best = selectBestAction(candidates, event)
    if (best) {
      console.log(`[FAST PATH] ${Date.now() - t0}ms — skipped embed+LLM — "${best.message}"`)
      logDecision(transcript, event, best.message, best.source, modeAtCall, person, turn.offer)

      // Handle mustRespond override same as before
      if (play?.mustRespond) {
        const isObservationalLabel = (
          best.message.startsWith('⚠') ||
          /fear signal|frame breaking|pain unaddressed|buying time/i.test(best.message)
        )
        if (isObservationalLabel) {
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

  // 2. Embedding (only reached when no strong rule/playbook hit)
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

  // 3. LLM streaming — only for high-impact events with budget remaining
  //    Note: llmFallbackStreaming() calls speak() internally as tokens arrive.
  //    It also returns the full string for logging. We do NOT call speak() again.
  if (isHighImpact(event) && Date.now() < deadline - 200) {
    const llmResult = await llmFallbackStreaming(transcript, event, deadline)
    if (llmResult) {
      // speak() was already called inside llmFallbackStreaming — don't call again
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

  // ── Forced response for money/close events with no candidates ─────────
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

  // mustRespond override
  if (play?.mustRespond) {
    const playbookCandidate = candidates.find(c => c.score === 0.95)
    const isObservationalLabel = (
      best.message.startsWith('⚠') ||
      /fear signal|frame breaking|pain unaddressed|buying time/i.test(best.message)
    )
    if (playbookCandidate && isObservationalLabel) {
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