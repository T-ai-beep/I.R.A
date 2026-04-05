/**
 * validate.ts
 * Offline validator — tests all critical logic WITHOUT needing Ollama/embeddings.
 * Tests memory, rules, playbook, follow-up detection, people extraction, identity.
 *
 * Run: npx tsx src/validate.ts
 *      npx tsx src/validate.ts --suite=memory
 */

type Verdict = 'PASS' | 'FAIL' | 'WARN'

interface TestResult {
  suite: string
  name: string
  verdict: Verdict
  expected: string
  got: string | null
  note: string
}

const results: TestResult[] = []

function record(
  suite: string, name: string, verdict: Verdict,
  expected: string, got: string | null, note = ''
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
  console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: MEMORY & OFFER EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

async function suiteMemory() {
  section('SUITE 1 — Memory & Offer Extraction')

  // Import the refactored memory module
  const { remember, getContext, clearMemory, extractOffer, extractIntent } = await import('./pipeline/memory.js')

  clearMemory()

  // Offer extraction
  const offerCases: Array<{ name: string; transcript: string; expected: number | null }> = [
    { name: '1.1a $5,000 per month',          transcript: 'we are thinking around $5,000 a month',  expected: 5000 },
    { name: '1.1b $5k per month',              transcript: 'the price is $5k per month',             expected: 5000 },
    { name: '1.1c 5 thousand monthly',         transcript: 'thats 5 thousand a month',               expected: 5000 },
    { name: '1.1d $1.5 million',               transcript: 'valuation is $1.5 million',              expected: 1_500_000 },
    { name: '1.1e no dollar amount',           transcript: 'we are not ready to discuss pricing',    expected: null },
    { name: '1.1f $150 per month',             transcript: 'at $150 per month it seems steep',       expected: 150 },
    { name: '1.1g 15 years NOT an offer',      transcript: 'we have been in business for 15 years',  expected: null },
    { name: '1.1h 15 employees NOT an offer',  transcript: 'we have about 15 employees',             expected: null },
    { name: '1.1i range $120k to $150k',       transcript: 'looking for something in the range of $120k to $150k', expected: 120_000 },
    { name: '1.1j $8,500 per month',           transcript: 'the price is $8,500 per month',          expected: 8500 },
  ]

  for (const c of offerCases) {
    clearMemory()
    const turn = remember(c.transcript)
    record('memory', c.name,
      turn.offer === c.expected ? 'PASS' : 'FAIL',
      String(c.expected), String(turn.offer)
    )
  }

  // Intent extraction — adversarial phrasing
  const intentCases: Array<{ name: string; transcript: string; expected: string | null }> = [
    { name: '1.2a sticker shock → PRICE_OBJECTION',          transcript: 'wow i was not expecting that number',             expected: 'PRICE_OBJECTION' },
    { name: '1.2b implied price pain → PRICE_OBJECTION',     transcript: 'that is a lot for a company our size',            expected: 'PRICE_OBJECTION' },
    { name: '1.2c circle back → STALLING',                   transcript: 'let us circle back on this in a few weeks',       expected: 'STALLING' },
    { name: '1.2d business partner → AUTHORITY',             transcript: 'my business partner would need to weigh in',      expected: 'AUTHORITY' },
    { name: '1.2e team align → AUTHORITY',                   transcript: 'our team would need to align on something like this', expected: 'AUTHORITY' },
    { name: '1.2f soft confirm → AGREEMENT',                 transcript: 'yeah this could really work for us',              expected: 'AGREEMENT' },
    { name: '1.2g signed paperwork → COMPETITOR',            transcript: 'we signed the paperwork with them last tuesday',  expected: 'COMPETITOR' },
    { name: '1.2h standard price objection',                 transcript: "we can't afford this right now",                  expected: 'PRICE_OBJECTION' },
    { name: '1.2i standard stalling',                        transcript: 'let me think about it and get back',              expected: 'STALLING' },
    { name: '1.2j no intent',                                transcript: 'the weather in dallas is nice today',             expected: null },
  ]

  for (const c of intentCases) {
    clearMemory()
    const turn = remember(c.transcript)
    record('memory', c.name,
      turn.intent === c.expected ? 'PASS' : 'FAIL',
      String(c.expected), String(turn.intent)
    )
  }

  // Multi-turn context persistence
  clearMemory()
  remember('the price is $8,500 per month')
  remember('that seems too high for us')
  const ctx = getContext()
  record('memory', '1.3a lastOffer persists across turns', ctx.lastOffer === 8500 ? 'PASS' : 'FAIL', '8500', String(ctx.lastOffer))
  record('memory', '1.3b lastIntent persists across turns', ctx.lastIntent === 'PRICE_OBJECTION' ? 'PASS' : 'FAIL', 'PRICE_OBJECTION', String(ctx.lastIntent))

  clearMemory()
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: RULES ENGINE — MODE ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

async function suiteRules() {
  section('SUITE 2 — Rules Engine & Mode Isolation')

  const { matchRule } = await import('./pipeline/rules.js')

  const cases: Array<{ name: string; transcript: string; mode: 'negotiation'|'meeting'|'interview'|'social'; shouldFire: boolean; contains?: string }> = [
    // Negotiation — standard
    { name: '2.1 price objection fires in negotiation', transcript: 'too expensive for us', mode: 'negotiation', shouldFire: true, contains: 'Price objection' },
    { name: '2.2 agreement fires in negotiation', transcript: "let's move forward", mode: 'negotiation', shouldFire: true, contains: 'Agreement' },
    { name: '2.3 competitor fires in negotiation', transcript: 'we use servicetitan', mode: 'negotiation', shouldFire: true, contains: 'Competitor' },

    // Adversarial negotiation phrasing
    { name: '2.4 implied price pain fires', transcript: 'that is a lot for a company our size', mode: 'negotiation', shouldFire: true, contains: 'Price objection' },
    { name: '2.5 sticker shock fires', transcript: 'wow i was not expecting that number', mode: 'negotiation', shouldFire: true, contains: 'Price objection' },
    { name: '2.6 wiggle room fires', transcript: 'any chance there is some wiggle room on that', mode: 'negotiation', shouldFire: true, contains: 'Discount' },
    { name: '2.7 business partner authority', transcript: 'my business partner would need to weigh in', mode: 'negotiation', shouldFire: true, contains: 'Approval needed' },
    { name: '2.8 soft confirm agreement', transcript: 'yeah this could really work for us', mode: 'negotiation', shouldFire: true, contains: 'Agreement' },

    // Meeting mode — stat rule fires
    { name: '2.9 stat fires in meeting mode', transcript: 'we think conversion is up 40 percent', mode: 'meeting', shouldFire: true, contains: 'Stat uncited' },
    { name: '2.10 no owner fires in meeting mode', transcript: 'someone should look into the auth bug', mode: 'meeting', shouldFire: true, contains: 'No owner' },

    // MODE ISOLATION — negotiation rules must NOT fire in meeting
    { name: '2.11 price in meeting → no negotiation rule', transcript: 'the price seems high', mode: 'meeting', shouldFire: false },
    { name: '2.12 hold number NOT in meeting mode', transcript: 'too expensive for us', mode: 'meeting', shouldFire: false },

    // Interview mode
    { name: '2.13 comp question fires in interview', transcript: 'what are your salary expectations', mode: 'interview', shouldFire: true, contains: 'Comp question' },
    { name: '2.14 weakness fires in interview', transcript: 'what is your biggest weakness', mode: 'interview', shouldFire: true, contains: 'Trap question' },

    // Social mode
    { name: '2.15 investor fires in social', transcript: 'we run a fund focused on early stage', mode: 'social', shouldFire: true, contains: 'Investor' },
    { name: '2.16 opportunity fires in social', transcript: 'so what do you do', mode: 'social', shouldFire: true, contains: 'Opportunity' },

    // True negatives — should NOT fire
    { name: '2.17 pleasantry should not fire', transcript: 'nice to meet you', mode: 'negotiation', shouldFire: false },
    { name: '2.18 short filler should not fire', transcript: 'hmm', mode: 'negotiation', shouldFire: false },
    { name: '2.19 neutral context setting', transcript: 'we are an hvac company based in dallas', mode: 'negotiation', shouldFire: false },
    { name: '2.20 affirmation should not fire', transcript: 'yeah okay', mode: 'negotiation', shouldFire: false },
  ]

  for (const c of cases) {
    const result = matchRule(c.transcript, c.mode)
    const fired = result !== null

    if (c.shouldFire) {
      const containsOk = !c.contains || (result?.toLowerCase().includes(c.contains.toLowerCase()) ?? false)
      record('rules', c.name,
        fired && containsOk ? 'PASS' : 'FAIL',
        c.contains ? `fires with "${c.contains}"` : 'fires',
        result
      )
    } else {
      record('rules', c.name,
        !fired ? 'PASS' : 'WARN',
        'null (no fire)',
        result,
        fired ? `False positive: "${result}"` : ''
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: PLAYBOOK — TIER ESCALATION
// ─────────────────────────────────────────────────────────────────────────────

async function suitePlaybook() {
  section('SUITE 3 — Playbook Tier Escalation & Isolation')

  const { matchPlaybook, executePlay, resetTiers, PLAYBOOK } = await import('./pipeline/playbook.js')

  resetTiers()

  // 3.1: Tier 0 is a soft probe ending with "?"
  const pricePlay = PLAYBOOK['PRICE_OBJECTION']
  resetTiers()
  const tier0 = executePlay(pricePlay)
  record('playbook', '3.1 tier-0 ends with question mark',
    tier0.includes('?') ? 'PASS' : 'FAIL',
    'contains ?', tier0
  )

  // 3.2: Tier 3 is binary
  resetTiers()
  const tier3IsBinary = pricePlay.steps[3].binary
  record('playbook', '3.2 tier-3 is binary=true',
    tier3IsBinary ? 'PASS' : 'FAIL',
    'binary=true', String(tier3IsBinary)
  )

  // 3.3: All 4 tiers are distinct responses
  resetTiers()
  const fired: string[] = []
  for (let i = 0; i < 4; i++) fired.push(executePlay(pricePlay))
  const unique = new Set(fired).size
  record('playbook', '3.3 all 4 tiers produce distinct responses',
    unique === 4 ? 'PASS' : 'FAIL',
    '4 unique', `${unique} unique`
  )

  // 3.4: Tier state is ISOLATED between play types
  resetTiers()
  const stallPlay = PLAYBOOK['STALL_GENERIC']
  const discountPlay = PLAYBOOK['DISCOUNT_REQUEST']
  executePlay(stallPlay)
  executePlay(stallPlay)
  executePlay(stallPlay)  // stall now at tier 2
  const discountTier0 = executePlay(discountPlay)
  record('playbook', '3.4 tier states isolated between plays',
    discountTier0 === discountPlay.steps[0].response ? 'PASS' : 'FAIL',
    `discount tier-0: "${discountPlay.steps[0].response.slice(0, 40)}"`,
    discountTier0.slice(0, 40)
  )

  // 3.5: resetTiers actually resets
  resetTiers()
  executePlay(pricePlay)
  executePlay(pricePlay)  // at tier 1
  resetTiers()
  const afterReset = executePlay(pricePlay)
  record('playbook', '3.5 resetTiers restores tier-0',
    afterReset === pricePlay.steps[0].response ? 'PASS' : 'FAIL',
    pricePlay.steps[0].response.slice(0, 40),
    afterReset.slice(0, 40)
  )

  // 3.6: PRICE_OBJECTION signal detection
  resetTiers()
  const priceMatch = matchPlaybook('fifteen hundred bucks is a lot for us man')
  record('playbook', '3.6 adversarial price phrase matches PRICE_OBJECTION',
    priceMatch?.key === 'PRICE_OBJECTION' ? 'PASS' : 'FAIL',
    'PRICE_OBJECTION', priceMatch?.key ?? 'null'
  )

  // 3.7: AGREEMENT_SIGNAL detection
  resetTiers()
  const agreementMatch = matchPlaybook('yeah okay i am in let us do this')
  record('playbook', '3.7 soft agreement matches AGREEMENT_SIGNAL',
    agreementMatch?.key === 'AGREEMENT_SIGNAL' ? 'PASS' : 'FAIL',
    'AGREEMENT_SIGNAL', agreementMatch?.key ?? 'null'
  )

  // 3.8: Majority of PRICE_OBJECTION steps have silence=true
  const silentSteps = pricePlay.steps.filter(s => s.silence).length
  record('playbook', '3.8 PRICE_OBJECTION has >= 3 silent steps',
    silentSteps >= 3 ? 'PASS' : 'FAIL',
    '>= 3 silent steps', `${silentSteps} silent steps`
  )

  // 3.9: All timeline plays work
  const { matchTimelinePlay, TIMELINE_PLAYS } = await import('./pipeline/playbook.js')
  const timelineCases = [
    { key: 'RISK_REVERSAL', text: 'i am not sure we want to take that risk' },
    { key: 'LOSS_FRAMING', text: 'maybe later next month' },
    { key: 'DEADLINE_COMPRESSION', text: 'there is no rush take your time' },
    { key: 'MICRO_COMMITMENT', text: 'i probably might be interested' },
    { key: 'OPPORTUNITY_COST', text: 'it is just not a priority right now' },
  ]
  for (const tc of timelineCases) {
    const match = matchTimelinePlay(tc.text)
    record('playbook', `3.9 timeline play: ${tc.key}`,
      match?.key === tc.key ? 'PASS' : 'FAIL',
      tc.key, match?.key ?? 'null'
    )
  }

  const silentTimelinePlays = TIMELINE_PLAYS.filter(p => p.silence).length
  record('playbook', '3.10 majority of timeline plays use silence',
    silentTimelinePlays >= 3 ? 'PASS' : 'FAIL',
    '>= 3 silent', `${silentTimelinePlays} silent`
  )

  resetTiers()
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: ADAPTIVE WEIGHTS
// ─────────────────────────────────────────────────────────────────────────────

async function suiteWeights() {
  section('SUITE 4 — Adaptive Weights')

  const { loadWeights, recordSuccess, recordIgnored, recordLost } = await import('./pipeline/adaptiveWeights.js')

  const testKey = `__validate_${Date.now()}`
  const lossKey = `__validate_loss_${Date.now()}`
  const ignKey  = `__validate_ign_${Date.now()}`

  // Hammer success
  for (let i = 0; i < 30; i++) recordSuccess(testKey)
  const w1 = loadWeights()
  const k1 = testKey.toLowerCase().replace(/\s+/g, '_')
  record('weights', '4.1 success weight clamps at 2.0',
    (w1[k1] ?? 0) <= 2.0 ? 'PASS' : 'FAIL',
    '<= 2.0', String(w1[k1])
  )

  // Hammer loss
  for (let i = 0; i < 30; i++) recordLost(lossKey)
  const w2 = loadWeights()
  const k2 = lossKey.toLowerCase().replace(/\s+/g, '_')
  record('weights', '4.2 loss weight clamps at 0.1',
    (w2[k2] ?? 1) >= 0.1 ? 'PASS' : 'FAIL',
    '>= 0.1', String(w2[k2])
  )

  // Lost penalizes more than ignored
  recordIgnored(ignKey)
  recordLost(lossKey + '_b')
  const w3 = loadWeights()
  const kIgn  = ignKey.toLowerCase().replace(/\s+/g, '_')
  const kLost = (lossKey + '_b').toLowerCase().replace(/\s+/g, '_')
  record('weights', '4.3 lost penalizes more than ignored',
    (w3[kLost] ?? 1) < (w3[kIgn] ?? 1) ? 'PASS' : 'FAIL',
    `lost(${w3[kLost]}) < ignored(${w3[kIgn]})`,
    `lost=${w3[kLost]}, ignored=${w3[kIgn]}`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: FOLLOW-UP DETECTION
// ─────────────────────────────────────────────────────────────────────────────

async function suiteFollowUp() {
  section('SUITE 5 — Follow-Up Detection')

  const { detectFollowUp } = await import('./pipeline/followup.js')

  const cases: Array<{ name: string; transcript: string; expected: 'hot'|'warm'|'cold'|null }> = [
    { name: '5.1 hot — send contract',       transcript: "okay let's move forward send me the contract",     expected: 'hot' },
    { name: '5.2 hot — email invite',        transcript: 'email me a calendar invite for next week',         expected: 'hot' },
    { name: '5.3 hot — send pricing',        transcript: 'can you send me the pricing details',              expected: 'hot' },
    { name: '5.4 warm — reconnect next week', transcript: "let's reconnect next week to finalize",           expected: 'warm' },
    { name: '5.5 warm — get back to you',    transcript: 'i will get back to you by friday',                expected: 'warm' },
    { name: '5.6 warm — set up meeting',     transcript: 'let us set up a meeting to go over the details',  expected: 'warm' },
    { name: '5.7 cold — not right now',      transcript: 'not right now maybe later this year',             expected: 'cold' },
    { name: '5.8 cold — budget tight',       transcript: 'budget is tight right now',                       expected: 'cold' },
    { name: '5.9 cold — keep in touch',      transcript: "let's keep in touch",                             expected: 'cold' },
    { name: '5.10 no follow-up — neutral',   transcript: 'the weather is nice in dallas today',             expected: null },
  ]

  for (const c of cases) {
    const result = detectFollowUp(c.transcript)
    if (c.expected === null) {
      record('followup', c.name,
        result === null ? 'PASS' : 'WARN',
        'null', result ? `${result.priority}` : 'null'
      )
    } else {
      record('followup', c.name,
        result?.priority === c.expected ? 'PASS' : 'FAIL',
        c.expected, result?.priority ?? 'null'
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6: PEOPLE EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

async function suitePeople() {
  section('SUITE 6 — People Extraction')

  const { extractNames } = await import('./pipeline/people.js')

  const cases: Array<{ name: string; transcript: string; shouldInclude: string[]; shouldExclude: string[] }> = [
    { name: '6.1 extracts person after "with"', transcript: 'I had a meeting with Marcus about the deal', shouldInclude: ['Marcus'], shouldExclude: [] },
    { name: '6.2 extracts person who "said"', transcript: 'Nathan said we need to rebuild the frontend', shouldInclude: ['Nathan'], shouldExclude: [] },
    { name: '6.3 blacklist — Monday not a person', transcript: 'let us reconnect on Monday about this', shouldInclude: [], shouldExclude: ['Monday'] },
    { name: '6.4 blacklist — ARIA not a person', transcript: 'ARIA flagged this as a competitor signal', shouldInclude: [], shouldExclude: ['ARIA', 'Aria'] },
    { name: '6.5 blacklist — ServiceTitan not a person', transcript: 'ServiceTitan has been our system for years', shouldInclude: [], shouldExclude: ['ServiceTitan'] },
  ]

  for (const c of cases) {
    const names = extractNames(c.transcript)
    const includeOk = c.shouldInclude.every(n => names.includes(n))
    const excludeOk = c.shouldExclude.every(n => !names.includes(n))
    record('people', c.name,
      includeOk && excludeOk ? 'PASS' : 'FAIL',
      `include=[${c.shouldInclude}] exclude=[${c.shouldExclude}]`,
      `extracted=[${names}]`
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 7: IDENTITY SCORING
// ─────────────────────────────────────────────────────────────────────────────

async function suiteIdentity() {
  section('SUITE 7 — Identity Scoring')

  const { scoreIdentity } = await import('./pipeline/identityScore.js')

  const base = { firstSeen: Date.now() - 1000, lastSeen: Date.now(), notes: [] as string[] }

  const maxedRecord = {
    ...base,
    name: 'elon', displayName: 'Elon',
    mentions: 999,
    notes: Array(10).fill('investor conversation'),
    tags: ['investor', 'client', 'partner'],
    lastOffer: 10_000_000,
    lastIntent: 'AGREEMENT',
  }

  const maxScore = scoreIdentity(maxedRecord)
  record('identity', '7.1 score clamps at 1.0', maxScore.score <= 1.0 ? 'PASS' : 'FAIL', '<= 1.0', String(maxScore.score))
  record('identity', '7.2 maxed record is CRITICAL', maxScore.level === 'CRITICAL' ? 'PASS' : 'FAIL', 'CRITICAL', maxScore.level)

  const investorScore = scoreIdentity({ ...base, name: 'inv', displayName: 'Inv', mentions: 1, tags: ['investor'], lastOffer: null, lastIntent: null }).score
  const clientScore   = scoreIdentity({ ...base, name: 'cli', displayName: 'Cli', mentions: 1, tags: ['client'],   lastOffer: null, lastIntent: null }).score
  record('identity', '7.3 investor outscores client', investorScore > clientScore ? 'PASS' : 'FAIL', `investor>${clientScore}`, `investor=${investorScore}`)

  const nobody = scoreIdentity({ ...base, name: 'nobody', displayName: 'Nobody', mentions: 1, tags: [], lastOffer: null, lastIntent: null, lastSeen: Date.now() - 100_000 })
  record('identity', '7.4 tagless person is LOW', nobody.level === 'LOW' ? 'PASS' : 'FAIL', 'LOW', `${nobody.level}(score=${nobody.score})`)
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 8: PRESSURE STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────

async function suitePressure() {
  section('SUITE 8 — Pressure State Machine')

  const { createPressureItem, fireItem, getDueItems, dismissPressure } = await import('./pipeline/pressure.js')

  const srcId = `val_pressure_${Date.now()}`
  createPressureItem(srcId, 'task', 'Validate state machine', null, 'high', 0)

  const states: string[] = []
  for (let i = 0; i < 4; i++) {
    const due  = getDueItems(true)
    const item = due.find(d => d.sourceId === srcId)
    if (!item) { states.push('NOT_FOUND'); continue }
    const result = fireItem(item.id)
    states.push(result?.state ?? 'null')
  }

  const expected = ['SUGGESTED', 'REMINDED', 'ESCALATED', 'FORCED']
  expected.forEach((exp, i) => {
    record('pressure', `8.${i+1} state ${exp}`, states[i] === exp ? 'PASS' : 'FAIL', exp, states[i])
  })

  // FORCED message contains urgency
  const due2 = getDueItems(true)
  const fi = due2.find(d => d.sourceId === srcId)
  if (fi) {
    const result = fireItem(fi.id)
    record('pressure', '8.5 FORCED message contains "URGENT"',
      result?.message.toLowerCase().includes('urgent') ? 'PASS' : 'FAIL',
      'contains urgent', result?.message ?? 'null'
    )
  }

  // Dismissed item does not refire
  const srcId2 = `val_dismiss_${Date.now()}`
  createPressureItem(srcId2, 'followup', 'Dismiss test', null, 'medium', 0)
  dismissPressure(srcId2, true)
  const afterDismiss = getDueItems(true).find(d => d.sourceId === srcId2)
  record('pressure', '8.6 dismissed item does not refire',
    !afterDismiss ? 'PASS' : 'FAIL',
    'absent', afterDismiss ? 'still present' : 'correctly absent'
  )

  // Dedup
  const srcId3 = `val_dedup_${Date.now()}`
  createPressureItem(srcId3, 'task', 'Dedup test', null, 'low', 0)
  createPressureItem(srcId3, 'task', 'Dedup test', null, 'low', 0)
  const dups = getDueItems(true).filter(d => d.sourceId === srcId3)
  record('pressure', '8.7 duplicate sourceId not created twice',
    dups.length <= 1 ? 'PASS' : 'FAIL',
    '<= 1', `${dups.length} found`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORECARD
// ─────────────────────────────────────────────────────────────────────────────

function printScorecard() {
  console.log(`\n${'═'.repeat(60)}\nVALIDATION SCORECARD\n${'═'.repeat(60)}`)

  const suites = [...new Set(results.map(r => r.suite))]
  let totalPass = 0, totalFail = 0, totalWarn = 0

  for (const suite of suites) {
    const sr = results.filter(r => r.suite === suite)
    const pass = sr.filter(r => r.verdict === 'PASS').length
    const fail = sr.filter(r => r.verdict === 'FAIL').length
    const warn = sr.filter(r => r.verdict === 'WARN').length
    const pct  = Math.round(pass / sr.length * 100)
    const bar  = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))
    const icon = fail === 0 ? '✅' : pct >= 75 ? '🟡' : '❌'
    console.log(`  ${icon} ${suite.padEnd(12)} ${bar} ${pct}%  (${pass}/${sr.length}${warn ? ` ⚠${warn}` : ''})`)
    totalPass += pass; totalFail += fail; totalWarn += warn
  }

  const total  = totalPass + totalFail
  const pct    = Math.round(totalPass / total * 100)
  console.log(`${'─'.repeat(60)}`)
  console.log(`  TOTAL: ${totalPass} pass / ${totalFail} fail / ${totalWarn} warn — ${pct}%`)

  const failures = results.filter(r => r.verdict === 'FAIL')
  if (failures.length) {
    console.log(`\n${'─'.repeat(60)}\nFAILURES:`)
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

  console.log(`\nARIA OFFLINE VALIDATOR\nRunning: ${suiteArg}\n${'═'.repeat(60)}`)

  const suiteMap: Record<string, () => Promise<void>> = {
    memory:   suiteMemory,
    rules:    suiteRules,
    playbook: suitePlaybook,
    weights:  suiteWeights,
    followup: suiteFollowUp,
    people:   suitePeople,
    identity: suiteIdentity,
    pressure: suitePressure,
  }

  if (suiteArg === 'all') {
    for (const fn of Object.values(suiteMap)) await fn()
  } else if (suiteMap[suiteArg]) {
    await suiteMap[suiteArg]()
  } else {
    console.error(`Unknown suite: ${suiteArg}\nAvailable: ${Object.keys(suiteMap).join(', ')}, all`)
    process.exit(1)
  }

  printScorecard()
  process.exit(results.some(r => r.verdict === 'FAIL') ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })