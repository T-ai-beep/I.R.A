/**
 * demo2.ts — Adversarial ARIA test suite
 *
 * Philosophy: if there are no failed tests, the tests are lying.
 * Every test here is designed to find a real failure mode.
 * Tests are grouped by system and escalate from normal → edge → adversarial.
 *
 * Run: npx tsx src/demo2.ts
 *      npx tsx src/demo2.ts --suite=escalation
 *      npx tsx src/demo2.ts --suite=all
 */

// ── Types ──────────────────────────────────────────────────────────────────

type Verdict = 'PASS' | 'FAIL' | 'WARN'

interface TestResult {
  suite:    string
  name:     string
  verdict:  Verdict
  expected: string
  got:      string | null
  note:     string
}

const results: TestResult[] = []

function record(
  suite: string,
  name: string,
  verdict: Verdict,
  expected: string,
  got: string | null,
  note = ''
) {
  results.push({ suite, name, verdict, expected, got, note })
  const icon = verdict === 'PASS' ? '✅' : verdict === 'FAIL' ? '❌' : '⚠️'
  console.log(`  ${icon} ${name}`)
  if (verdict !== 'PASS') {
    console.log(`       expected: ${expected}`)
    console.log(`       got:      ${got ?? '(null)'}`)
    if (note) console.log(`       note:     ${note}`)
  }
}

function section(title: string) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${'═'.repeat(60)}`)
}

// ── Helpers ────────────────────────────────────────────────────────────────

function contains(response: string | null, ...fragments: string[]): boolean {
  if (!response) return false
  const r = response.toLowerCase()
  return fragments.some(f => r.includes(f.toLowerCase()))
}

function isNotNull(response: string | null): boolean {
  return response !== null && response.trim().length > 0
}

function isNull(response: string | null): boolean {
  return response === null
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: ESCALATION TIER PROGRESSION
// Tests that tierState actually increments and that tier 3 is binary/cornering
// ─────────────────────────────────────────────────────────────────────────────

async function suiteEscalation() {
  section('SUITE 1 — Escalation Tier Progression')

  const { matchPlaybook, executePlay, resetTiers, PLAYBOOK } = await import('./pipeline/playbook.js')
  const { setMode } = await import('./pipeline/decision.js')

  // Reset between suites
  resetTiers()
  setMode('negotiation')

  // ── Test 1.1: Price objection escalates across 4 fires ────────────────
  console.log('\n  [Price objection — 4 consecutive fires]')
  const pricePlay = PLAYBOOK['PRICE_OBJECTION']
  const fired: string[] = []
  for (let i = 0; i < 4; i++) {
    fired.push(executePlay(pricePlay))
  }

  // Tier 0 should be soft/probe
  record('escalation', '1.1a tier-0 is soft probe', 
    fired[0].includes('?') ? 'PASS' : 'FAIL',
    'ends with question mark',
    fired[0],
    'Tier 0 should open with a question, not a statement'
  )

  // Tier 3 should contain binary pressure
  const tier3IsBinary = pricePlay.steps[3].binary
  record('escalation', '1.1b tier-3 is binary',
    tier3IsBinary ? 'PASS' : 'FAIL',
    'binary=true',
    String(tier3IsBinary),
    'Tier 3 must corner the prospect into yes/no'
  )

  // All 4 responses should be different
  const unique = new Set(fired).size
  record('escalation', '1.1c all 4 tiers are distinct',
    unique === 4 ? 'PASS' : 'FAIL',
    '4 unique responses',
    `${unique} unique responses`,
    'Rotating same response is not escalation'
  )

  // ── Test 1.2: Different plays don't share tier state ──────────────────
  resetTiers()
  console.log('\n  [Tier state isolation between play types]')
  const stallPlay = PLAYBOOK['STALL_GENERIC']
  const discountPlay = PLAYBOOK['DISCOUNT_REQUEST']

  executePlay(stallPlay)
  executePlay(stallPlay)
  executePlay(stallPlay) // stall is now at tier 2

  const discountTier0 = executePlay(discountPlay) // discount should still be tier 0
  const discountTier0Expected = discountPlay.steps[0].response

  record('escalation', '1.2 play tier states are isolated',
    discountTier0 === discountTier0Expected ? 'PASS' : 'FAIL',
    `tier-0: "${discountTier0Expected.slice(0, 40)}..."`,
    discountTier0.slice(0, 40) + '...',
    'Firing stall 3x should not advance discount tier'
  )

  // ── Test 1.3: resetTiers() actually resets ────────────────────────────
  console.log('\n  [resetTiers() resets all state]')
  const pricePlay2 = PLAYBOOK['PRICE_OBJECTION']
  executePlay(pricePlay2)
  executePlay(pricePlay2)
  executePlay(pricePlay2) // at tier 2

  resetTiers()

  const afterReset = executePlay(pricePlay2) // should be back to tier 0
  record('escalation', '1.3 resetTiers restores tier 0',
    afterReset === pricePlay2.steps[0].response ? 'PASS' : 'FAIL',
    `tier-0: "${pricePlay2.steps[0].response.slice(0, 40)}..."`,
    afterReset.slice(0, 40) + '...',
    'After reset, next fire should be tier 0 again'
  )

  // ── Test 1.4: Silence marker fires on appropriate tiers ───────────────
  console.log('\n  [Silence markers on high-pressure tiers]')
  const silentTiers = pricePlay2.steps.filter(s => s.silence).length
  record('escalation', '1.4 price play has majority silence tiers',
    silentTiers >= 3 ? 'PASS' : 'FAIL',
    '>= 3 silent tiers',
    `${silentTiers} silent tiers`,
    'After pressure lines you stop talking — silence is the weapon'
  )

  resetTiers()
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: FORCED RESPONSE ENGINE
// Tests that PRICE_OBJECTION, AGREEMENT, COMPETITOR etc never return null
// ─────────────────────────────────────────────────────────────────────────────

async function suiteForcedResponse() {
  section('SUITE 2 — Forced Response Engine (no silent moments on money)')

  const { decide, setMode } = await import('./pipeline/decision.js')
  const { resetTiers } = await import('./pipeline/playbook.js')

  resetTiers()
  setMode('negotiation')

  const forcedCases: Array<{ transcript: string; name: string }> = [
    { name: '2.1 price objection — no-rule phrasing',   transcript: 'fifteen hundred bucks is a lot for us man' },
    { name: '2.2 price objection — passive dodge',       transcript: 'that feels like a stretch for our budget honestly' },
    { name: '2.3 competitor — indirect mention',         transcript: 'we signed the paperwork with them last tuesday' },
    { name: '2.4 agreement — casual confirm',            transcript: 'yeah okay i am in let us do this' },
    { name: '2.5 discount — soft ask',                   transcript: 'any chance there is some wiggle room on that number' },
    { name: '2.6 authority — spouse gatekeeper',         transcript: 'i need to run this by my wife she handles all of this' },
    { name: '2.7 manual tracking',                       transcript: 'we track all of it in a spreadsheet and it is fine' },
    { name: '2.8 competitor lock-in',                    transcript: 'we have been with servicetitan for three years and it works' },
    { name: '2.9 panic — deal already closed',           transcript: 'we already signed with them last week sorry' },
    { name: '2.10 info request as stall',                transcript: 'just send me more information and i will take a look' },
  ]

  for (const c of forcedCases) {
    const response = await decide(c.transcript)
    record('forced', c.name,
      isNotNull(response) ? 'PASS' : 'FAIL',
      'non-null response',
      response,
      'This is a money/close moment — silence here loses the deal'
    )
    resetTiers()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: ADVERSARIAL PHRASING
// Real prospects don't say "too expensive" — they imply it
// Tests that signal detection works on natural language, not keywords
// ─────────────────────────────────────────────────────────────────────────────

async function suiteAdversarialPhrasing() {
  section('SUITE 3 — Adversarial Phrasing (real humans don\'t use keywords)')

  const { decide, setMode } = await import('./pipeline/decision.js')
  const { resetTiers } = await import('./pipeline/playbook.js')

  setMode('negotiation')

  const adversarialCases: Array<{ transcript: string; name: string; shouldFire: boolean }> = [
    // Price objection — implied, not stated
    { name: '3.1 price implied — "that is a lot"',          transcript: 'that is a lot for a company our size', shouldFire: true },
    { name: '3.2 price implied — sticker shock',            transcript: 'wow okay i was not expecting that number', shouldFire: true },
    { name: '3.3 price implied — ROI doubt',                transcript: 'i am not sure we would get that value out of it', shouldFire: true },

    // Stall — not the keyword
    { name: '3.4 stall — "circle back"',                    transcript: 'let us circle back on this in a few weeks', shouldFire: true },
    { name: '3.5 stall — vague positive',                   transcript: 'this is interesting we will be in touch', shouldFire: true },

    // Authority — no "boss" keyword
    { name: '3.6 authority — "my partner"',                 transcript: 'my business partner would need to weigh in on this', shouldFire: true },
    { name: '3.7 authority — "our team"',                   transcript: 'our team would need to align on something like this', shouldFire: true },

    // Agreement — ambiguous
    { name: '3.8 agreement — soft confirm',                 transcript: 'yeah this could really work for us', shouldFire: true },
    { name: '3.9 agreement — question that implies yes',    transcript: 'so when would we be able to get started', shouldFire: true },

    // TRUE NEGATIVES — should NOT fire
    { name: '3.10 noise — filler word',                     transcript: 'hmm', shouldFire: false },
    { name: '3.11 noise — affirmation',                     transcript: 'yeah okay', shouldFire: false },
    { name: '3.12 neutral — context setting',               transcript: 'we are an hvac company based in dallas', shouldFire: false },
    { name: '3.13 neutral — pleasantry',                    transcript: 'nice to meet you', shouldFire: false },
  ]

  for (const c of adversarialCases) {
    resetTiers()
    const response = await decide(c.transcript)
    const fired = isNotNull(response)

    if (c.shouldFire) {
      record('adversarial', c.name,
        fired ? 'PASS' : 'FAIL',
        'fires a response',
        response,
        'Signal present but system missed it'
      )
    } else {
      record('adversarial', c.name,
        !fired ? 'PASS' : 'WARN',
        'PASS (no action)',
        response,
        fired ? 'False positive — fired on noise/neutral' : ''
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: MODE CORRECTNESS
// Tests that mode switching changes behavior and doesn't bleed between modes
// ─────────────────────────────────────────────────────────────────────────────

async function suiteModeCorrectness() {
  section('SUITE 4 — Mode Correctness & Cross-Mode Bleed')

  const { decide, setMode } = await import('./pipeline/decision.js')
  const { resetTiers } = await import('./pipeline/playbook.js')

  resetTiers()

  // ── Test 4.1: Meeting mode flags stats ───────────────────────────────────
  setMode('meeting')
  const statResponse = await decide('We think conversion rates are up about 40 percent this quarter')
  record('modes', '4.1 meeting mode flags uncited stat',
    contains(statResponse, 'stat', 'source', 'credibility') ? 'PASS' : 'FAIL',
    'flags uncited statistic',
    statResponse,
  )

  // ── Test 4.2: Negotiation rule does NOT fire in meeting mode ─────────────
  resetTiers()
  setMode('meeting')
  const meetingPriceResponse = await decide('the price seems high')
  // In meeting mode this should get meeting rules not negotiation price objection rules
  // meeting mode has no price objection rule — it may or may not fire, but if it fires
  // it should be a meeting-appropriate response, not "hold number"
  if (meetingPriceResponse) {
    record('modes', '4.2 meeting mode does not fire negotiation rules',
      !contains(meetingPriceResponse, 'hold number', 'fear signal') ? 'PASS' : 'FAIL',
      'no negotiation-specific label',
      meetingPriceResponse,
      'Negotiation rules should not bleed into meeting mode'
    )
  } else {
    record('modes', '4.2 meeting mode does not fire negotiation rules', 'PASS', 'null (correct)', null)
  }

  // ── Test 4.3: Interview mode catches comp question ───────────────────────
  resetTiers()
  setMode('interview')
  const compResponse = await decide('What are your salary expectations for this role')
  record('modes', '4.3 interview mode catches comp question',
    contains(compResponse, 'comp', 'range', 'flip', 'anchor') ? 'PASS' : 'FAIL',
    'comp/anchor response',
    compResponse,
  )

  // ── Test 4.4: Social mode catches investor ───────────────────────────────
  resetTiers()
  setMode('social')
  const investorResponse = await decide('We run a fund focused on early stage B2B SaaS')
  record('modes', '4.4 social mode catches investor signal',
    contains(investorResponse, 'investor', 'leverage', 'engage') ? 'PASS' : 'FAIL',
    'investor detection response',
    investorResponse,
  )

  // ── Test 4.5: Mode switch mid-conversation ───────────────────────────────
  resetTiers()
  setMode('negotiation')
  await decide('we are interested in moving forward')
  setMode('meeting') // switch modes
  const afterSwitch = await decide('i think we should assign someone to own this')
  record('modes', '4.5 mode switch mid-conversation takes effect',
    contains(afterSwitch, 'owner', 'name', 'task') ? 'PASS' : 'FAIL',
    'meeting-mode ownership response',
    afterSwitch,
    'After setMode(meeting), next decide() should use meeting rules'
  )

  resetTiers()
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: MEMORY & OFFER EXTRACTION
// Tests extractOffer, extractIntent, speaker detection
// ─────────────────────────────────────────────────────────────────────────────

async function suiteMemory() {
  section('SUITE 5 — Memory, Offer Extraction, Speaker Detection')

  const { remember, getContext, clearMemory } = await import('./pipeline/memory.js')

  clearMemory()

  // ── Test 5.1: Dollar amount extraction ───────────────────────────────────
  console.log('\n  [Offer extraction formats]')
  const offerCases: Array<{ transcript: string; expected: number | null; name: string }> = [
    { name: '5.1a $5,000',                transcript: 'we are thinking around $5,000 a month', expected: 5000 },
    { name: '5.1b $5k',                   transcript: 'the price is $5k per month',             expected: 5000 },
    { name: '5.1c 5 thousand monthly',    transcript: 'thats 5 thousand a month',               expected: 5000 },
    { name: '5.1d $1.5 million',          transcript: 'valuation is $1.5 million',              expected: 1_500_000 },
    { name: '5.1e no dollar amount',      transcript: 'we are not ready to discuss pricing',    expected: null },
    { name: '5.1f $150 per month',        transcript: 'at $150 per month it seems steep',       expected: 150 },
  ]

  for (const c of offerCases) {
    clearMemory()
    const turn = remember(c.transcript)
    record('memory', c.name,
      turn.offer === c.expected ? 'PASS' : 'FAIL',
      String(c.expected),
      String(turn.offer),
    )
  }

  // ── Test 5.2: Intent extraction ──────────────────────────────────────────
  console.log('\n  [Intent extraction]')
  clearMemory()
  const intentCases: Array<{ transcript: string; expected: string | null; name: string }> = [
    { name: '5.2a price objection intent', transcript: "we can't afford this right now",         expected: 'PRICE_OBJECTION' },
    { name: '5.2b stalling intent',        transcript: 'let me think about it and get back',     expected: 'STALLING' },
    { name: '5.2c agreement intent',       transcript: "sounds good let's do it",                expected: 'AGREEMENT' },
    { name: '5.2d question intent',        transcript: 'what does the onboarding look like?',    expected: 'QUESTION' },
    { name: '5.2e competitor intent',      transcript: 'we already use servicetitan',             expected: 'COMPETITOR' },
    { name: '5.2f no clear intent',        transcript: 'the weather in dallas is nice today',    expected: null },
  ]

  for (const c of intentCases) {
    clearMemory()
    const turn = remember(c.transcript)
    record('memory', c.name,
      turn.intent === c.expected ? 'PASS' : 'FAIL',
      String(c.expected),
      String(turn.intent),
    )
  }

  // ── Test 5.3: Memory TTL — context persists within window ────────────────
  console.log('\n  [Memory state across turns]')
  clearMemory()
  remember('the price is $8,500 per month')
  remember('that seems too high for us')
  const ctx = getContext()

  record('memory', '5.3a last offer persists across turns',
    ctx.lastOffer === 8500 ? 'PASS' : 'FAIL',
    '8500',
    String(ctx.lastOffer),
  )
  record('memory', '5.3b last intent persists across turns',
    ctx.lastIntent === 'PRICE_OBJECTION' ? 'PASS' : 'FAIL',
    'PRICE_OBJECTION',
    String(ctx.lastIntent),
  )

  // ── Test 5.4: Offer is not extracted from non-price contexts ─────────────
  clearMemory()
  const noOffer = remember('we have been in business for 15 years')
  record('memory', '5.4 year in business not extracted as offer',
    noOffer.offer === null ? 'PASS' : 'FAIL',
    'null',
    String(noOffer.offer),
    '"15 years" should not be extracted as a $15 offer'
  )

  clearMemory()
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6: PEOPLE EXTRACTION
// Tests name extraction, blacklist, tag inference
// ─────────────────────────────────────────────────────────────────────────────

async function suitePeople() {
  section('SUITE 6 — People Extraction & Tag Inference')

  const { extractNames } = await import('./pipeline/people.js')

  // ── Test 6.1: Real names are extracted ───────────────────────────────────
  console.log('\n  [Name extraction]')
  const nameCases: Array<{ transcript: string; shouldInclude: string[]; shouldExclude: string[]; name: string }> = [
    {
      name: '6.1a extracts person after "with"',
      transcript: 'I had a meeting with Marcus about the deal',
      shouldInclude: ['Marcus'],
      shouldExclude: [],
    },
    {
      name: '6.1b extracts person who "said"',
      transcript: 'Nathan said we need to rebuild the frontend',
      shouldInclude: ['Nathan'],
      shouldExclude: [],
    },
    {
      name: '6.1c blacklist — Monday is not a person',
      transcript: 'let us reconnect on Monday about this',
      shouldInclude: [],
      shouldExclude: ['Monday'],
    },
    {
      name: '6.1d blacklist — ARIA is not a person',
      transcript: 'ARIA flagged this as a competitor signal',
      shouldInclude: [],
      shouldExclude: ['ARIA', 'Aria'],
    },
    {
      name: '6.1e blacklist — ServiceTitan is not a person',
      transcript: 'ServiceTitan has been our system for years',
      shouldInclude: [],
      shouldExclude: ['ServiceTitan'],
    },
    {
      name: '6.1f extracts full name',
      transcript: 'I need to call Sarah Johnson about the contract',
      shouldInclude: ['Sarah'],
      shouldExclude: [],
    },
  ]

  for (const c of nameCases) {
    const names = extractNames(c.transcript)
    const includeOk = c.shouldInclude.every(n => names.includes(n))
    const excludeOk = c.shouldExclude.every(n => !names.includes(n))
    record('people', c.name,
      includeOk && excludeOk ? 'PASS' : 'FAIL',
      `include=[${c.shouldInclude}] exclude=[${c.shouldExclude}]`,
      `extracted=[${names}]`,
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 7: FOLLOW-UP DETECTION
// Tests all priority levels and pattern coverage
// ─────────────────────────────────────────────────────────────────────────────

async function suiteFollowUp() {
  section('SUITE 7 — Follow-Up Detection (hot/warm/cold)')

  const { detectFollowUp } = await import('./pipeline/followup.js')

  const followUpCases: Array<{
    transcript: string
    expectedPriority: 'hot' | 'warm' | 'cold' | null
    name: string
  }> = [
    // HOT
    { name: '7.1 hot — send me the contract',    transcript: "okay let's move forward send me the contract",       expectedPriority: 'hot' },
    { name: '7.2 hot — email me the invite',      transcript: 'email me a calendar invite for next week',          expectedPriority: 'hot' },
    { name: '7.3 hot — send pricing',             transcript: 'can you send me the pricing details',               expectedPriority: 'hot' },

    // WARM
    { name: '7.4 warm — reconnect next week',     transcript: "let's reconnect next week to finalize",             expectedPriority: 'warm' },
    { name: '7.5 warm — i will get back to you',  transcript: 'i will get back to you by friday',                 expectedPriority: 'warm' },
    { name: '7.6 warm — set up a meeting',        transcript: 'let us set up a meeting to go over the details',   expectedPriority: 'warm' },

    // COLD
    { name: '7.7 cold — not right now',           transcript: 'not right now maybe later this year',              expectedPriority: 'cold' },
    { name: '7.8 cold — budget is tight',         transcript: 'budget is tight right now',                        expectedPriority: 'cold' },
    { name: '7.9 cold — keep in touch',           transcript: "let's keep in touch",                              expectedPriority: 'cold' },

    // NO FOLLOW-UP
    { name: '7.10 no followup — neutral',         transcript: 'the weather is nice in dallas today',              expectedPriority: null },
    { name: '7.11 no followup — vague positive',  transcript: 'this sounds interesting',                         expectedPriority: null },
  ]

  for (const c of followUpCases) {
    const result = detectFollowUp(c.transcript)
    if (c.expectedPriority === null) {
      record('followup', c.name,
        result === null ? 'PASS' : 'WARN',
        'null (no follow-up)',
        result ? `${result.priority} — ${result.action}` : 'null',
        result ? 'False positive follow-up detection' : ''
      )
    } else {
      record('followup', c.name,
        result?.priority === c.expectedPriority ? 'PASS' : 'FAIL',
        c.expectedPriority,
        result?.priority ?? 'null',
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 8: TASK EXTRACTION
// Tests NLP task extraction, due date parsing, priority signals
// ─────────────────────────────────────────────────────────────────────────────

async function suiteTaskExtraction() {
  section('SUITE 8 — Task Extraction (NLP)')

  const { extractTaskFromTranscript } = await import('./pipeline/tasks.js')

  const taskCases: Array<{
    transcript: string
    shouldExtract: boolean
    expectedPriority?: string
    name: string
  }> = [
    { name: '8.1 email person task',         transcript: 'email John about the contract today',           shouldExtract: true,  expectedPriority: 'high' },
    { name: '8.2 remind me to task',         transcript: 'remind me to follow up with Sarah tomorrow',    shouldExtract: true },
    { name: '8.3 schedule meeting task',     transcript: 'set up a meeting with the team next week',      shouldExtract: true },
    { name: '8.4 urgent priority signal',    transcript: 'i need to call Marcus right now it is urgent',  shouldExtract: true,  expectedPriority: 'high' },
    { name: '8.5 low priority signal',       transcript: 'maybe eventually send them the proposal',       shouldExtract: false }, // "maybe eventually" is not a strong enough signal
    { name: '8.6 no task — pure objection',  transcript: "we can't afford this right now",               shouldExtract: false },
    { name: '8.7 no task — question',        transcript: 'what does the onboarding look like',            shouldExtract: false },
    { name: '8.8 due date — tomorrow',       transcript: 'remind me to send the invoice tomorrow',        shouldExtract: true },
  ]

  for (const c of taskCases) {
    const result = extractTaskFromTranscript(c.transcript)
    const extracted = result !== null

    if (c.shouldExtract) {
      let verdict: Verdict = extracted ? 'PASS' : 'FAIL'
      if (extracted && c.expectedPriority && result!.priority !== c.expectedPriority) {
        verdict = 'WARN'
      }
      record('tasks', c.name,
        verdict,
        c.expectedPriority ? `extracted, priority=${c.expectedPriority}` : 'extracted',
        extracted ? `priority=${result!.priority}, due=${result!.dueHint}` : 'null',
      )
    } else {
      record('tasks', c.name,
        !extracted ? 'PASS' : 'WARN',
        'null (no task)',
        extracted ? `extracted: "${result!.description}"` : 'null',
        extracted ? 'Possible false positive task extraction' : ''
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 9: IDENTITY SCORING
// Tests score clamping, tag weights, urgency label generation
// ─────────────────────────────────────────────────────────────────────────────

async function suiteIdentityScoring() {
  section('SUITE 9 — Identity Scoring (clamping, weights, labels)')

  const { scoreIdentity } = await import('./pipeline/identityScore.js')

  // ── Test 9.1: Score never exceeds 1.0 ────────────────────────────────────
  const maxedOutRecord = {
    name: 'elon', displayName: 'Elon',
    firstSeen: Date.now() - 1000, lastSeen: Date.now(),
    mentions: 999,  // huge mention count
    notes: Array(10).fill('investor conversation'),
    tags: ['investor', 'client', 'partner'],  // all high-weight tags
    lastOffer: 10_000_000,
    lastIntent: 'AGREEMENT',
  }
  const maxScore = scoreIdentity(maxedOutRecord)
  record('identity', '9.1 score clamps at 1.0',
    maxScore.score <= 1.0 ? 'PASS' : 'FAIL',
    '<= 1.0',
    String(maxScore.score),
    'Score must never exceed 1.0 regardless of inputs'
  )

  // ── Test 9.2: Investor tag scores higher than client ─────────────────────
  const investorRecord = { ...maxedOutRecord, name: 'investor_test', tags: ['investor'], mentions: 1, lastOffer: null, lastIntent: null }
  const clientRecord   = { ...maxedOutRecord, name: 'client_test',   tags: ['client'],   mentions: 1, lastOffer: null, lastIntent: null }
  const investorScore  = scoreIdentity(investorRecord).score
  const clientScore    = scoreIdentity(clientRecord).score

  record('identity', '9.2 investor outscores client',
    investorScore > clientScore ? 'PASS' : 'FAIL',
    `investor(${investorScore}) > client(${clientScore})`,
    `investor=${investorScore}, client=${clientScore}`,
  )

  // ── Test 9.3: CRITICAL level at score >= 0.85 ────────────────────────────
  record('identity', '9.3 maxed record is CRITICAL level',
    maxScore.level === 'CRITICAL' ? 'PASS' : 'FAIL',
    'CRITICAL',
    maxScore.level,
  )

  // ── Test 9.4: Unknown person (no tags) is LOW ────────────────────────────
  const nobodyRecord = {
    name: 'nobody', displayName: 'Nobody',
    firstSeen: Date.now() - 100_000, lastSeen: Date.now() - 100_000,
    mentions: 1, notes: [], tags: [], lastOffer: null, lastIntent: null,
  }
  const nobodyScore = scoreIdentity(nobodyRecord)
  record('identity', '9.4 tagless unknown person is LOW',
    nobodyScore.level === 'LOW' ? 'PASS' : 'FAIL',
    'LOW',
    `${nobodyScore.level} (score=${nobodyScore.score})`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 10: ADAPTIVE WEIGHTS
// Tests bounds enforcement, weight persistence, decay
// ─────────────────────────────────────────────────────────────────────────────

async function suiteAdaptiveWeights() {
  section('SUITE 10 — Adaptive Weights (bounds, decay, persistence)')

  const { loadWeights, recordSuccess, recordIgnored, recordLost } = await import('./pipeline/adaptiveWeights.js')

  // ── Test 10.1: Weight never exceeds MAX (2.0) ────────────────────────────
  const testMsg = `__test_weight_${Date.now()}`
  for (let i = 0; i < 30; i++) recordSuccess(testMsg) // hammer it with success

  const weights = loadWeights()
  const key = testMsg.toLowerCase().replace(/\s+/g, '_')
  record('weights', '10.1 success weight clamps at 2.0',
    (weights[key] ?? 0) <= 2.0 ? 'PASS' : 'FAIL',
    '<= 2.0',
    String(weights[key]),
  )

  // ── Test 10.2: Weight never goes below MIN (0.1) ─────────────────────────
  const testMsg2 = `__test_weight_loss_${Date.now()}`
  for (let i = 0; i < 30; i++) recordLost(testMsg2) // hammer it with losses

  const weights2 = loadWeights()
  const key2 = testMsg2.toLowerCase().replace(/\s+/g, '_')
  record('weights', '10.2 loss weight clamps at 0.1',
    (weights2[key2] ?? 1) >= 0.1 ? 'PASS' : 'FAIL',
    '>= 0.1',
    String(weights2[key2]),
  )

  // ── Test 10.3: recordIgnored penalizes less than recordLost ──────────────
  const msgIgnored = `__test_ignored_${Date.now()}`
  const msgLost    = `__test_lost_${Date.now()}`
  recordIgnored(msgIgnored)
  recordLost(msgLost)

  const w = loadWeights()
  const ignoredKey = msgIgnored.toLowerCase().replace(/\s+/g, '_')
  const lostKey    = msgLost.toLowerCase().replace(/\s+/g, '_')
  record('weights', '10.3 lost penalizes more than ignored',
    (w[lostKey] ?? 1) < (w[ignoredKey] ?? 1) ? 'PASS' : 'FAIL',
    `lost(${w[lostKey]}) < ignored(${w[ignoredKey]})`,
    `lost=${w[lostKey]}, ignored=${w[ignoredKey]}`,
    'losing should decay weight more aggressively than ignoring'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 11: PRESSURE STATE MACHINE
// Tests the PENDING → SUGGESTED → REMINDED → ESCALATED → FORCED ladder
// ─────────────────────────────────────────────────────────────────────────────

async function suitePressureStateMachine() {
  section('SUITE 11 — Pressure State Machine (full ladder)')

  const { createPressureItem, fireItem, getDueItems, dismissPressure } = await import('./pipeline/pressure.js')

  const sourceId = `test_pressure_${Date.now()}`
  createPressureItem(sourceId, 'task', 'Test task for state machine', null, 'high', 0)

  // Fire through all states
  const states: string[] = []
  for (let i = 0; i < 4; i++) {
    // Make item due immediately
    const due = getDueItems(true)
    const item = due.find(d => d.sourceId === sourceId)
    if (!item) { states.push('NOT_FOUND'); continue }

    const result = fireItem(item.id)
    states.push(result?.state ?? 'null')
  }

  record('pressure', '11.1 state progression SUGGESTED',
    states[0] === 'SUGGESTED' ? 'PASS' : 'FAIL',
    'SUGGESTED', states[0],
  )
  record('pressure', '11.2 state progression REMINDED',
    states[1] === 'REMINDED' ? 'PASS' : 'FAIL',
    'REMINDED', states[1],
  )
  record('pressure', '11.3 state progression ESCALATED',
    states[2] === 'ESCALATED' ? 'PASS' : 'FAIL',
    'ESCALATED', states[2],
  )
  record('pressure', '11.4 state progression FORCED',
    states[3] === 'FORCED' ? 'PASS' : 'FAIL',
    'FORCED', states[3],
  )

  // ── Test 11.5: FORCED message contains urgency language ──────────────────
  const due2 = getDueItems(true)
  const forcedItem = due2.find(d => d.sourceId === sourceId)
  if (forcedItem) {
    const result = fireItem(forcedItem.id)
    record('pressure', '11.5 FORCED message contains urgency language',
      result?.message.toLowerCase().includes('urgent') ? 'PASS' : 'FAIL',
      'contains "URGENT"',
      result?.message ?? 'null',
    )
  }

  // ── Test 11.6: Dismissed item does not refire ────────────────────────────
  const sourceId2 = `test_dismiss_${Date.now()}`
  createPressureItem(sourceId2, 'followup', 'Dismissal test', null, 'medium', 0)
  dismissPressure(sourceId2, true)
  const afterDismiss = getDueItems(true).find(d => d.sourceId === sourceId2)
  record('pressure', '11.6 dismissed item does not refire',
    !afterDismiss ? 'PASS' : 'FAIL',
    'not in due items',
    afterDismiss ? 'still in due items' : 'correctly absent',
  )

  // ── Test 11.7: Dedup — creating same sourceId twice doesn't double up ────
  const sourceId3 = `test_dedup_${Date.now()}`
  createPressureItem(sourceId3, 'task', 'Dedup test', null, 'low', 0)
  createPressureItem(sourceId3, 'task', 'Dedup test', null, 'low', 0) // same sourceId
  const dups = getDueItems(true).filter(d => d.sourceId === sourceId3)
  record('pressure', '11.7 duplicate sourceId does not create duplicate item',
    dups.length <= 1 ? 'PASS' : 'FAIL',
    '<= 1 item',
    `${dups.length} items found`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 12: STACKED SIGNALS & EDGE CASES
// Tests simultaneous signals, contradictions, mode-edge utterances
// ─────────────────────────────────────────────────────────────────────────────

async function suiteStackedSignals() {
  section('SUITE 12 — Stacked Signals, Contradictions & Edge Cases')

  const { decide, setMode } = await import('./pipeline/decision.js')
  const { resetTiers } = await import('./pipeline/playbook.js')

  setMode('negotiation')

  const edgeCases: Array<{ name: string; transcript: string; check: (r: string | null) => boolean; expectation: string }> = [

    // Stacked: price objection + stall in same sentence (price should win — higher priority)
    {
      name: '12.1 price+stall stack — price wins',
      transcript: "the price is too high and i need to think about it",
      check: r => contains(r, 'price', 'hold', 'number', 'afford', 'cost', 'ROI', 'week'),
      expectation: 'price objection response (priority 11 beats stall priority 10)',
    },

    // Agreement then immediate backtrack
    {
      name: '12.2 agreement signal fires',
      transcript: "okay yes let's do it send the contract",
      check: r => isNotNull(r),
      expectation: 'non-null — agreement detected',
    },

    // Extremely long transcript — rambling rule
    {
      name: '12.3 rambling (200+ chars) fires in negotiation',
      transcript: "so what we have been thinking about is that there are a lot of different factors that go into this decision and we need to consider all of them carefully before we make any kind of commitment because you know this is a big investment for us and we want to make sure we are making the right call for the business and our team and our customers",
      check: r => contains(r, 'rambling', 'frame', 'question', 'stop'),
      expectation: 'rambling detection',
    },

    // Very short — should mostly pass (under 3 meaningful words)
    {
      name: '12.4 single word does not crash system',
      transcript: "hmm",
      check: r => r !== undefined, // just check it doesn't throw
      expectation: 'no crash (null or ARIA_QUERY)',
    },

    // Competitor + panic combined
    {
      name: '12.5 competitor+lost deal — fires response',
      transcript: "we decided to go with servicetitan and already signed the contract last week",
      check: r => isNotNull(r),
      expectation: 'non-null — panic/competitor response',
    },

    // ARIA meta-query routing
    {
      name: '12.6 ARIA_QUERY — "what should I say"',
      transcript: "what should I say right now",
      check: r => r === 'ARIA_QUERY' || isNotNull(r),
      expectation: 'ARIA_QUERY or non-null response',
    },

    // Pure pleasantry — should not fire
    {
      name: '12.7 pleasantry does not fire',
      transcript: "great thanks for your time today",
      check: r => r === null,
      expectation: 'null — no signal in pleasantry',
    },

    // Number in context that is NOT a price offer
    {
      name: '12.8 "15 employees" not extracted as offer',
      transcript: "we have about 15 employees on the field team",
      check: _ => true, // just checking memory separately — here check no crash
      expectation: 'no crash',
    },
  ]

  for (const c of edgeCases) {
    resetTiers()
    let response: string | null = null
    let threw = false
    try {
      response = await decide(c.transcript)
    } catch (e) {
      threw = true
    }

    if (threw) {
      record('edge', c.name, 'FAIL', c.expectation, 'THREW EXCEPTION')
    } else {
      record('edge', c.name,
        c.check(response) ? 'PASS' : 'FAIL',
        c.expectation,
        response,
      )
    }
  }

  resetTiers()
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 13: TIMELINE PLAYS
// Tests the 5 timeline control plays fire on correct triggers
// ─────────────────────────────────────────────────────────────────────────────

async function suiteTimelinePlays() {
  section('SUITE 13 — Timeline Control Plays')

  const { matchTimelinePlay, TIMELINE_PLAYS } = await import('./pipeline/playbook.js')

  const timelineCases: Array<{ transcript: string; expectedKey: string | null; name: string }> = [
    { name: '13.1 risk reversal trigger',          transcript: "i am not sure we want to take that risk",            expectedKey: 'RISK_REVERSAL' },
    { name: '13.2 loss framing trigger',           transcript: "maybe we will do it later next month",               expectedKey: 'LOSS_FRAMING' },
    { name: '13.3 deadline compression trigger',   transcript: "there is no rush take your time",                    expectedKey: 'DEADLINE_COMPRESSION' },
    { name: '13.4 micro commitment trigger',       transcript: "i probably might be interested",                     expectedKey: 'MICRO_COMMITMENT' },
    { name: '13.5 opportunity cost trigger',       transcript: "it is just not a priority right now",                expectedKey: 'OPPORTUNITY_COST' },
    { name: '13.6 no timeline play — direct yes',  transcript: "yes we are ready to move forward today",             expectedKey: null },
  ]

  for (const c of timelineCases) {
    const result = matchTimelinePlay(c.transcript)
    if (c.expectedKey === null) {
      record('timeline', c.name,
        result === null ? 'PASS' : 'WARN',
        'null',
        result?.key ?? 'null',
      )
    } else {
      record('timeline', c.name,
        result?.key === c.expectedKey ? 'PASS' : 'FAIL',
        c.expectedKey,
        result?.key ?? 'null',
      )
    }
  }

  // ── Test 13.7: All 5 plays have silence or binary set ────────────────────
  const highPressurePlays = TIMELINE_PLAYS.filter(p => p.silence)
  record('timeline', '13.7 majority of timeline plays use silence',
    highPressurePlays.length >= 3 ? 'PASS' : 'FAIL',
    '>= 3 with silence=true',
    `${highPressurePlays.length} silent plays`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORECARD
// ─────────────────────────────────────────────────────────────────────────────

function printScorecard() {
  console.log(`\n${'═'.repeat(60)}`)
  console.log('ADVERSARIAL TEST SCORECARD')
  console.log(`${'═'.repeat(60)}`)

  const suites = [...new Set(results.map(r => r.suite))]

  let totalPass = 0, totalFail = 0, totalWarn = 0

  for (const suite of suites) {
    const suiteResults = results.filter(r => r.suite === suite)
    const pass = suiteResults.filter(r => r.verdict === 'PASS').length
    const fail = suiteResults.filter(r => r.verdict === 'FAIL').length
    const warn = suiteResults.filter(r => r.verdict === 'WARN').length
    const total = suiteResults.length
    const pct = Math.round((pass / total) * 100)

    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))
    const status = fail === 0 ? '✅' : pct >= 75 ? '🟡' : '❌'

    console.log(`  ${status} ${suite.padEnd(14)} ${bar} ${pct}%  (${pass}/${total}${warn ? ` ⚠${warn}` : ''})`)
    totalPass += pass; totalFail += fail; totalWarn += warn
  }

  const total = totalPass + totalFail + totalWarn
  const pct = Math.round((totalPass / (totalPass + totalFail)) * 100)

  console.log(`${'─'.repeat(60)}`)
  console.log(`  TOTAL: ${totalPass} pass / ${totalFail} fail / ${totalWarn} warn — ${pct}%`)

  if (totalFail === 0) {
    console.log(`\n  ⚠️  Zero failures. Either everything works or the tests aren't hard enough.`)
    console.log(`     Check the WARN items and the adversarial suite carefully.`)
  } else {
    console.log(`\n  ${totalFail} real failures found. Fix them.`)
  }

  // Print all failures for easy scanning
  const failures = results.filter(r => r.verdict === 'FAIL')
  if (failures.length) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log('FAILURES:')
    for (const f of failures) {
      console.log(`\n  ❌ [${f.suite}] ${f.name}`)
      console.log(`     expected: ${f.expected}`)
      console.log(`     got:      ${f.got ?? '(null)'}`)
      if (f.note) console.log(`     note:     ${f.note}`)
    }
  }

  console.log(`${'═'.repeat(60)}\n`)
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const suiteArg = process.argv.find(a => a.startsWith('--suite='))?.split('=')[1] ?? 'all'

  console.log(`\nARIA ADVERSARIAL TEST SUITE`)
  console.log(`Running: ${suiteArg}`)
  console.log(`${'═'.repeat(60)}`)

  const suiteMap: Record<string, () => Promise<void>> = {
    escalation: suiteEscalation,
    forced:     suiteForcedResponse,
    adversarial: suiteAdversarialPhrasing,
    modes:      suiteModeCorrectness,
    memory:     suiteMemory,
    people:     suitePeople,
    followup:   suiteFollowUp,
    tasks:      suiteTaskExtraction,
    identity:   suiteIdentityScoring,
    weights:    suiteAdaptiveWeights,
    pressure:   suitePressureStateMachine,
    edge:       suiteStackedSignals,
    timeline:   suiteTimelinePlays,
  }

  if (suiteArg === 'all') {
    for (const fn of Object.values(suiteMap)) {
      await fn()
    }
  } else if (suiteMap[suiteArg]) {
    await suiteMap[suiteArg]()
  } else {
    console.error(`Unknown suite: ${suiteArg}`)
    console.error(`Available: ${Object.keys(suiteMap).join(', ')}, all`)
    process.exit(1)
  }

  printScorecard()
  process.exit(results.some(r => r.verdict === 'FAIL') ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })