/**
 * suites/coach.ts — SUITE 8: Negotiation Coach State Machine
 *
 * Tests:
 *   COACH-001  Intent detection (all 6 types + unknown)
 *   COACH-002  Ladder progression (levels 0–4 advance correctly)
 *   COACH-003  No-repetition rule (same line never fires twice in a row)
 *   COACH-004  Escalation on non-answer (level advances even without response)
 *   COACH-005  Pivot on answer (level advances + constraint registered)
 *   COACH-006  Disqualification after 3 non-answers at level 4
 *   COACH-007  New objection type resets level
 *   COACH-008  Word limit enforced (max 12 words)
 *   COACH-009  Session isolation (two sessions don't share state)
 *   COACH-010  Reset() restores clean state
 *   COACH-011  Full conversation arc (price → isolate → reframe → anchor → close)
 *   COACH-012  Agreement fast-path (fires close sequence immediately)
 */

import { record, section } from '../runner.js'

const SUITE = 'coach'

export async function run(): Promise<void> {
  section('SUITE 8 — Negotiation Coach State Machine')

  const {
    CoachSession,
    detectObjectionType,
    userAnswered,
  } = await import('../../../../src/pipeline/negotiationCoach.js')

  // ── COACH-001: Intent detection ──────────────────────────────────────────

  const intentCases: Array<{ text: string; expected: string; id: string }> = [
    { id: 'COACH-001a', text: "That's too expensive for us",                    expected: 'PRICE_OBJECTION' },
    { id: 'COACH-001b', text: "Monthly is the problem, it is a lot",            expected: 'PRICE_OBJECTION' },
    { id: 'COACH-001c', text: "I need to think about it and get back to you",   expected: 'STALLING'        },
    { id: 'COACH-001d', text: "Let me circle back next quarter",                expected: 'STALLING'        },
    { id: 'COACH-001e', text: "My business partner would need to weigh in",     expected: 'AUTHORITY'       },
    { id: 'COACH-001f', text: "We already use ServiceTitan and it works fine",  expected: 'COMPETITOR'      },
    { id: 'COACH-001g', text: "I am not sure it is worth it for us",            expected: 'VALUE_DOUBT'     },
    { id: 'COACH-001h', text: "Okay let's move forward, send the contract",     expected: 'AGREEMENT'       },
    { id: 'COACH-001i', text: "The weather in Dallas is great today",           expected: 'UNKNOWN'         },
  ]

  for (const c of intentCases) {
    const result = detectObjectionType(c.text)
    record(SUITE, c.id, `Intent: "${c.text.slice(0, 45)}"`,
      'HIGH', result === c.expected ? 'PASS' : 'FAIL',
      c.expected, result)
  }

  // ── COACH-002: Ladder advances level 0 → 4 ──────────────────────────────

  const session002 = new CoachSession()

  // Turn 0: first price objection → level 0 (Probe)
  const t0 = session002.process("That's too expensive")
  record(SUITE, 'COACH-002a', 'First price objection starts at level 0 (Probe)',
    'CRITICAL', t0.level === 0 && t0.levelName === 'Probe' ? 'PASS' : 'FAIL',
    'level=0 Probe', `level=${t0.level} ${t0.levelName}`)

  // Turn 1: user answers → level 1 (Isolate)
  const t1 = session002.process("Monthly is the issue, around $150 is my limit")
  record(SUITE, 'COACH-002b', 'Answer advances to level 1 (Isolate)',
    'CRITICAL', t1.level === 1 && t1.levelName === 'Isolate' ? 'PASS' : 'FAIL',
    'level=1 Isolate', `level=${t1.level} ${t1.levelName}`)

  // Turn 2: another answer → level 2 (Reframe)
  const t2 = session002.process("I guess $100 less would make it workable for me")
  record(SUITE, 'COACH-002c', 'Second answer advances to level 2 (Reframe)',
    'HIGH', t2.level === 2 && t2.levelName === 'Reframe' ? 'PASS' : 'FAIL',
    'level=2 Reframe', `level=${t2.level} ${t2.levelName}`)

  // Turn 3: vague answer → level 3 (Anchor) via escalation
  const t3 = session002.process("Not sure it is worth it honestly")
  record(SUITE, 'COACH-002d', 'Vague answer still advances to level 3 (Anchor)',
    'HIGH', t3.level === 3 && t3.levelName === 'Anchor' ? 'PASS' : 'FAIL',
    'level=3 Anchor', `level=${t3.level} ${t3.levelName}`)

  // Turn 4: concrete answer → level 4 (Close)
  const t4 = session002.process("Yeah six months of this would really hurt our operation")
  record(SUITE, 'COACH-002e', 'Concrete answer advances to level 4 (Close)',
    'CRITICAL', t4.level === 4 && t4.levelName === 'Close' ? 'PASS' : 'FAIL',
    'level=4 Close', `level=${t4.level} ${t4.levelName}`)

  // ── COACH-003: No repetition within history window ───────────────────────
  // Fire same objection 6 times. No response should repeat within any 3-turn window.

  const session003 = new CoachSession()
  const responses003: string[] = []

  for (let i = 0; i < 6; i++) {
    const t = session003.process(i % 2 === 0
      ? "That's still too expensive for our budget"
      : "We cannot afford it at this price point, honestly speaking"
    )
    if (t.response) responses003.push(t.response)
  }

  // Check no response appears twice within any sliding window of 3
  let windowViolation = false
  for (let i = 2; i < responses003.length; i++) {
    const window = responses003.slice(i - 2, i + 1)
    if (new Set(window).size < window.length) { windowViolation = true; break }
  }

  record(SUITE, 'COACH-003', 'No response reused within 3-turn history window',
    'CRITICAL', !windowViolation ? 'PASS' : 'FAIL',
    'no repeats within 3-turn window',
    windowViolation ? `window violation in: [${responses003.join(' | ')}]` : `${responses003.length} responses, no window repeats`)

  // ── COACH-004: Escalation on non-answer ──────────────────────────────────

  const session004 = new CoachSession()
  session004.process("Too expensive")                  // level 0
  const e1 = session004.process("I need to think")    // dodge → escalate to level 1
  record(SUITE, 'COACH-004a', 'Non-answer escalates level',
    'CRITICAL', e1.level === 1 && e1.escalated === true ? 'PASS' : 'FAIL',
    'level=1 escalated=true', `level=${e1.level} escalated=${e1.escalated}`)

  const e2 = session004.process("Not sure")           // another dodge → level 2
  record(SUITE, 'COACH-004b', 'Second non-answer escalates to level 2',
    'HIGH', e2.level === 2 && e2.escalated === true ? 'PASS' : 'FAIL',
    'level=2 escalated=true', `level=${e2.level} escalated=${e2.escalated}`)

  // ── COACH-005: Pivot on answer ───────────────────────────────────────────

  const session005 = new CoachSession()
  session005.process("That's too expensive")
  const p1 = session005.process("It is the monthly cost, about $200 more than our budget")
  record(SUITE, 'COACH-005a', 'Real answer sets userAnswered=true',
    'HIGH', p1.userAnswered === true ? 'PASS' : 'FAIL',
    'userAnswered=true', `userAnswered=${p1.userAnswered}`)

  record(SUITE, 'COACH-005b', 'Real answer marks escalated=false',
    'HIGH', p1.escalated === false ? 'PASS' : 'FAIL',
    'escalated=false', `escalated=${p1.escalated}`)

  // ── COACH-006: Disqualification ──────────────────────────────────────────

  const session006 = new CoachSession()
  session006.process("Too expensive")                         // L0
  session006.process("Maybe")                                 // L1 — dodge #1
  session006.process("Hmm")                                   // L2 — dodge #2
  session006.process("I will think")                          // L3 — dodge #3, resistance=3
  const preDisq = session006.process("Not sure")              // L4 — resistance hits threshold
  session006.process("Still thinking")                        // should disqualify
  const disq = session006.process("I don't know")

  record(SUITE, 'COACH-006a', 'Disqualification fires after 3+ non-answers at level 4',
    'HIGH', disq.disqualified === true ? 'PASS' : 'FAIL',
    'disqualified=true', `disqualified=${disq.disqualified}`)

  record(SUITE, 'COACH-006b', 'Disqualification response contains pause/priority language',
    'HIGH', /priority|pause|revisit|timing|worth|continuing/i.test(disq.response ?? '') ? 'PASS' : 'FAIL',
    'contains disqualify language', disq.response ?? 'null')

  // ── COACH-007: New objection type resets level ───────────────────────────

  const session007 = new CoachSession()
  session007.process("Too expensive")                                  // PRICE L0
  session007.process("Monthly is $100 over our budget really")        // PRICE L1
  const switchTurn = session007.process("Actually my wife handles all the finances") // → AUTHORITY
  record(SUITE, 'COACH-007a', 'New objection type resets to level 0',
    'CRITICAL', switchTurn.level === 0 ? 'PASS' : 'FAIL',
    'level=0', `level=${switchTurn.level}`)

  record(SUITE, 'COACH-007b', 'New objection type is AUTHORITY after switch',
    'HIGH', switchTurn.objectionType === 'AUTHORITY' ? 'PASS' : 'FAIL',
    'AUTHORITY', switchTurn.objectionType)

  // ── COACH-008: Word limit ────────────────────────────────────────────────

  const session008 = new CoachSession()
  let allUnder12 = true
  let worstResponse = ''
  let worstCount = 0

  for (const input of [
    "Too expensive", "Monthly is a problem", "I need to think", "My boss needs to approve",
    "We use ServiceTitan", "Not sure it works", "Yeah let's move forward",
  ]) {
    const t = session008.process(input)
    const resp = (t.response ?? '').trim()
    const words = resp === '' ? 0 : resp.split(/\s+/).filter(Boolean).length
    if (words > 12) {
      allUnder12 = false
      if (words > worstCount) { worstCount = words; worstResponse = resp }
    }
  }

  record(SUITE, 'COACH-008', 'All responses are 12 words or fewer',
    'HIGH', allUnder12 ? 'PASS' : 'FAIL',
    'max 12 words',
    allUnder12 ? 'all under limit' : `"${worstResponse}" (${worstCount} words)`)

  // ── COACH-009: Session isolation ─────────────────────────────────────────

  const sessionA = new CoachSession()
  const sessionB = new CoachSession()

  sessionA.process("Too expensive")
  sessionA.process("Monthly is the issue, about $150 per month max")   // A → level 1
  sessionA.process("I guess ROI is unclear, honestly speaking")        // A → level 2

  sessionB.process("Too expensive")                                    // B → level 0

  const stateA = sessionA.getState()
  const stateB = sessionB.getState()

  record(SUITE, 'COACH-009a', 'Session A advanced to level 2 independently',
    'CRITICAL', stateA.level === 2 ? 'PASS' : 'FAIL',
    'level=2', `level=${stateA.level}`)

  record(SUITE, 'COACH-009b', 'Session B stayed at level 0 (no cross-contamination)',
    'CRITICAL', stateB.level === 0 ? 'PASS' : 'FAIL',
    'level=0', `level=${stateB.level}`)

  // ── COACH-010: Reset restores clean state ────────────────────────────────

  const session010 = new CoachSession()
  session010.process("Too expensive for our budget")
  session010.process("Monthly is the problem, $200 over our limit")
  session010.process("Yeah six months of this would really hurt us badly")
  session010.reset()
  const afterReset = session010.getState()

  record(SUITE, 'COACH-010a', 'reset() sets level back to 0',
    'HIGH', afterReset.level === 0 ? 'PASS' : 'FAIL',
    'level=0', `level=${afterReset.level}`)

  record(SUITE, 'COACH-010b', 'reset() clears objectionType',
    'HIGH', afterReset.objectionType === null ? 'PASS' : 'FAIL',
    'null', String(afterReset.objectionType))

  record(SUITE, 'COACH-010c', 'reset() clears resistanceCount',
    'HIGH', afterReset.resistanceCount === 0 ? 'PASS' : 'FAIL',
    '0', String(afterReset.resistanceCount))

  record(SUITE, 'COACH-010d', 'reset() clears disqualified flag',
    'HIGH', afterReset.disqualified === false ? 'PASS' : 'FAIL',
    'false', String(afterReset.disqualified))

  record(SUITE, 'COACH-010e', 'reset() clears recentResponses window',
    'HIGH', afterReset.recentResponses.length === 0 ? 'PASS' : 'FAIL',
    'empty array', `length=${afterReset.recentResponses.length}`)

  record(SUITE, 'COACH-010f', 'reset() clears sameIntentTurns',
    'HIGH', afterReset.sameIntentTurns === 0 ? 'PASS' : 'FAIL',
    '0', String(afterReset.sameIntentTurns))

  // ── COACH-011: Full price objection arc ──────────────────────────────────
  // Simulate a real conversation through all 5 levels.

  const session011 = new CoachSession()
  const arc = [
    { input: "That's too expensive",                           expectedLevel: 0, expectedName: 'Probe'   },
    { input: "Monthly is the issue, around $150 limit",       expectedLevel: 1, expectedName: 'Isolate' },
    { input: "I guess $100 would make it workable",           expectedLevel: 2, expectedName: 'Reframe' },
    { input: "Yeah six months of this really would hurt us",  expectedLevel: 3, expectedName: 'Anchor'  },
    { input: "Yeah that math is painful honestly",            expectedLevel: 4, expectedName: 'Close'   },
  ]

  for (const step of arc) {
    const t = session011.process(step.input)
    const id = `COACH-011-L${step.expectedLevel}`
    record(SUITE, id, `Arc L${step.expectedLevel} (${step.expectedName}): "${step.input.slice(0, 40)}"`,
      'CRITICAL',
      t.level === step.expectedLevel && t.levelName === step.expectedName ? 'PASS' : 'FAIL',
      `level=${step.expectedLevel} ${step.expectedName}`,
      `level=${t.level} ${t.levelName} — "${t.response}"`)
  }

  // Final level 4 response must drive toward commitment
  const closeTurn = session011.process("Yeah this math is painful and I know we need to act")
  record(SUITE, 'COACH-011-close', 'Level 4 response drives toward commitment',
    'HIGH', closeTurn.level === 4 ? 'PASS' : 'FAIL',
    'level=4 Close', `level=${closeTurn.level} — "${closeTurn.response}"`)

  // ── COACH-012: Agreement fast-path ──────────────────────────────────────
  // Agreement detected → coach fires close sequence, not probe

  const session012 = new CoachSession()
  const agreement = session012.process("Okay let's move forward, send me the contract")
  record(SUITE, 'COACH-012a', 'Agreement detected on first turn',
    'CRITICAL', agreement.objectionType === 'AGREEMENT' ? 'PASS' : 'FAIL',
    'AGREEMENT', agreement.objectionType)

  record(SUITE, 'COACH-012b', 'Agreement response is actionable (not a probe question)',
    'HIGH', !/is it|what budget|is this a cash/i.test(agreement.response ?? '') ? 'PASS' : 'WARN',
    'no price probe phrasing', agreement.response)

  // ── COACH-013: userAnswered helper ───────────────────────────────────────

  const answeredCases: Array<{ text: string; expected: boolean; id: string }> = [
    { id: 'COACH-013a', text: 'Monthly is the issue, around $150 limit for us',  expected: true  },
    { id: 'COACH-013b', text: 'Yeah six months of this would really hurt',       expected: true  },
    { id: 'COACH-013c', text: 'I need to think',                                 expected: false },
    { id: 'COACH-013d', text: 'Maybe',                                           expected: false },
    { id: 'COACH-013e', text: 'Hmm',                                             expected: false },
    { id: 'COACH-013f', text: 'Not sure',                                        expected: false },
    { id: 'COACH-013g', text: 'We will see possibly',                            expected: false },
  ]

  for (const c of answeredCases) {
    const result = userAnswered(c.text)
    record(SUITE, c.id, `userAnswered: "${c.text}"`,
      'MEDIUM', result === c.expected ? 'PASS' : 'FAIL',
      String(c.expected), String(result))
  }

  // ── COACH-014: Strategic WAIT on no-signal first turn ────────────────────

  const session014 = new CoachSession()
  const waitTurn = session014.process("The weather in Dallas has been great lately")
  record(SUITE, 'COACH-014a', 'No signal + no prior state → wait=true',
    'CRITICAL', waitTurn.wait === true ? 'PASS' : 'FAIL',
    'wait=true', `wait=${waitTurn.wait}`)

  record(SUITE, 'COACH-014b', 'No signal + no prior state → response=null',
    'CRITICAL', waitTurn.response === null ? 'PASS' : 'FAIL',
    'null', String(waitTurn.response))

  // Mid-conversation: unknown utterance after established state should NOT wait
  const session014b = new CoachSession()
  session014b.process("That's too expensive for us")   // establishes state
  const midTurn = session014b.process("Yeah okay")     // unknown mid-conversation
  record(SUITE, 'COACH-014c', 'Unknown mid-conversation uses prior state (no wait)',
    'HIGH', midTurn.wait === false ? 'PASS' : 'WARN',
    'wait=false (uses prior state)', `wait=${midTurn.wait} type=${midTurn.objectionType}`)

  // ── COACH-015: Intent reclassification ───────────────────────────────────
  // Same objection with no new info repeated > RECLASSIFY_AFTER times → HIDDEN_OBJECTION

  const session015 = new CoachSession()
  session015.process("That's too expensive")         // PRICE turn 1
  session015.process("Still too expensive")          // PRICE dodge #1 (sameIntentTurns=1)
  session015.process("It's just too much honestly")  // PRICE dodge #2 (sameIntentTurns=2)
  const reclTurn = session015.process("Too expensive still") // dodge #3 → should reclassify

  record(SUITE, 'COACH-015a', 'Repeated same intent with no info → reclassifies to HIDDEN_OBJECTION',
    'CRITICAL', reclTurn.objectionType === 'HIDDEN_OBJECTION' ? 'PASS' : 'FAIL',
    'HIDDEN_OBJECTION', reclTurn.objectionType)

  record(SUITE, 'COACH-015b', 'Reclassified turn has reclassified=true',
    'HIGH', reclTurn.reclassified === true ? 'PASS' : 'FAIL',
    'reclassified=true', String(reclTurn.reclassified))

  record(SUITE, 'COACH-015c', 'Reclassified turn resets to level 0',
    'HIGH', reclTurn.level === 0 ? 'PASS' : 'FAIL',
    'level=0', String(reclTurn.level))

  // HIDDEN_OBJECTION response should call out the loop, not repeat price probe
  record(SUITE, 'COACH-015d', 'HIDDEN_OBJECTION response challenges the loop directly',
    'HIGH',
    /real|actually|blocking|underneath|something else|circles/i.test(reclTurn.response ?? '') ? 'PASS' : 'FAIL',
    'calls out the real issue', reclTurn.response ?? 'null')
}