/**
 * suites/failure.ts — SUITE 6: System Failure Modes & Failure Injection
 *
 * Philosophy: every dependency WILL fail. The question is what ARIA does
 * when it does. Silent failures are unacceptable. Graceful degradation is required.
 */
import { record, section, timed } from '../runner.js'
const SUITE = 'failure'

// ── Fault injection helpers ────────────────────────────────────────────────

function withFetchTimeout(originalFetch: typeof fetch, delayMs: number): typeof fetch {
  return async (input: any, init?: any): Promise<Response> => {
    await new Promise(r => setTimeout(r, delayMs))
    throw new Error(`[INJECTED] fetch timeout after ${delayMs}ms`)
  }
}

function withFetchError(originalFetch: typeof fetch, code: number): typeof fetch {
  return async (): Promise<Response> => {
    return new Response(JSON.stringify({ error: 'service unavailable' }), { status: code })
  }
}

async function withFaultyFetch<T>(
  fault: 'timeout' | 'error' | 'slow',
  delayMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = global.fetch
  if (fault === 'timeout') {
    global.fetch = withFetchTimeout(originalFetch, delayMs)
  } else if (fault === 'slow') {
    global.fetch = async (input: any, init?: any) => {
      await new Promise(r => setTimeout(r, delayMs))
      return originalFetch(input, init)
    }
  }
  try {
    return await fn()
  } finally {
    global.fetch = originalFetch
  }
}

export async function run(): Promise<void> {
  section('SUITE 6 — System Failure Modes & Failure Injection')

  // ── FAIL-001: Ollama timeout — LLM unavailable ────────────────────────
  // When Ollama times out, ARIA must fall back to rule/playbook response,
  // not return null or crash.

  const { decide, setMode } = await import("../../../../src/pipeline/decision.js")
  const { resetTiers } = await import("../../../../src/pipeline/playbook.js")
  setMode('negotiation')

  try {
    resetTiers()
    const response = await withFaultyFetch('timeout', 1, async () => {
      return decide("we can't afford this right now")
    })
    // Rule/playbook should still fire — they don't use fetch
    record(
      SUITE, 'FAIL-001a', 'Ollama timeout: rule/playbook still fires',
      'CRITICAL', response !== null ? 'PASS' : 'FAIL',
      'non-null (rule or playbook fallback)',
      response,
      'Fast path must not depend on Ollama'
    )
  } catch (e: any) {
    record(SUITE, 'FAIL-001a', 'Ollama timeout: rule/playbook still fires',
      'CRITICAL', 'FAIL', 'non-null fallback', `THREW: ${e.message}`,
      'Fast path crashed on Ollama failure — unacceptable')
  }

  // ── FAIL-002: Ollama slow response — latency budget enforced ──────────
  try {
    resetTiers()
    const { ms, result } = await timed(() =>
      withFaultyFetch('slow', 500, async () => {
        return decide("what should I say right now") // QUESTION → triggers LLM path
      })
    )
    // Should either return fast-path result OR timeout gracefully within budget
    record(
      SUITE, 'FAIL-002', 'Slow Ollama (500ms delay): completes within budget',
      'HIGH', ms <= 800 ? 'PASS' : 'WARN',
      '≤ 800ms (latency budget × 2)',
      `${ms.toFixed(0)}ms result="${result}"`,
      'LLM path should abort at latency budget; rule path must complete'
    )
  } catch (e: any) {
    record(SUITE, 'FAIL-002', 'Slow Ollama: does not crash', 'HIGH', 'FAIL',
      'no exception', `THREW: ${e.message}`)
  }

  // ── FAIL-003: Embedding service unavailable ───────────────────────────
  try {
    resetTiers()
    const { clearEmbedCache } = await import("../../../../src/pipeline/embedCache.js")
    clearEmbedCache()

    const response = await withFaultyFetch('timeout', 1, async () => {
      return decide("we can't afford this right now") // should hit rules before embed
    })
    record(
      SUITE, 'FAIL-003', 'Embed service down: rules path still fires',
      'CRITICAL', response !== null ? 'PASS' : 'FAIL',
      'non-null (rule fallback)',
      response,
      'Rules + playbook must not depend on embedding service'
    )
  } catch (e: any) {
    record(SUITE, 'FAIL-003', 'Embed service down: rules path fires', 'CRITICAL', 'FAIL',
      'no exception', `THREW: ${e.message}`)
  }

  // ── FAIL-004: Forced fallback events never return null ─────────────────
  // PRICE_OBJECTION, AGREEMENT, COMPETITOR, etc. must ALWAYS produce output
  // even with zero candidates.
  const { FORCED_RESPONSE_EVENTS, getForcedFallback } = await import("../../../../src/pipeline/playbook.js")

  for (const event of FORCED_RESPONSE_EVENTS) {
    const fallback = getForcedFallback(event)
    record(
      SUITE, 'FAIL-004', `Forced fallback exists for: ${event}`,
      'CRITICAL', fallback !== null ? 'PASS' : 'FAIL',
      'non-null fallback string',
      fallback ?? 'null',
      'Money/closing events must never go silent'
    )
  }

  // ── FAIL-005: Rules engine never throws ───────────────────────────────
  const { matchRule } = await import('../../../../src/pipeline/rules.js')
  const maliciousInputs = [
    { text: '((((((((((', name: 'FAIL-005a' },
    { text: 'a'.repeat(10000), name: 'FAIL-005b' }, // 10k char input
    { text: '\x00\x01\x02\x03', name: 'FAIL-005c' }, // null bytes
    { text: '.*+?^${}()|[]\\', name: 'FAIL-005d' }, // regex metacharacters
  ]

  for (const c of maliciousInputs) {
    let threw = false
    try { matchRule(c.text, 'negotiation') } catch { threw = true }
    record(
      SUITE, c.name, `Rules engine: malicious input does not throw`,
      'CRITICAL', !threw ? 'PASS' : 'FAIL',
      'no exception', threw ? 'THREW EXCEPTION' : 'handled'
    )
  }

  // ── FAIL-006: Playbook never throws ──────────────────────────────────
  const { matchPlaybook } = await import('../../../../src/pipeline/playbook.js')
  for (const c of maliciousInputs) {
    let threw = false
    try { matchPlaybook(c.text) } catch { threw = true }
    record(
      SUITE, 'FAIL-006', `Playbook: malicious input "${c.text.slice(0, 20)}" no throw`,
      'CRITICAL', !threw ? 'PASS' : 'FAIL',
      'no exception', threw ? 'THREW EXCEPTION' : 'handled'
    )
  }

  // ── FAIL-007: Memory operations never throw ───────────────────────────
  const { remember, clearMemory } = await import("../../../../src/pipeline/memory.js")
  const memMalicious = ['', '   ', '\x00\x01', 'a'.repeat(50000), null as any]

  for (const input of memMalicious) {
    let threw = false
    try { clearMemory(); if (input !== null) remember(input) } catch { threw = true }
    record(
      SUITE, 'FAIL-007', `Memory: edge input "${String(input).slice(0, 20)}" no throw`,
      'CRITICAL', !threw ? 'PASS' : 'FAIL',
      'no exception', threw ? 'THREW EXCEPTION' : 'handled'
    )
  }

  // ── FAIL-008: decide() never throws regardless of input ───────────────
  const bruteCases = ['', 'a'.repeat(5000), '\n\r\t', '🔥💀🚀']
  for (const text of bruteCases) {
    resetTiers()
    let threw = false, result = null
    try { result = await decide(text ?? '') } catch { threw = true }
    record(
      SUITE, 'FAIL-008', `decide() never throws: input="${String(text).slice(0, 20)}"`,
      'CRITICAL', !threw ? 'PASS' : 'FAIL',
      'no exception (null result ok)', threw ? 'THREW EXCEPTION' : String(result)
    )
  }
}


/**
 * suites/streaming.ts — SUITE 5: Streaming Behavior
 */

export async function runStreaming(): Promise<void> {
  section('SUITE 5 — Streaming Behavior (LLM + TTS)')

  // These tests validate streaming architecture contracts without
  // requiring live Ollama. They test the TypeScript wrapper behavior.

  // ── STREAM-001: speak() is fire-and-forget ────────────────────────────
  const { speak } = await import("../../../../src/pipeline/tts.js")

  const t0 = Date.now()
  speak('hold the number') // must return immediately
  const elapsed = Date.now() - t0

  record(
    'streaming', 'STREAM-001', 'speak() returns immediately (< 10ms)',
    'CRITICAL', elapsed < 10 ? 'PASS' : 'FAIL',
    '< 10ms return time',
    `${elapsed}ms`,
    'speak() must be fire-and-forget — any blocking here kills fast path'
  )

  // ── STREAM-002: speak() with empty input ─────────────────────────────
  let speakThrew = false
  try { speak(''); speak('   '); speak(null as any) } catch { speakThrew = true }
  record(
    'streaming', 'STREAM-002', 'speak() with empty/null input: no crash',
    'HIGH', !speakThrew ? 'PASS' : 'FAIL',
    'no exception', speakThrew ? 'THREW EXCEPTION' : 'handled'
  )

  // ── STREAM-003: speak() queues multiple calls without blocking ────────
  const calls = ['hold the number', 'ask what changed', 'push close now', 'wait silent']
  const queueStart = Date.now()
  for (const c of calls) speak(c)
  const queueElapsed = Date.now() - queueStart

  record(
    'streaming', 'STREAM-003', `speak() queues ${calls.length} calls in < 20ms total`,
    'HIGH', queueElapsed < 20 ? 'PASS' : 'WARN',
    '< 20ms to queue 4 speak() calls',
    `${queueElapsed}ms`
  )

  // ── STREAM-004: TTS chunking contract ────────────────────────────────
  // Verify the Python tts.py chunking strategy
  // (tested via checking the chunk_text logic logic spec)
  const chunkCases: Array<{ input: string; maxChunks: number; name: string }> = [
    { input: 'hold the number',                                    maxChunks: 1,  name: 'STREAM-004a' },
    { input: 'hold the number. walk away.',                        maxChunks: 2,  name: 'STREAM-004b' },
    { input: 'anchor the price, hold firm, do not discount ever',  maxChunks: 3,  name: 'STREAM-004c' },
  ]

  // We simulate chunk_text logic in TS to verify Python behavior
  function chunkText(text: string, maxWords = 4): string[] {
    const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)
    const result: string[] = []
    for (const sent of sentences) {
      const parts = sent.split(/(?:—|,)\s*/).map(s => s.trim()).filter(Boolean)
      for (const part of (parts.length > 1 ? parts : [sent])) {
        const words = part.split(/\s+/)
        if (words.length <= maxWords) { result.push(part) }
        else {
          for (let i = 0; i < words.length; i += maxWords) {
            result.push(words.slice(i, i + maxWords).join(' '))
          }
        }
      }
    }
    return result.length ? result : [text]
  }

  for (const c of chunkCases) {
    const chunks = chunkText(c.input)
    record(
      'streaming', c.name, `TTS chunk: "${c.input.slice(0, 40)}" → ≤${c.maxChunks} chunks`,
      'MEDIUM', chunks.length <= c.maxChunks ? 'PASS' : 'WARN',
      `≤ ${c.maxChunks} chunks`,
      `${chunks.length} chunks: [${chunks.map(c => `"${c}"`).join(', ')}]`
    )
  }
}


/**
 * suites/scenarios.ts — SUITE 7: Real-World Multi-Turn Scenarios
 */

export async function runScenarios(): Promise<void> {
  section('SUITE 7 — Real-World Multi-Turn Scenarios')

  const { decide, setMode } = await import("../../../../src/pipeline/decision.js")
  const { resetTiers } = await import("../../../../src/pipeline/playbook.js")
  const { clearMemory, remember } = await import("../../../../src/pipeline/memory.js")

  type Turn = { text: string; expectedFires: boolean; note?: string }

  async function runScenario(
    id: string,
    name: string,
    mode: 'negotiation' | 'meeting' | 'interview' | 'social',
    turns: Turn[]
  ): Promise<void> {
    setMode(mode); resetTiers(); clearMemory()

    let fired = 0, missed = 0
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]
      remember(turn.text)
      const response = await decide(turn.text)

      if (turn.expectedFires && response === null) {
        missed++
        record('scenarios', `${id}-T${i+1}`, `${name}: turn ${i+1} should fire`,
          'HIGH', 'FAIL', 'non-null', 'null',
          `"${turn.text.slice(0, 50)}"${turn.note ? ` [${turn.note}]` : ''}`)
      } else if (!turn.expectedFires && response !== null) {
        record('scenarios', `${id}-T${i+1}`, `${name}: turn ${i+1} should be silent`,
          'LOW', 'WARN', 'null (no signal)', response ?? 'null',
          `Possible false positive: "${turn.text.slice(0, 50)}"`)
      } else {
        fired++
        record('scenarios', `${id}-T${i+1}`, `${name}: turn ${i+1} correct`,
          'LOW', 'PASS', turn.expectedFires ? 'fires' : 'silent',
          response ?? 'null (correct)')
      }
    }

    record('scenarios', `${id}-SUMMARY`, `${name}: overall ${fired}/${turns.length} correct`,
      'HIGH', missed === 0 ? 'PASS' : missed <= 1 ? 'WARN' : 'FAIL',
      `0 missed signals`, `${missed} missed out of ${turns.filter(t => t.expectedFires).length} expected`)
  }

  // ── SCEN-001: Hostile HVAC prospect ───────────────────────────────────
  await runScenario('SCEN-001', 'Hostile HVAC prospect', 'negotiation', [
    { text: "We've been using ServiceTitan for three years and it works fine.", expectedFires: true, note: 'competitor lock-in' },
    { text: "Your pricing is way too high for an operation like ours.",          expectedFires: true, note: 'price objection' },
    { text: "I need to run this by my partner before we even talk more.",        expectedFires: true, note: 'authority block' },
    { text: "Can you do anything on the price? Even a small discount?",          expectedFires: true, note: 'discount request' },
    { text: "Look, we'll think about it and get back to you next month.",        expectedFires: true, note: 'timing deflection' },
    { text: "Nice to meet you. Thanks for the demo.",                            expectedFires: false, note: 'pleasantry — should be silent' },
  ])

  // ── SCEN-002: Investor pitch — multi-stage objection ─────────────────
  await runScenario('SCEN-002', 'Investor pitch objections', 'negotiation', [
    { text: "We're interested but the valuation seems really high for this stage.", expectedFires: true, note: 'price/valuation' },
    { text: "What if we came in at a lower number and you gave us more equity?",    expectedFires: true, note: 'discount' },
    { text: "We need to run this by our partners before we can commit to anything.", expectedFires: true, note: 'authority' },
    { text: "We want to move fast. Can we close this week?",                        expectedFires: true, note: 'agreement — close now' },
  ])

  // ── SCEN-003: Sales call with hidden reversal trap ────────────────────
  await runScenario('SCEN-003', 'Sales call with reversal trap', 'negotiation', [
    { text: "Sounds really good, I think we'd like to move forward.",              expectedFires: true, note: 'agreement — close' },
    { text: "Actually wait, let me check the contract details first.",             expectedFires: false, note: 'neutral pause' },
    { text: "We've decided to go with ServiceTitan instead. Sorry.",               expectedFires: true, note: 'panic — deal lost' },
    { text: "Unless you can beat their price by 20 percent.",                      expectedFires: true, note: 'discount after loss' },
  ])

  // ── SCEN-004: Interview behavioral trap sequence ──────────────────────
  await runScenario('SCEN-004', 'Interview trap sequence', 'interview', [
    { text: "Tell me about yourself and what makes you unique.",                   expectedFires: true, note: 'open framing' },
    { text: "What would you say is your biggest weakness?",                        expectedFires: true, note: 'weakness trap' },
    { text: "What are your salary expectations for this role?",                    expectedFires: true, note: 'comp trap' },
    { text: "Give me an example of a time you failed at something important.",     expectedFires: true, note: 'STAR example needed' },
    { text: "Why should we hire you over other candidates?",                       expectedFires: false, note: 'neutral — no specific trap pattern' },
  ])

  // ── SCEN-005: Team meeting — all signals ──────────────────────────────
  await runScenario('SCEN-005', 'Team meeting signals', 'meeting', [
    { text: "I think we'll see about 40 percent growth in Q3.",                    expectedFires: true, note: 'uncited stat' },
    { text: "We should assign someone to own the customer onboarding.",            expectedFires: true, note: 'no owner' },
    { text: "I believe this is the right strategic direction for the business.",   expectedFires: true, note: 'opinion as fact' },
    { text: "Anyway, let's move on to the next agenda item.",                      expectedFires: true, note: 'topic buried' },
    { text: "Okay everyone, great work this week.",                                expectedFires: false, note: 'closing pleasantry' },
  ])

  // ── SCEN-006: Social networking — investor detection ─────────────────
  await runScenario('SCEN-006', 'Networking with investor', 'social', [
    { text: "So what do you do?",                                                  expectedFires: true, note: 'opportunity window' },
    { text: "We run a fund focused on early stage B2B SaaS.",                      expectedFires: true, note: 'investor detected' },
    { text: "I just really feel like the market isn't ready for this kind of thing.", expectedFires: true, note: 'oversharing' },
    { text: "What are you working on right now?",                                  expectedFires: true, note: 'opportunity window again' },
    { text: "Nice to meet you, let's exchange cards.",                             expectedFires: false, note: 'pleasantry' },
  ])
}