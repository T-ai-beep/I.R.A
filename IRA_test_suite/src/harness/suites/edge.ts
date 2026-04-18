/**
 * suites/edge.ts — SUITE 3: Edge Cases (Break It)
 */

import { record, section } from '../runner.js'
const SUITE = 'edge'

export async function run(): Promise<void> {
  section('SUITE 3 — Edge Cases (Break It)')

  const { decide, setMode } = await import("../../../../src/pipeline/decision.js")
  const { resetTiers } = await import("../../../../src/pipeline/playbook.js")
  const { clearMemory } = await import("../../../../src/pipeline/memory.js")

  setMode('negotiation')

  // ── EDGE-001: Partial / cut-off sentences ──────────────────────────────
  const cutoffs = [
    { text: 'we can\'t aff',                name: 'EDGE-001a', shouldFire: false },
    { text: 'send me the',                   name: 'EDGE-001b', shouldFire: false },
    { text: 'i need to',                     name: 'EDGE-001c', shouldFire: false },
    { text: 'let\'s',                        name: 'EDGE-001d', shouldFire: false },
    { text: 'the price is',                  name: 'EDGE-001e', shouldFire: false },
  ]

  for (const c of cutoffs) {
    resetTiers(); clearMemory()
    let threw = false, response: string | null = null
    try { response = await decide(c.text) } catch { threw = true }

    record(
      SUITE, c.name, `Cut-off sentence does not crash: "${c.text}"`,
      'CRITICAL', !threw ? 'PASS' : 'FAIL',
      'no exception',
      threw ? 'THREW EXCEPTION' : (response ?? 'null'),
      'Cut-off speech should degrade gracefully'
    )
  }

  // ── EDGE-002: Repeated identical phrase — cache coherence ─────────────
  clearMemory(); resetTiers()
  const repeatText = "we can't afford this right now"
  const repeatResults: (string | null)[] = []

  for (let i = 0; i < 10; i++) {
    resetTiers()
    repeatResults.push(await decide(repeatText))
  }

  const nonNull = repeatResults.filter(r => r !== null)
  record(
    SUITE, 'EDGE-002a', 'Repeated transcript: all 10 calls return results',
    'HIGH', nonNull.length === 10 ? 'PASS' : 'FAIL',
    '10/10 non-null',
    `${nonNull.length}/10 non-null`
  )

  // First responses should be same playbook tier (tier resets)
  const uniqueResponses = new Set(repeatResults.filter(r => r !== null))
  // With tier reset, all 10 should be tier-0 (same response)
  record(
    SUITE, 'EDGE-002b', 'Repeated transcript with tier reset: consistent response',
    'MEDIUM', uniqueResponses.size === 1 ? 'PASS' : 'WARN',
    '1 unique response (tier-0)',
    `${uniqueResponses.size} unique responses`,
    'Without resetTiers(), tier advances — this tests reset behavior'
  )

  // ── EDGE-003: Sarcasm / tone mismatch ────────────────────────────────
  // "Oh great, another SaaS that will solve all our problems" should NOT
  // trigger an agreement signal even though it sounds positive.
  const sarcasticCases = [
    { text: 'oh great another tool that will solve everything',  name: 'EDGE-003a' },
    { text: 'yeah sure we\'ll totally move forward with this',   name: 'EDGE-003b' },
    { text: 'sounds amazing i\'m sure it\'ll work perfectly',    name: 'EDGE-003c' },
  ]

  for (const c of sarcasticCases) {
    resetTiers(); clearMemory()
    const response = await decide(c.text)
    const isAgreementFire = /agreement|close now|confirm terms/i.test(response ?? '')

    record(
      SUITE, c.name, `Sarcasm: no false-positive agreement on "${c.text.slice(0, 45)}"`,
      'MEDIUM', !isAgreementFire ? 'PASS' : 'WARN',
      'no agreement fire',
      response,
      isAgreementFire ? 'Sarcasm treated as genuine agreement — false positive' : ''
    )
  }

  // ── EDGE-004: Contradictory turns ─────────────────────────────────────
  clearMemory(); resetTiers()
  const { remember } = await import("../../../../src/pipeline/memory.js")

  // Turn 1: agreement
  remember("okay let's do it send me the contract")
  // Turn 2: complete reversal
  const turn2 = await decide("actually never mind we are not interested anymore")

  record(
    SUITE, 'EDGE-004a', 'Contradictory turn: reversal after agreement fires',
    'HIGH', turn2 !== null ? 'PASS' : 'WARN',
    'non-null (stall/exit signal)',
    turn2,
    'Hard reversal after verbal yes — system should detect and respond'
  )

  // ── EDGE-005: Very long rambling input ────────────────────────────────
  clearMemory(); resetTiers()
  const ramble = 'so what we have been thinking about is that there are a lot of different factors ' +
    'that go into this decision and we need to consider all of them carefully before we make ' +
    'any kind of commitment because this is a big investment and there are other vendors and ' +
    'we just need more time and also our team needs to align and budget is tight and timing ' +
    'is not great right now and we are also evaluating other solutions simultaneously'

  let ramblerThrew = false
  let ramblerResponse: string | null = null
  try { ramblerResponse = await decide(ramble) } catch { ramblerThrew = true }

  record(
    SUITE, 'EDGE-005a', 'Long rambling input: no crash',
    'CRITICAL', !ramblerThrew ? 'PASS' : 'FAIL',
    'no exception',
    ramblerThrew ? 'THREW EXCEPTION' : (ramblerResponse ?? 'null')
  )
  record(
    SUITE, 'EDGE-005b', 'Long rambling input: fires a response (not silent)',
    'MEDIUM', ramblerResponse !== null ? 'PASS' : 'WARN',
    'non-null — rambling should trigger',
    ramblerResponse,
    'Long rambling with multiple signals should trigger the highest-priority one'
  )

  // ── EDGE-006: Empty / whitespace / noise tokens ───────────────────────
  const noiseInputs = [
    { text: '',           name: 'EDGE-006a' },
    { text: '   ',        name: 'EDGE-006b' },
    { text: '[BLANK]',    name: 'EDGE-006c' }, // Whisper noise token
    { text: '[_BG_]',     name: 'EDGE-006d' }, // Whisper background token
    { text: 'hmm',        name: 'EDGE-006e' },
    { text: '.',          name: 'EDGE-006f' },
  ]

  for (const c of noiseInputs) {
    resetTiers()
    let threw = false, response: string | null = null
    try { response = await decide(c.text) } catch { threw = true }

    record(
      SUITE, c.name, `Noise token "${c.text}" does not crash`,
      'CRITICAL', !threw ? 'PASS' : 'FAIL',
      'no exception (null response ok)',
      threw ? 'THREW EXCEPTION' : (response ?? 'null (correct)')
    )
  }

  // ── EDGE-007: Stacked signals — priority resolution ───────────────────
  // Price + stall in same sentence: price should win (higher priority)
  resetTiers(); clearMemory()
  const stacked = await decide("the price is too high and i need to think about it")

  record(
    SUITE, 'EDGE-007a', 'Stacked signals: price beats stall',
    'HIGH', /price|hold|afford|ROI|cost|number/i.test(stacked ?? '') ? 'PASS' : 'FAIL',
    'price objection response (priority 11 > stall priority 10)',
    stacked
  )

  // Agreement + immediate backtrack
  resetTiers(); clearMemory()
  const backtrack = await decide("okay yes let's do it actually wait never mind")

  record(
    SUITE, 'EDGE-007b', 'Agreement + immediate backtrack: fires something',
    'MEDIUM', backtrack !== null ? 'PASS' : 'WARN',
    'non-null (ambiguous signal handled)',
    backtrack
  )

  // ── EDGE-008: Unicode / non-ASCII input ───────────────────────────────
  const unicodeInputs = [
    { text: 'el precio es muy alto para nosotros',  name: 'EDGE-008a' }, // Spanish
    { text: '价格太高了',                             name: 'EDGE-008b' }, // Chinese
    { text: 'that\u2019s too much \u2014 we can\u2019t',  name: 'EDGE-008c' }, // Smart quotes
  ]

  for (const c of unicodeInputs) {
    resetTiers(); clearMemory()
    let threw = false
    try { await decide(c.text) } catch { threw = true }

    record(
      SUITE, c.name, `Unicode input does not crash: "${c.text.slice(0, 30)}"`,
      'HIGH', !threw ? 'PASS' : 'FAIL',
      'no exception',
      threw ? 'THREW EXCEPTION' : 'handled'
    )
  }

  // ── EDGE-009: Rapid burst after long pause ────────────────────────────
  // Simulate: pause → rapid 3 calls. No call should block others.
  await new Promise(r => setTimeout(r, 200)) // simulate pause

  resetTiers(); clearMemory()
  const burstStart = Date.now()
  const burstResults = await Promise.allSettled([
    decide("we can't afford it"),
    decide("let's move forward"),
    decide("send me the details"),
  ])
  const burstMs = Date.now() - burstStart
  const burstFails = burstResults.filter(r => r.status === 'rejected').length

  record(
    SUITE, 'EDGE-009a', 'Rapid burst: no rejections',
    'HIGH', burstFails === 0 ? 'PASS' : 'FAIL',
    '0 rejections',
    `${burstFails} rejections out of 3`
  )
  record(
    SUITE, 'EDGE-009b', 'Rapid burst: completes in < 1500ms total',
    'MEDIUM', burstMs < 1500 ? 'PASS' : 'WARN',
    '< 1500ms for 3 concurrent calls',
    `${burstMs}ms`
  )
}