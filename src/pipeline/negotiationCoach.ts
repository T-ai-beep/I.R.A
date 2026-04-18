/**
 * negotiationCoach.ts
 * Stateful negotiation coach — objection ladder + loop-breaker engine.
 *
 * Ladder:
 *   0 Probe    — find the real issue
 *   1 Isolate  — clarify the specific constraint
 *   2 Reframe  — shift focus to value / cost of inaction
 *   3 Anchor   — reinforce ROI / downside of not acting
 *   4 Close    — push toward decision or concrete next step
 *
 * Rules enforced (not delegated to caller):
 *   - Response history window (last 3): no line reused within window
 *   - Level advances every turn — never stays at 0 forever
 *   - Same intent with no new info > RECLASSIFY_AFTER turns → HIDDEN_OBJECTION
 *   - No signal on unknown + no prior state → null (strategic WAIT)
 *   - After MAX_RESISTANCE non-answers at level 4 → disqualify
 *   - Max 12 words per output enforced at output boundary
 *
 * Integration:
 *   import { coach, resetCoach } from './negotiationCoach.js'
 *   const response = coach(transcript)
 *   if (response) speak(response)   // null = strategic silence, caller must not speak
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type ObjectionType =
  | 'PRICE_OBJECTION'
  | 'STALLING'
  | 'AUTHORITY'
  | 'VALUE_DOUBT'
  | 'COMPETITOR'
  | 'AGREEMENT'
  | 'HIDDEN_OBJECTION'  // reclassified: repeated objection with no new info
  | 'UNKNOWN'

export type LadderLevel = 0 | 1 | 2 | 3 | 4
export type LadderLevelName = 'Probe' | 'Isolate' | 'Reframe' | 'Anchor' | 'Close'

export interface CoachTurn {
  input:           string
  response:        string | null  // null = strategic WAIT — caller must not speak
  wait:            boolean
  level:           LadderLevel
  levelName:       LadderLevelName
  objectionType:   ObjectionType
  reclassified:    boolean        // true = intent shifted to HIDDEN_OBJECTION
  userAnswered:    boolean
  escalated:       boolean
  disqualified:    boolean
  resistanceCount: number
}

export interface CoachState {
  level:            LadderLevel
  objectionType:    ObjectionType | null
  lastQuestion:     string | null
  recentResponses:  string[]       // sliding window — blocks reuse within HISTORY_WINDOW turns
  answeredLast:     boolean
  resistanceCount:  number
  sameIntentTurns:  number         // consecutive turns same intent, no new info
  disqualified:     boolean
  turnCount:        number
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_RESISTANCE   = 3
const HISTORY_WINDOW   = 3
const RECLASSIFY_AFTER = 2  // same intent + no new info → reclassify to HIDDEN_OBJECTION
const MAX_WORDS        = 12

// ── Response banks ─────────────────────────────────────────────────────────

type LevelBank    = [string, string, string]
type ObjectionBank = Record<LadderLevel, LevelBank>

const RESPONSES: Record<Exclude<ObjectionType, 'UNKNOWN'>, ObjectionBank> = {

  PRICE_OBJECTION: {
    0: [
      'Is it the total cost or monthly cash flow?',
      'What budget were you expecting for this?',
      'Is this a cash flow issue or a value issue?',
    ],
    1: [
      'What monthly number would actually work for you?',
      'If we matched your range, what else needs to be true?',
      'Is budget the only blocker, or is there more?',
    ],
    2: [
      'What does staying with the current approach cost you?',
      'What does your team lose every month this goes unsolved?',
      'Does $100 block you, or is the ROI unproven?',
    ],
    3: [
      'Six months of this — what does that actually cost you?',
      "What's the downside if nothing changes by Q3?",
      "What's the real price of not solving this now?",
    ],
    4: [
      "Then what's stopping you from starting this week?",
      'Who signs off, and when can we get them on a call?',
      "If cost wasn't the issue, what's left to decide?",
    ],
  },

  STALLING: {
    0: [
      'What specifically needs to change before you can decide?',
      'What information would make this an easy yes?',
      "What's the one thing that needs to be true first?",
    ],
    1: [
      'Is the delay about budget, timing, or confidence?',
      'Which part of this still feels unresolved?',
      "What would a no look like — is this heading there?",
    ],
    2: [
      'How much does staying stuck cost you each month?',
      'What changes if you decide next week vs next quarter?',
      "Every week without this — what's the real cost?",
    ],
    3: [
      'If this compounds for six months, what breaks?',
      "What's the risk of not acting before end of quarter?",
      "What's the worst case of a delayed decision here?",
    ],
    4: [
      'Give me a specific date — when do you decide?',
      'Yes or no: is this still a real priority for you?',
      'What needs to happen in the next 48 hours to move?',
    ],
  },

  AUTHORITY: {
    0: [
      'Who makes the final call on this?',
      'What does the decision-maker need to see?',
      "Can we get the right person on a 15-minute call?",
    ],
    1: [
      "If they say yes, are you ready to move this week?",
      "What's their single biggest concern — price or fit?",
      "When's the earliest you can loop them in?",
    ],
    2: [
      'What would make this a no-brainer for them?',
      'What does their approval process actually look like?',
      'Have they seen anything like this work before?',
    ],
    3: [
      'What happens to you if this decision gets delayed?',
      'Is there a cost to waiting for their sign-off?',
      "What's the risk if this sits another month?",
    ],
    4: [
      "Get them on a call — I'll close it in 15 minutes.",
      'What do I need to send them to make this easy?',
      "Tell me the one thing they need. I'll give you that.",
    ],
  },

  VALUE_DOUBT: {
    0: [
      'What result would make this clearly worth it?',
      'What does success look like for you in 90 days?',
      "What specific outcome are you not confident about?",
    ],
    1: [
      'Is it ROI you doubt, or fit for your situation?',
      'Which part of the value proposition feels weakest?',
      'What would you need to see to trust the outcome?',
    ],
    2: [
      "What's the cost of the current approach over a year?",
      'If this works, what becomes possible that is not now?',
      'What does your team lose every month this is unsolved?',
    ],
    3: [
      "What's the risk of betting on the current solution?",
      'Six months from now — what does the problem look like?',
      'What breaks first if you keep the status quo?',
    ],
    4: [
      'What would make you confident enough to start now?',
      "If the risk was removed, what's left to decide?",
      "What's one concrete thing I can do to close this?",
    ],
  },

  COMPETITOR: {
    0: [
      "What's the one thing your current system does not handle?",
      'How long has that gap existed?',
      "What made you look at alternatives in the first place?",
    ],
    1: [
      'So it works — but that problem has been there how long?',
      "If switching cost zero, would you move today?",
      'What would have to break before you made a change?',
    ],
    2: [
      'Three years with the same gap is not loyalty. It is inertia.',
      "What does that unsolved problem cost you per month?",
      'Your competitor is not staying with the same gap.',
    ],
    3: [
      'Are you staying because it works, or because switching feels hard?',
      "What's the real cost of another year with that gap?",
      'What breaks first if the current system fails mid-season?',
    ],
    4: [
      'Honest question — are you in, or is this a polite no?',
      'What would it take to make the switch this quarter?',
      "If we solve that gap, is there a reason not to move?",
    ],
  },

  AGREEMENT: {
    0: [
      'Good. What does your timeline look like to get started?',
      'Contract goes out today. Who signs on your end?',
      "What needs to happen before we send the paperwork?",
    ],
    1: [
      "Contract goes out today — who receives it?",
      "What's the fastest path to getting this signed?",
      'Can we lock in the start date right now?',
    ],
    2: [
      "What's the last thing that needs to be confirmed?",
      'Is there anything that could slow this down?',
      "I'll have everything ready — what do you need from me?",
    ],
    3: [
      "Let's get this done this week — agree?",
      "What's one thing I can do right now to close this?",
      'Who else needs to be involved before you sign?',
    ],
    4: [
      "Let's close this now. Yes or no?",
      "I'll send the contract — you sign this week, correct?",
      'What needs to happen in the next hour to move?',
    ],
  },

  HIDDEN_OBJECTION: {
    0: [
      "Price isn't the real issue — what is it actually?",
      "Something else is blocking this. What is it?",
      "You keep returning to price. What's underneath that?",
    ],
    1: [
      'Is it trust, timing, or someone else in the room?',
      "What would need to be different for this to feel right?",
      "If price disappeared today, what's the next objection?",
    ],
    2: [
      "Let's be direct — what would make you say yes right now?",
      "What's the real reason this is not moving forward?",
      "Something is off. Tell me what it actually is.",
    ],
    3: [
      "I would rather hear a clean no than a slow maybe.",
      "What's the one thing that, if solved, closes this?",
      "We are going in circles. What do you actually need?",
    ],
    4: [
      "In or out — I need to know now.",
      "This has stalled. Is it worth continuing?",
      "Sounds like this is not the right time — should we pause?",
    ],
  },
}

const DISQUALIFY_LINES: string[] = [
  "Sounds like this is not a priority — should we pause?",
  'I respect your time. Is this worth continuing?',
  'It seems the timing is not right — should we revisit?',
]

const LEVEL_NAMES: Record<LadderLevel, LadderLevelName> = {
  0: 'Probe',
  1: 'Isolate',
  2: 'Reframe',
  3: 'Anchor',
  4: 'Close',
}

// ── Intent detection ───────────────────────────────────────────────────────

const INTENT_PATTERNS: Record<Exclude<ObjectionType, 'UNKNOWN' | 'HIDDEN_OBJECTION'>, RegExp> = {
  AGREEMENT:       /move forward|let'?s do it|we'?re? (in|ready)|i'?ll take it|ready to sign|close this|when do we start|send me the contract|yeah.*i am in|sounds good.*let'?s/i,
  PRICE_OBJECTION: /too expensive|can'?t afford|too much|price is|out of budget|that is a lot|sticker shock|fifteen hundred|lot for us|cash flow|monthly (is|fee|cost)|feels like (too|a stretch)/i,
  AUTHORITY:       /check with|my (boss|team|partner|wife|husband)|need approval|not my call|run it by|partner.*weigh|team.*align/i,
  COMPETITOR:      /already use|using.*system|service.?titan|jobber|housecall|happy with current|signed with|switched to/i,
  VALUE_DOUBT:     /not sure (it'?s|we'?d|about)|doubt|worth it|prove|roi|uncertain|results|does it work|skeptical/i,
  STALLING:        /think about it|need time|get back|not ready|circle back|next (month|quarter|week)|let me think|be in touch|will be in touch/i,
}

export function detectObjectionType(transcript: string): ObjectionType {
  const priority: Array<Exclude<ObjectionType, 'UNKNOWN' | 'HIDDEN_OBJECTION'>> = [
    'AGREEMENT', 'PRICE_OBJECTION', 'AUTHORITY', 'COMPETITOR', 'VALUE_DOUBT', 'STALLING',
  ]
  for (const type of priority) {
    if (INTENT_PATTERNS[type].test(transcript)) return type
  }
  return 'UNKNOWN'
}

// ── Answer detection ───────────────────────────────────────────────────────

const DODGE_PATTERNS = /\b(think|wait|later|not sure|maybe|hmm|possibly|we'?ll see|unsure|i don'?t know)\b/i

export function userAnswered(transcript: string): boolean {
  const trimmed = transcript.trim()
  if (trimmed.length < 12) return false
  if (DODGE_PATTERNS.test(trimmed)) return false
  return true
}

// ── Helpers ────────────────────────────────────────────────────────────────

function enforceWordLimit(text: string): string {
  const words = text.trim().split(/\s+/)
  return words.length > MAX_WORDS ? words.slice(0, MAX_WORDS).join(' ') : text.trim()
}

function pushHistory(window: string[], response: string): string[] {
  const updated = [...window, response]
  return updated.length > HISTORY_WINDOW ? updated.slice(-HISTORY_WINDOW) : updated
}

function pickVariant(bank: ObjectionBank, level: LadderLevel, recentResponses: string[]): string {
  const variants  = bank[level] as string[]
  const candidates = variants.filter(v => !recentResponses.includes(v))
  const pool      = candidates.length > 0 ? candidates : variants
  return pool[Math.floor(Math.random() * pool.length)]
}

// ── CoachSession ───────────────────────────────────────────────────────────

export class CoachSession {
  private state: CoachState = this.freshState()

  private freshState(): CoachState {
    return {
      level:            0,
      objectionType:    null,
      lastQuestion:     null,
      recentResponses:  [],
      answeredLast:     false,
      resistanceCount:  0,
      sameIntentTurns:  0,
      disqualified:     false,
      turnCount:        0,
    }
  }

  getState(): Readonly<CoachState> {
    return { ...this.state }
  }

  reset(): void {
    this.state = this.freshState()
  }

  process(transcript: string): CoachTurn {
    const s = this.state
    s.turnCount++

    // ── Already disqualified ───────────────────────────────────────────────
    if (s.disqualified) {
      const line = DISQUALIFY_LINES[s.turnCount % DISQUALIFY_LINES.length]
      return this.buildTurn(transcript, line, false, false, false, false)
    }

    const detected   = detectObjectionType(transcript)
    const answered   = userAnswered(transcript)
    let escalated    = false
    let reclassified = false

    // ── Intent routing ─────────────────────────────────────────────────────
    if (detected !== 'UNKNOWN') {
      if (detected !== s.objectionType) {
        // New or different objection type — restart ladder for this type
        s.objectionType   = detected
        s.level           = 0
        s.resistanceCount = 0
        s.sameIntentTurns = 0
      } else {
        // Same objection type repeated
        if (!answered) {
          s.sameIntentTurns++
          // Reclassify after N stale same-intent turns → switch to HIDDEN_OBJECTION playbook
          if (s.sameIntentTurns > RECLASSIFY_AFTER && s.objectionType !== 'HIDDEN_OBJECTION') {
            console.log(`[COACH] reclassifying ${s.objectionType} → HIDDEN_OBJECTION (${s.sameIntentTurns} stale turns)`)
            s.objectionType   = 'HIDDEN_OBJECTION'
            s.level           = 0
            s.sameIntentTurns = 0
            reclassified      = true
          }
        } else {
          s.sameIntentTurns = 0
        }
      }
    }

    // ── No signal at all ───────────────────────────────────────────────────
    // No detectable intent AND no prior conversation state → strategic silence.
    // This prevents firing noise into dead air.
    if (detected === 'UNKNOWN' && !s.objectionType) {
      console.log('[COACH] no signal, no prior state — strategic WAIT')
      return this.buildTurn(transcript, null, true, answered, false, false)
    }

    // ── Ladder advancement ─────────────────────────────────────────────────
    // Only advances if we have already asked a question (lastQuestion set).
    // First turn stays at level 0 — no advancement without a prior question.
    if (s.lastQuestion !== null) {
      s.answeredLast = answered
      if (answered) {
        s.level           = Math.min(s.level + 1, 4) as LadderLevel
        s.resistanceCount = 0
        escalated         = false
      } else {
        s.resistanceCount++
        s.level   = Math.min(s.level + 1, 4) as LadderLevel
        escalated = true

        if (s.resistanceCount >= MAX_RESISTANCE && s.level >= 4) {
          s.disqualified = true
        }
      }
    }

    // ── Ensure type is set ─────────────────────────────────────────────────
    if (!s.objectionType) s.objectionType = 'PRICE_OBJECTION'

    // ── Build response ─────────────────────────────────────────────────────
    let response: string
    if (s.disqualified) {
      response = DISQUALIFY_LINES[s.resistanceCount % DISQUALIFY_LINES.length]
    } else {
      const bank = RESPONSES[s.objectionType as Exclude<ObjectionType, 'UNKNOWN'>]
      response   = enforceWordLimit(pickVariant(bank, s.level, s.recentResponses))
    }

    s.lastQuestion    = response
    s.recentResponses = pushHistory(s.recentResponses, response)

    return this.buildTurn(transcript, response, false, answered, escalated, reclassified)
  }

  private buildTurn(
    input:        string,
    response:     string | null,
    wait:         boolean,
    answeredFlag: boolean,
    escalated:    boolean,
    reclassified: boolean,
  ): CoachTurn {
    const s = this.state
    return {
      input,
      response,
      wait,
      level:           s.level,
      levelName:       LEVEL_NAMES[s.level],
      objectionType:   s.objectionType ?? 'UNKNOWN',
      reclassified,
      userAnswered:    answeredFlag,
      escalated,
      disqualified:    s.disqualified,
      resistanceCount: s.resistanceCount,
    }
  }
}

// ── Singleton (one session per conversation) ───────────────────────────────

let _globalSession: CoachSession | null = null

export function getCoachSession(): CoachSession {
  if (!_globalSession) _globalSession = new CoachSession()
  return _globalSession
}

export function resetCoach(): void {
  _globalSession?.reset()
}

// ── Drop-in for decision.ts ────────────────────────────────────────────────
// Returns string to speak, or null for strategic silence.
// Caller MUST check for null and NOT call speak() when null.

export function coach(transcript: string): string | null {
  if (!transcript.trim()) return null
  const session = getCoachSession()
  const turn    = session.process(transcript)

  console.log(
    `[COACH] L${turn.level}/${turn.levelName}` +
    ` type=${turn.objectionType}` +
    `${turn.reclassified ? ' [RECLASSIFIED]' : ''}` +
    ` escalated=${turn.escalated}` +
    ` answered=${turn.userAnswered}` +
    ` wait=${turn.wait}` +
    ` — "${turn.response ?? 'SILENCE'}"`
  )

  return turn.wait ? null : turn.response
}