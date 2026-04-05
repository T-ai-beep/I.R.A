/**
 * demo3.ts — Extreme Adversarial Test Suite
 * Zero Ollama dependencies. All logic tested in isolation.
 * Tests: offer extraction, intent extraction, memory state,
 *        rules engine, playbook, follow-up, pressure, identity.
 *
 * Run: npx tsx src/demo3.ts
 *      npx tsx src/demo3.ts --suite=memory
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
  console.log(`\n${'═'.repeat(70)}\n  ${title}\n${'═'.repeat(70)}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE A — OFFER EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

async function suiteOfferExtraction() {
  section('SUITE A — Offer Extraction (adversarial)')
  const { extractOffer, clearMemory } = await import('./pipeline/memory.js')
  clearMemory()

  const cases: Array<{ text: string; expected: number | null; name: string }> = [
    { text: 'We are thinking around $5,000 a month.',            expected: 5000,      name: 'A.01 $5,000/month' },
    { text: 'The price is $5k per month.',                       expected: 5000,      name: 'A.02 $5k/month' },
    { text: 'Thats 5 thousand a month.',                         expected: 5000,      name: 'A.03 5 thousand/month' },
    { text: 'Valuation is $1.5 million.',                        expected: 1_500_000, name: 'A.04 $1.5M' },
    { text: 'At $150 per month it seems steep.',                 expected: 150,       name: 'A.05 $150/month' },
    { text: 'Range of $120k to $150k annually.',                 expected: 120_000,   name: 'A.06 range lower bound' },
    { text: 'The price is $8,500 per month.',                    expected: 8500,      name: 'A.07 $8,500/month' },
    { text: 'Around $2.5M total for the engagement.',            expected: 2_500_000, name: 'A.08 $2.5M total' },
    { text: 'About 10k annually.',                               expected: 10_000,    name: 'A.09 10k annually' },
    { text: 'Something like $5k-ish per month I think.',         expected: 5000,      name: 'A.10 $5k-ish' },
    { text: 'We have 15 technicians on the road.',               expected: null,      name: 'A.11 15 technicians NOT offer' },
    { text: 'The team has been together for 12 years.',          expected: null,      name: 'A.12 12 years NOT offer' },
    { text: 'Our NPS score is 87 out of 100.',                   expected: null,      name: 'A.13 NPS 87 NOT offer' },
    { text: 'We close about 40 percent of leads.',               expected: null,      name: 'A.14 40 percent NOT offer' },
    { text: 'I have 3 kids.',                                    expected: null,      name: 'A.15 3 kids NOT offer' },
    { text: 'We have been in business for 15 years.',            expected: null,      name: 'A.16 15 years NOT offer' },
    { text: 'The contract was signed in 2019.',                  expected: null,      name: 'A.17 year 2019 NOT offer' },
  ]

  for (const c of cases) {
    const result = extractOffer(c.text)
    record('offer', c.name,
      result === c.expected ? 'PASS' : 'FAIL',
      String(c.expected), String(result)
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE B — INTENT EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

async function suiteIntentExtraction() {
  section('SUITE B — Intent Extraction (adversarial phrasing)')
  const { extractIntent, clearMemory } = await import('./pipeline/memory.js')
  clearMemory()

  const cases: Array<{ text: string; expected: string | null; name: string }> = [
    { text: 'Wow I was not expecting that number.',                    expected: 'PRICE_OBJECTION', name: 'B.01 sticker shock' },
    { text: 'That is a lot for a company our size.',                   expected: 'PRICE_OBJECTION', name: 'B.02 implied price pain' },
    { text: 'I am not sure we would get that value out of it.',        expected: 'PRICE_OBJECTION', name: 'B.03 ROI doubt' },
    { text: 'Fifteen hundred bucks is a lot for us man.',              expected: 'PRICE_OBJECTION', name: 'B.04 slang price shock' },
    { text: 'The valuation seems high for this stage.',                expected: 'PRICE_OBJECTION', name: 'B.05 valuation high' },
    { text: "We can't afford this right now.",                         expected: 'PRICE_OBJECTION', name: 'B.06 standard price' },
    { text: 'Let us circle back on this in a few weeks.',              expected: 'STALLING',        name: 'B.07 circle back' },
    { text: 'This is interesting, we will be in touch.',               expected: 'STALLING',        name: 'B.08 vague positive stall' },
    { text: 'Let me think about it and get back to you.',              expected: 'STALLING',        name: 'B.09 standard stall' },
    { text: 'My business partner would need to weigh in on this.',     expected: 'AUTHORITY',       name: 'B.10 business partner' },
    { text: 'Our team would need to align on something like this.',    expected: 'AUTHORITY',       name: 'B.11 team alignment' },
    { text: 'My wife handles all of our finances.',                    expected: 'AUTHORITY',       name: 'B.12 spouse finances' },
    { text: 'We signed the paperwork with them last Tuesday.',         expected: 'COMPETITOR',      name: 'B.13 signed paperwork' },
    { text: 'We already signed with ServiceTitan.',                    expected: 'COMPETITOR',      name: 'B.14 already signed' },
    { text: 'Happy with our current solution honestly.',               expected: 'COMPETITOR',      name: 'B.15 happy with current' },
    { text: 'Yeah this could really work for us.',                     expected: 'AGREEMENT',       name: 'B.16 soft confirm' },
    { text: "Let's do it, send me the contract.",                      expected: 'AGREEMENT',       name: 'B.17 standard agreement' },
    { text: 'The weather in Dallas has been great.',                   expected: null,              name: 'B.18 irrelevant' },
    { text: 'Hmm.',                                                    expected: null,              name: 'B.19 filler' },
    { text: 'Yeah okay.',                                              expected: null,              name: 'B.20 affirmation' },
  ]

  for (const c of cases) {
    const result = extractIntent(c.text)
    record('intent', c.name,
      result === c.expected ? 'PASS' : 'FAIL',
      String(c.expected), String(result)
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE C — MEMORY STATE
// ─────────────────────────────────────────────────────────────────────────────

async function suiteMemoryState() {
  section('SUITE C — Memory State & Persistence Across Turns')
  const { remember, getContext, clearMemory } = await import('./pipeline/memory.js')

  clearMemory()
  remember('We are thinking $5,000 a month.')
  remember('Actually our budget is $120k for the year.')
  remember('The CFO mentioned a one-time fee of $1.5 million.')
  const ctx1 = getContext()
  record('memory', 'C.01 last offer wins ($1.5M)',
    ctx1.lastOffer === 1_500_000 ? 'PASS' : 'FAIL',
    '1500000', String(ctx1.lastOffer)
  )

  clearMemory()
  remember('The price is $8,500 a month and we are ready to move forward.')
  const ctx2a = getContext()
  record('memory', 'C.02a agreement intent from first turn',
    ctx2a.lastIntent === 'AGREEMENT' ? 'PASS' : 'WARN',
    'AGREEMENT', String(ctx2a.lastIntent)
  )
  remember('Actually that price is way too high. We cannot afford $8,500.')
  const ctx2b = getContext()
  record('memory', 'C.02b intent flips to PRICE_OBJECTION',
    ctx2b.lastIntent === 'PRICE_OBJECTION' ? 'PASS' : 'FAIL',
    'PRICE_OBJECTION', String(ctx2b.lastIntent)
  )
  record('memory', 'C.02c offer persists at $8,500',
    ctx2b.lastOffer === 8500 ? 'PASS' : 'FAIL',
    '8500', String(ctx2b.lastOffer)
  )

  clearMemory()
  remember('The price is $12,000 per month.')
  remember('Okay that works. Let us do this.')
  remember('Actually wait. My partner needs to review it first.')
  remember('Sorry about that. What were we saying about the price?')
  const ctx3 = getContext()
  record('memory', 'C.03a offer persists across 4 turns ($12k)',
    ctx3.lastOffer === 12_000 ? 'PASS' : 'FAIL',
    '12000', String(ctx3.lastOffer)
  )
  record('memory', 'C.03b last intent is AUTHORITY',
    ctx3.lastIntent === 'AUTHORITY' ? 'PASS' : 'FAIL',
    'AUTHORITY', String(ctx3.lastIntent)
  )

  clearMemory()
  remember('We were thinking somewhere in the range of $50k to $80k annually.')
  const ctx4 = getContext()
  record('memory', 'C.04 range lower bound ($50k)',
    ctx4.lastOffer === 50_000 ? 'PASS' : 'FAIL',
    '50000', String(ctx4.lastOffer)
  )

  clearMemory()
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE D — RULES ENGINE
// ─────────────────────────────────────────────────────────────────────────────

async function suiteRules() {
  section('SUITE D — Rules Engine (adversarial phrasing)')
  const { matchRule } = await import('./pipeline/rules.js')

  const cases: Array<{
    text: string
    mode: 'negotiation' | 'meeting' | 'interview' | 'social'
    shouldFire: boolean
    contains?: string
    name: string
  }> = [
    { text: 'That is a lot for a company our size.',               mode: 'negotiation', shouldFire: true,  contains: 'Price',     name: 'D.01 implied price pain' },
    { text: 'I was not expecting that number at all.',             mode: 'negotiation', shouldFire: true,  contains: 'Price',     name: 'D.02 sticker shock' },
    { text: 'Any chance there is wiggle room on that?',            mode: 'negotiation', shouldFire: true,  contains: 'Discount',  name: 'D.03 wiggle room' },
    { text: 'My business partner would need to weigh in.',         mode: 'negotiation', shouldFire: true,  contains: 'Approval',  name: 'D.04 business partner' },
    { text: 'Yeah this could really work for us.',                 mode: 'negotiation', shouldFire: true,  contains: 'Agreement', name: 'D.05 soft agreement' },
    { text: 'Let us circle back in a few weeks.',                  mode: 'negotiation', shouldFire: true,  contains: 'stalled',   name: 'D.06 circle back stall' },
    { text: 'We signed the paperwork with them last week.',        mode: 'negotiation', shouldFire: true,  contains: 'Competitor',name: 'D.07 signed with them' },
    { text: 'We track everything in a spreadsheet and it works.',  mode: 'negotiation', shouldFire: true,  contains: 'Manual',    name: 'D.08 manual tracking' },
    { text: 'The price seems too high for this.',                  mode: 'meeting',     shouldFire: false,                        name: 'D.09 price in meeting no fire' },
    { text: 'Too expensive for us.',                               mode: 'meeting',     shouldFire: false,                        name: 'D.10 expensive in meeting no fire' },
    { text: 'I think conversion is up about 40 percent.',          mode: 'meeting',     shouldFire: true,  contains: 'Stat',      name: 'D.11 stat in meeting' },
    { text: 'Someone should look into that bug.',                  mode: 'meeting',     shouldFire: true,  contains: 'owner',     name: 'D.12 no owner in meeting' },
    { text: 'Nice to meet you.',                                   mode: 'negotiation', shouldFire: false,                        name: 'D.13 pleasantry no fire' },
    { text: 'Hmm.',                                                mode: 'negotiation', shouldFire: false,                        name: 'D.14 filler no fire' },
    { text: 'We are an HVAC company in Dallas.',                   mode: 'negotiation', shouldFire: false,                        name: 'D.15 neutral no fire' },
  ]

  for (const c of cases) {
    const result = matchRule(c.text, c.mode)
    const fired = result !== null
    if (c.shouldFire) {
      const ok = !c.contains || result?.toLowerCase().includes(c.contains.toLowerCase())
      record('rules', c.name,
        fired && ok ? 'PASS' : fired ? 'WARN' : 'FAIL',
        c.contains ? `fires with "${c.contains}"` : 'fires', result
      )
    } else {
      record('rules', c.name,
        !fired ? 'PASS' : 'WARN',
        'null', result, fired ? `false positive: "${result}"` : ''
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE E — PLAYBOOK
// ─────────────────────────────────────────────────────────────────────────────

async function suitePlaybook() {
  section('SUITE E — Playbook Signal Matching & Escalation')
  const { matchPlaybook, executePlay, resetTiers, PLAYBOOK } = await import('./pipeline/playbook.js')

  resetTiers()
  const pp = PLAYBOOK['PRICE_OBJECTION']
  const tiers = [0,1,2,3].map(() => executePlay(pp))
  record('playbook', 'E.01 tier-0 ends with ?',        tiers[0].endsWith('?') ? 'PASS' : 'FAIL', 'ends with ?', tiers[0])
  record('playbook', 'E.02 tier-3 binary=true',        pp.steps[3].binary ? 'PASS' : 'FAIL', 'true', String(pp.steps[3].binary))
  record('playbook', 'E.03 all 4 tiers distinct',      new Set(tiers).size === 4 ? 'PASS' : 'FAIL', '4 unique', `${new Set(tiers).size}`)

  resetTiers()
  const sp = PLAYBOOK['STALL_GENERIC'], dp = PLAYBOOK['DISCOUNT_REQUEST']
  executePlay(sp); executePlay(sp); executePlay(sp)
  const dt0 = executePlay(dp)
  record('playbook', 'E.04 tier isolation',
    dt0 === dp.steps[0].response ? 'PASS' : 'FAIL',
    dp.steps[0].response.slice(0, 40), dt0.slice(0, 40)
  )

  const signalCases: Array<{ text: string; key: string; name: string }> = [
    { text: 'Fifteen hundred bucks is a lot.',          key: 'PRICE_OBJECTION',   name: 'E.05 price slang' },
    { text: 'Yeah okay I am in let us do this.',        key: 'AGREEMENT_SIGNAL',  name: 'E.06 soft agreement' },
    { text: 'Any wiggle room on that price?',           key: 'DISCOUNT_REQUEST',  name: 'E.07 wiggle room' },
    { text: 'We already signed with them last week.',   key: 'PANIC_LOSING',      name: 'E.08 panic' },
    { text: 'Need to check with my business partner.',  key: 'AUTHORITY_BLOCK',   name: 'E.09 authority' },
    { text: 'Happy with our current system honestly.',  key: 'COMPETITOR_LOCKIN', name: 'E.10 competitor' },
    { text: 'Budget is frozen until next quarter.',     key: 'BUDGET_FROZEN',     name: 'E.11 budget frozen' },
    { text: 'Let me think and get back to you.',        key: 'STALL_GENERIC',     name: 'E.12 stall' },
  ]

  for (const c of signalCases) {
    const play = matchPlaybook(c.text)
    record('playbook', c.name, play?.key === c.key ? 'PASS' : 'FAIL', c.key, play?.key ?? 'null')
  }

  resetTiers()
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE F — FOLLOW-UP DETECTION
// ─────────────────────────────────────────────────────────────────────────────

async function suiteFollowUp() {
  section('SUITE F — Follow-Up Detection')
  const { detectFollowUp } = await import('./pipeline/followup.js')

  const cases: Array<{ text: string; expected: 'hot'|'warm'|'cold'|null; name: string }> = [
    { text: 'Send me the contract today and we sign by Friday.',  expected: 'hot',  name: 'F.01 hot — contract today' },
    { text: 'Email me the pricing sheet right now.',              expected: 'hot',  name: 'F.02 hot — pricing now' },
    { text: 'Forward me the proposal and I will look tonight.',   expected: 'hot',  name: 'F.03 hot — forward proposal' },
    { text: "Let's reconnect Thursday to finalize.",              expected: 'warm', name: 'F.04 warm — Thursday' },
    { text: 'I will get back to you by Monday.',                  expected: 'warm', name: 'F.05 warm — Monday' },
    { text: 'Schedule a call with my team next week.',            expected: 'warm', name: 'F.06 warm — next week call' },
    { text: 'Maybe next quarter when our budget opens.',          expected: 'cold', name: 'F.07 cold — next quarter' },
    { text: "Budget is tight, touch base in a few months.",      expected: 'cold', name: 'F.08 cold — few months' },
    { text: "Let's keep in touch.",                              expected: 'cold', name: 'F.09 cold — keep in touch' },
    { text: 'The weather in Dallas has been insane.',             expected: null,   name: 'F.10 null — irrelevant' },
    { text: 'Yeah okay sounds good.',                             expected: null,   name: 'F.11 null — vague positive' },
  ]

  for (const c of cases) {
    const r = detectFollowUp(c.text)
    if (c.expected === null) {
      record('followup', c.name, r === null ? 'PASS' : 'WARN', 'null', r?.priority ?? 'null')
    } else {
      record('followup', c.name, r?.priority === c.expected ? 'PASS' : 'FAIL', c.expected, r?.priority ?? 'null')
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE G — PRESSURE STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────

async function suitePressure() {
  section('SUITE G — Pressure State Machine')
  const { createPressureItem, fireItem, getDueItems, dismissPressure } = await import('./pipeline/pressure.js')

  const srcId = `demo3_${Date.now()}`
  createPressureItem(srcId, 'task', 'Test ladder', null, 'high', 0)

  const states: string[] = []
  for (let i = 0; i < 4; i++) {
    const item = getDueItems(true).find(d => d.sourceId === srcId)
    if (!item) { states.push('NOT_FOUND'); continue }
    states.push(fireItem(item.id)?.state ?? 'null')
  }

  const expected = ['SUGGESTED','REMINDED','ESCALATED','FORCED']
  expected.forEach((exp, i) =>
    record('pressure', `G.0${i+1} state ${exp}`, states[i] === exp ? 'PASS' : 'FAIL', exp, states[i])
  )

  const fi = getDueItems(true).find(d => d.sourceId === srcId)
  if (fi) {
    const r = fireItem(fi.id)
    record('pressure', 'G.05 FORCED has URGENT', r?.message.toLowerCase().includes('urgent') ? 'PASS' : 'FAIL', 'urgent', r?.message ?? 'null')
  }

  const s2 = `demo3_dismiss_${Date.now()}`
  createPressureItem(s2, 'followup', 'Dismiss', null, 'medium', 0)
  dismissPressure(s2, true)
  record('pressure', 'G.06 dismissed gone', !getDueItems(true).find(d => d.sourceId === s2) ? 'PASS' : 'FAIL', 'absent', 'present')

  const s3 = `demo3_dedup_${Date.now()}`
  createPressureItem(s3, 'task', 'Dedup', null, 'low', 0)
  createPressureItem(s3, 'task', 'Dedup', null, 'low', 0)
  record('pressure', 'G.07 dedup', getDueItems(true).filter(d => d.sourceId === s3).length <= 1 ? 'PASS' : 'FAIL', '<=1', String(getDueItems(true).filter(d => d.sourceId === s3).length))
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE H — IDENTITY SCORING
// ─────────────────────────────────────────────────────────────────────────────

async function suiteIdentity() {
  section('SUITE H — Identity Scoring')
  const { scoreIdentity } = await import('./pipeline/identityScore.js')

  const base = { firstSeen: Date.now() - 1000, lastSeen: Date.now(), notes: [] as string[] }

  const maxed = scoreIdentity({ ...base, name: 'max', displayName: 'Max', mentions: 999, tags: ['investor','client'], lastOffer: 10_000_000, lastIntent: 'AGREEMENT' })
  record('identity', 'H.01 score < 1.0',     maxed.score < 1.0 ? 'PASS' : 'FAIL', '< 1.0', String(maxed.score))
  record('identity', 'H.02 maxed CRITICAL',  maxed.level === 'CRITICAL' ? 'PASS' : 'FAIL', 'CRITICAL', maxed.level)

  const inv = scoreIdentity({ ...base, name: 'i', displayName: 'I', mentions: 999, tags: ['investor'], lastOffer: 10_000_000, lastIntent: 'AGREEMENT' })
  const cli = scoreIdentity({ ...base, name: 'c', displayName: 'C', mentions: 999, tags: ['client'],   lastOffer: 10_000_000, lastIntent: 'AGREEMENT' })
  record('identity', 'H.03 investor > client strictly', inv.score > cli.score ? 'PASS' : 'FAIL', `${inv.score} > ${cli.score}`, `inv=${inv.score} cli=${cli.score}`)

  const nobody = scoreIdentity({ ...base, name: 'x', displayName: 'X', mentions: 1, tags: [], lastOffer: null, lastIntent: null, lastSeen: Date.now() - 100_000 })
  record('identity', 'H.04 tagless is LOW', nobody.level === 'LOW' ? 'PASS' : 'FAIL', 'LOW', nobody.level)
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORECARD
// ─────────────────────────────────────────────────────────────────────────────

function printScorecard() {
  console.log(`\n${'═'.repeat(70)}\nEXTREME ADVERSARIAL SCORECARD\n${'═'.repeat(70)}`)
  const suites = [...new Set(results.map(r => r.suite))]
  let tp = 0, tf = 0, tw = 0
  for (const suite of suites) {
    const sr = results.filter(r => r.suite === suite)
    const pass = sr.filter(r => r.verdict === 'PASS').length
    const fail = sr.filter(r => r.verdict === 'FAIL').length
    const warn = sr.filter(r => r.verdict === 'WARN').length
    const pct  = Math.round(pass / sr.length * 100)
    const bar  = '█'.repeat(Math.round(pct/10)) + '░'.repeat(10 - Math.round(pct/10))
    const icon = fail === 0 ? '✅' : pct >= 75 ? '🟡' : '❌'
    console.log(`  ${icon} ${suite.padEnd(22)} ${bar} ${pct}%  (${pass}/${sr.length}${warn ? ` ⚠${warn}` : ''})`)
    tp += pass; tf += fail; tw += warn
  }
  const pct = Math.round(tp / (tp + tf) * 100)
  console.log(`${'─'.repeat(70)}`)
  console.log(`  TOTAL: ${tp} pass / ${tf} fail / ${tw} warn — ${pct}%`)

  const failures = results.filter(r => r.verdict === 'FAIL')
  if (failures.length) {
    console.log(`\n${'─'.repeat(70)}\nFAILURES:`)
    for (const f of failures) {
      console.log(`\n  ❌ [${f.suite}] ${f.name}`)
      console.log(`     expected: ${f.expected}`)
      console.log(`     got:      ${f.got ?? '(null)'}`)
      if (f.note) console.log(`     note:     ${f.note}`)
    }
  }
  console.log(`${'═'.repeat(70)}\n`)
}

async function main() {
  const suiteArg = process.argv.find(a => a.startsWith('--suite='))?.split('=')[1] ?? 'all'
  console.log(`\nARIA EXTREME ADVERSARIAL TEST SUITE\nRunning: ${suiteArg}\n${'═'.repeat(70)}`)

  const suiteMap: Record<string, () => Promise<void>> = {
    offer:    suiteOfferExtraction,
    intent:   suiteIntentExtraction,
    memory:   suiteMemoryState,
    rules:    suiteRules,
    playbook: suitePlaybook,
    followup: suiteFollowUp,
    pressure: suitePressure,
    identity: suiteIdentity,
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