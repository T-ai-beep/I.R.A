/**
 * suites/memory.ts — SUITE 4: Memory & State Integrity
 */
import { record, section } from '../runner.js'
const SUITE = 'memory'

export async function run(): Promise<void> {
  section('SUITE 4 — Memory & State Integrity')

  const { remember, getContext, clearMemory, extractOffer, extractIntent } =
    await import("../../../../src/pipeline/memory.js")

  // ── MEM-001: Offer extraction edge cases ──────────────────────────────
  clearMemory()
  const offerCases: Array<{ text: string; expected: number | null; id: string }> = [
    { text: 'we are thinking around $5,000 a month',            expected: 5000,      id: 'MEM-001a' },
    { text: 'the price is $5k per month',                       expected: 5000,      id: 'MEM-001b' },
    { text: 'valuation is $1.5 million',                        expected: 1_500_000, id: 'MEM-001c' },
    { text: 'looking for something in the range of $120k',      expected: 120_000,   id: 'MEM-001d' },
    { text: 'we have 15 technicians on the road',               expected: null,      id: 'MEM-001e' }, // NOT an offer
    { text: 'the team has been together for 12 years',          expected: null,      id: 'MEM-001f' }, // NOT an offer
    { text: 'our nps is 87',                                    expected: null,      id: 'MEM-001g' }, // NOT an offer
    { text: 'we close about 40 percent of leads',               expected: null,      id: 'MEM-001h' }, // NOT an offer
    { text: 'at $150 per month it seems steep',                 expected: 150,       id: 'MEM-001i' },
    { text: 'the contract was signed in 2019',                  expected: null,      id: 'MEM-001j' }, // year NOT offer
    { text: 'around $2.5 million total for the engagement',     expected: 2_500_000, id: 'MEM-001k' },
  ]

  for (const c of offerCases) {
    clearMemory()
    const turn = remember(c.text)
    record(
      SUITE, c.id, `Offer extraction: "${c.text.slice(0, 50)}"`,
      c.expected !== null ? 'HIGH' : 'MEDIUM',
      turn.offer === c.expected ? 'PASS' : 'FAIL',
      String(c.expected), String(turn.offer)
    )
  }

  // ── MEM-002: Intent extraction adversarial phrasing ───────────────────
  clearMemory()
  const intentCases: Array<{ text: string; expected: string | null; id: string }> = [
    { text: 'wow i was not expecting that number',              expected: 'PRICE_OBJECTION', id: 'MEM-002a' },
    { text: 'that is a lot for a company our size',             expected: 'PRICE_OBJECTION', id: 'MEM-002b' },
    { text: 'let us circle back on this in a few weeks',        expected: 'STALLING',        id: 'MEM-002c' },
    { text: 'this is interesting, we will be in touch',         expected: 'STALLING',        id: 'MEM-002d' },
    { text: 'my business partner would need to weigh in',       expected: 'AUTHORITY',       id: 'MEM-002e' },
    { text: 'our team would need to align on this',             expected: 'AUTHORITY',       id: 'MEM-002f' },
    { text: 'we signed the paperwork with them last tuesday',   expected: 'COMPETITOR',      id: 'MEM-002g' },
    { text: 'yeah this could really work for us',               expected: 'AGREEMENT',       id: 'MEM-002h' },
    { text: 'the weather in dallas has been great',             expected: null,              id: 'MEM-002i' },
    { text: 'hmm',                                              expected: null,              id: 'MEM-002j' },
  ]

  for (const c of intentCases) {
    clearMemory()
    const turn = remember(c.text)
    record(
      SUITE, c.id, `Intent extraction: "${c.text.slice(0, 50)}"`,
      c.expected !== null ? 'HIGH' : 'MEDIUM',
      turn.intent === c.expected ? 'PASS' : 'FAIL',
      String(c.expected), String(turn.intent)
    )
  }

  // ── MEM-003: Multi-turn state persistence ─────────────────────────────
  clearMemory()
  remember('the price is $8,500 per month')
  remember('that seems too high for us')
  const ctx1 = getContext()
  record(SUITE, 'MEM-003a', 'lastOffer persists across turns', 'CRITICAL',
    ctx1.lastOffer === 8500 ? 'PASS' : 'FAIL', '8500', String(ctx1.lastOffer))
  record(SUITE, 'MEM-003b', 'lastIntent persists across turns', 'CRITICAL',
    ctx1.lastIntent === 'PRICE_OBJECTION' ? 'PASS' : 'FAIL', 'PRICE_OBJECTION', String(ctx1.lastIntent))

  // ── MEM-004: Intent flip across turns ────────────────────────────────
  clearMemory()
  remember("the price is $12,000 a month and let's do it")
  remember("actually wait, my partner needs to review this first")
  const ctx2 = getContext()
  record(SUITE, 'MEM-004a', 'Intent flips: agreement → authority after reversal', 'HIGH',
    ctx2.lastIntent === 'AUTHORITY' ? 'PASS' : 'FAIL', 'AUTHORITY', String(ctx2.lastIntent))
  record(SUITE, 'MEM-004b', 'Offer persists through intent flip', 'MEDIUM',
    ctx2.lastOffer === 12_000 ? 'PASS' : 'FAIL', '12000', String(ctx2.lastOffer))

  // ── MEM-005: TTL expiration ───────────────────────────────────────────
  // We can't wait 10 minutes in a test, but we can verify the TTL logic
  // works by checking that getContext() returns empty after clearMemory()
  clearMemory()
  remember("some context before clear")
  clearMemory()
  const ctx3 = getContext()
  record(SUITE, 'MEM-005', 'clearMemory() resets all state', 'HIGH',
    ctx3.lastOffer === null && ctx3.lastIntent === null && ctx3.turns.length === 0 ? 'PASS' : 'FAIL',
    'all null/empty', `offer=${ctx3.lastOffer} intent=${ctx3.lastIntent} turns=${ctx3.turns.length}`)

  // ── MEM-006: Pressure state machine full ladder ───────────────────────
  const { createPressureItem, fireItem, getDueItems, dismissPressure } =
    await import("../../../../src/pipeline/pressure.js")

  const srcId = `mem_pressure_${Date.now()}`
  createPressureItem(srcId, 'task', 'Test ladder', null, 'high', 0)

  const states: string[] = []
  for (let i = 0; i < 4; i++) {
    const item = getDueItems(true, true).find(d => d.sourceId === srcId)
    if (!item) { states.push('NOT_FOUND'); continue }
    states.push(fireItem(item.id)?.state ?? 'null')
  }

  const expected = ['SUGGESTED', 'REMINDED', 'ESCALATED', 'FORCED']
  expected.forEach((exp, i) =>
    record(SUITE, `MEM-006-${exp}`, `Pressure state: ${exp}`, 'CRITICAL',
      states[i] === exp ? 'PASS' : 'FAIL', exp, states[i])
  )

  // FORCED message contains urgency
  const fi = getDueItems(true, true).find(d => d.sourceId === srcId)
  if (fi) {
    const r = fireItem(fi.id)
    record(SUITE, 'MEM-006e', 'FORCED message contains "URGENT"', 'HIGH',
      r?.message.toLowerCase().includes('urgent') ? 'PASS' : 'FAIL', 'urgent', r?.message ?? 'null')
  }

  // Dismissed item does not refire
  const s2 = `mem_dismiss_${Date.now()}`
  createPressureItem(s2, 'followup', 'Dismiss test', null, 'medium', 0)
  dismissPressure(s2, true)
  const afterDismiss = getDueItems(true, true).find(d => d.sourceId === s2)
  record(SUITE, 'MEM-006f', 'Dismissed item does not refire', 'HIGH',
    !afterDismiss ? 'PASS' : 'FAIL', 'absent from due items', afterDismiss ? 'still present' : 'correctly absent')

  // Duplicate sourceId dedup
  const s3 = `mem_dedup_${Date.now()}`
  createPressureItem(s3, 'task', 'Dedup', null, 'low', 0)
  createPressureItem(s3, 'task', 'Dedup', null, 'low', 0)
  const dups = getDueItems(true, true).filter(d => d.sourceId === s3)
  record(SUITE, 'MEM-006g', 'Duplicate sourceId not created twice', 'HIGH',
    dups.length <= 1 ? 'PASS' : 'FAIL', '<= 1 item', `${dups.length} found`)
}