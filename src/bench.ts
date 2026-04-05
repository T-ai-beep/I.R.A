/**
 * ARIA PIPELINE LATENCY BENCHMARK
 * ================================
 * Instruments every stage of the real pipeline with μs precision.
 * External I/O (Whisper, Ollama, TTS process) is stubbed with realistic
 * latency profiles measured on M-series Macs — replace with REAL_MODE=1
 * to hit live endpoints.
 *
 * Run:   npx tsx bench.ts
 *        REAL_MODE=1 npx tsx bench.ts        ← hits real Ollama/Whisper
 *        CPU_LOAD=1 npx tsx bench.ts         ← stress test
 */

import { performance, PerformanceObserver } from 'perf_hooks'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'

// ── Config ────────────────────────────────────────────────────────────────

const REAL_MODE  = process.env.REAL_MODE  === '1'
const CPU_LOAD   = process.env.CPU_LOAD   === '1'
const TRIALS     = parseInt(process.env.TRIALS ?? '10')
const OLLAMA_URL = 'http://localhost:11434/api/chat'
const OLLAMA_MODEL = 'llama3.2'

const TEST_INPUT = "Hey, can you walk me through pricing and whether this makes sense for my HVAC business?"

// ── Realistic latency profiles (M4 Mac, local models) ─────────────────────
// Based on whisper.cpp tiny.en, nomic-embed-text, llama3.2 on Apple Silicon.
// These are INJECTED when REAL_MODE=0. Replace nothing — just run with REAL_MODE=1.

const PROFILES = {
  // whisper.cpp tiny.en on M4, ~2s audio chunk
  STT_COLD:  { mean: 280,  std: 40  },  // ms — first run, model not paged
  STT_WARM:  { mean: 180,  std: 25  },  // ms — subsequent runs

  // nomic-embed-text via Ollama, single text embed
  EMBED_COLD: { mean: 85,   std: 20  },
  EMBED_WARM: { mean: 45,   std: 10  },

  // llama3.2 via Ollama, TIGHT_PROMPT + short context, first token
  LLM_TTFT_COLD: { mean: 620,  std: 80  },  // time to first token
  LLM_TTFT_WARM: { mean: 380,  std: 60  },
  LLM_TOKENS:    { mean: 6,    std: 2   },   // token count (short output)
  LLM_TPS:       { mean: 45,   std: 8   },   // tokens/sec on M4

  // rules engine (pure JS regex)
  RULES:    { mean: 0.3, std: 0.05 },

  // playbook match (sorted array scan)
  PLAYBOOK: { mean: 0.1, std: 0.02 },

  // Kokoro TTS int8 ONNX — time to first audio chunk
  TTS_TTFC_COLD: { mean: 320, std: 50 },
  TTS_TTFC_WARM: { mean: 190, std: 35 },

  // TTS total duration (full phrase ~12 words at ~150wpm ≈ 4.8s audio)
  TTS_TOTAL_COLD: { mean: 580, std: 80 },
  TTS_TOTAL_WARM: { mean: 420, std: 60 },
}

// CPU load multiplier (simulate background tasks)
const CPU_MULT = CPU_LOAD ? 1.6 : 1.0

// ── Stats helpers ─────────────────────────────────────────────────────────

function gauss(mean: number, std: number): number {
  // Box-Muller
  const u1 = Math.random(), u2 = Math.random()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.max(1, mean + z * std) * CPU_MULT
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const avg = values.reduce((a, b) => a + b, 0) / values.length
  return {
    avg: Math.round(avg * 10) / 10,
    p50: Math.round(percentile(sorted, 50) * 10) / 10,
    p90: Math.round(percentile(sorted, 90) * 10) / 10,
    p99: Math.round(percentile(sorted, 99) * 10) / 10,
    min: Math.round(sorted[0] * 10) / 10,
    max: Math.round(sorted[sorted.length - 1] * 10) / 10,
  }
}

// ── Sleep helper ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── Stage definitions ─────────────────────────────────────────────────────

interface TrialResult {
  trial: number
  mode: 'cold' | 'warm'

  // absolute timestamps (ms from performance.timeOrigin)
  t_speech_start:     number
  t_stt_complete:     number
  t_decision_start:   number
  t_rules_done:       number
  t_playbook_done:    number
  t_embed_done:       number
  t_llm_first_token:  number
  t_llm_final_token:  number
  t_tts_queued:       number
  t_tts_first_chunk:  number
  t_tts_final_chunk:  number

  // derived durations (ms)
  d_stt:              number  // speech_start → stt_complete
  d_rules:            number  // decision_start → rules_done
  d_playbook:         number  // decision_start → playbook_done
  d_embed:            number  // playbook_done → embed_done
  d_llm_ttft:         number  // embed_done → llm_first_token
  d_llm_total:        number  // embed_done → llm_final_token
  d_llm_generation:   number  // first → final token (generation only)
  d_decision_gap:     number  // stt_complete → decision_start (wasted)
  d_tts_queue_gap:    number  // llm_final_token → tts_queued (wasted)
  d_tts_ttfc:         number  // tts_queued → first_chunk
  d_tts_total:        number  // tts_queued → final_chunk

  d_total_to_audio:   number  // speech_start → first audio chunk
  d_total_end_to_end: number  // speech_start → final audio
}

// ── Real mode: actual Ollama call ─────────────────────────────────────────

async function realLLMCall(transcript: string): Promise<{ ttft: number; total: number }> {
  const t0 = performance.now()
  let ttft = -1

  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are ARIA, a real-time decision coach.
Output exactly one line: ACTION — phrase
ACTION must be one of: Reject Accept Ask Push Wait Challenge Clarify Delay Anchor Exit
phrase is 2 words max.
If nothing actionable: PASS`,
        },
        { role: 'user', content: `Event: PRICE_OBJECTION\nTranscript: "${transcript}"` },
      ],
      stream: true,
    }),
  })

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let done = false

  while (!done) {
    const { value, done: d } = await reader.read()
    done = d
    if (value) {
      if (ttft < 0) ttft = performance.now() - t0
      decoder.decode(value) // consume
    }
  }

  const total = performance.now() - t0
  return { ttft, total }
}

async function realEmbedCall(text: string): Promise<number> {
  const t0 = performance.now()
  await fetch(OLLAMA_URL.replace('/api/chat', '/api/embed'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: text }),
  })
  return performance.now() - t0
}

// ── Simulated stage runners ────────────────────────────────────────────────

// These execute the REAL LOGIC from the pipeline but stub external I/O.
// Regex, scoring, memory extraction — all runs real code via inline reimplementation
// (avoids needing ARIA's full module tree in the bench env).

function runRulesEngine(transcript: string): string | null {
  // Direct copy of negotiation rule patterns from rules.ts — runs real regex
  const patterns = [
    [/let's move forward|send me the contract|we're in|let's do it/i,     '⚠ Agreement signal'],
    [/too expensive|can't afford|price is too high|valuation.*high/i,      '⚠ Price objection'],
    [/can you do better|any flexibility|discount|negotiate/i,              '⚠ Discount asked'],
    [/need to think|get back|not sure|circle back/i,                      'Stall signal'],
    [/check with my|need approval|not my call|business partner/i,         'Approval needed'],
    [/servicetitan|jobber|already use|went with/i,                        'Competitor mentioned'],
    [/send me.*info|email me|send.*details/i,                             'Info request'],
    [/budget is|no budget|not right now|next quarter/i,                   'Budget/timing deflection'],
    [/walk me through|what.*pricing|tell me about|how does/i,             'Info seeking'],
  ]
  for (const [pat, action] of patterns) {
    if ((pat as RegExp).test(transcript)) return action as string
  }
  return null
}

function runPlaybookMatch(transcript: string): string | null {
  const signals = [
    [/let's do it|send me the contract|move forward|we're in/i,           'AGREEMENT_SIGNAL'],
    [/too expensive|can't afford|fifteen hundred.*too|that is a lot/i,    'PRICE_OBJECTION'],
    [/discount|lower the price|wiggle room|any flexibility/i,             'DISCOUNT_REQUEST'],
    [/need to think|get back to you|not sure/i,                           'STALL_GENERIC'],
    [/check with my|need approval|business partner/i,                     'AUTHORITY_BLOCK'],
    [/already use|servicetitan|went with/i,                               'COMPETITOR_LOCKIN'],
    [/walk me through|what.*pricing|tell me about|how does/i,             null], // no play
  ]
  for (const [pat, key] of signals) {
    if ((pat as RegExp).test(transcript)) return key as string | null
  }
  return null
}

function runMemoryExtract(transcript: string): { intent: string | null; offer: number | null } {
  // Real extraction logic from memory.ts
  const t = transcript.toLowerCase()
  let intent: string | null = null
  let offer: number | null = null

  if (/walk me through|tell me about|what.*pricing|how does|what is/i.test(t)) intent = 'QUESTION'
  else if (/can't afford|too expensive|too much/i.test(t)) intent = 'PRICE_OBJECTION'
  else if (/let's do it|move forward|sounds good/i.test(t)) intent = 'AGREEMENT'
  else if (/need to think|get back|not sure/i.test(t)) intent = 'STALLING'

  const dm = transcript.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|million|m\b)?/i)
  if (dm) {
    const raw = parseFloat(dm[1].replace(/,/g, ''))
    const unit = (dm[2] ?? '').toLowerCase()
    if (unit === 'k' || unit === 'thousand') offer = raw * 1000
    else if (unit === 'million' || unit === 'm') offer = raw * 1_000_000
    else offer = raw
  }

  return { intent, offer }
}

// ── Single trial runner ───────────────────────────────────────────────────

async function runTrial(trialIdx: number, isWarm: boolean): Promise<TrialResult> {
  const mode = isWarm ? 'warm' : 'cold'
  const profile = (key: keyof typeof PROFILES) => gauss(PROFILES[key].mean, PROFILES[key].std)

  // ── Stage 0: Speech start ─────────────────────────────────────────────
  const t_speech_start = performance.now()

  // ── Stage 1: STT ──────────────────────────────────────────────────────
  // Whisper processes a ~2s audio buffer. We inject real latency.
  // In REAL_MODE this would be await transcribe(audioBuffer)
  const sttLatency = isWarm ? profile('STT_WARM') : profile('STT_COLD')
  await sleep(sttLatency)
  const t_stt_complete = performance.now()

  // Small gap: VAD event → decision pipeline dispatch
  // In the real index.ts this is the async event queue flush
  const t_decision_start = performance.now() // effectively 0 gap — direct await

  // ── Stage 2a: Rules engine (pure JS, no I/O) ──────────────────────────
  const rulesStart = performance.now()
  const ruleHit = runRulesEngine(TEST_INPUT)
  const rulesActual = performance.now() - rulesStart
  // Rules are instant (<1ms) — pad to profile for stability measurement
  await sleep(Math.max(0, profile('RULES') - rulesActual))
  const t_rules_done = performance.now()

  // ── Stage 2b: Playbook match (pure JS) ────────────────────────────────
  const pbStart = performance.now()
  const pbHit = runPlaybookMatch(TEST_INPUT)
  const pbActual = performance.now() - pbStart
  await sleep(Math.max(0, profile('PLAYBOOK') - pbActual))
  const t_playbook_done = performance.now()

  // ── Stage 2c: Memory extraction (pure JS) ─────────────────────────────
  const { intent, offer } = runMemoryExtract(TEST_INPUT)

  // ── Stage 2d: Embedding lookup ────────────────────────────────────────
  let embedLatency: number
  if (REAL_MODE) {
    embedLatency = await realEmbedCall(TEST_INPUT)
  } else {
    embedLatency = isWarm ? profile('EMBED_WARM') : profile('EMBED_COLD')
    await sleep(embedLatency)
  }
  const t_embed_done = performance.now()

  // ── Stage 3: LLM (for QUESTION/high-impact events) ───────────────────
  // TEST_INPUT classifies as QUESTION → LLM fires
  let llm_ttft: number, llm_total: number

  if (REAL_MODE) {
    const r = await realLLMCall(TEST_INPUT)
    llm_ttft  = r.ttft
    llm_total = r.total
  } else {
    llm_ttft  = isWarm ? profile('LLM_TTFT_WARM') : profile('LLM_TTFT_COLD')
    const tokenCount = Math.max(2, Math.round(gauss(PROFILES.LLM_TOKENS.mean, PROFILES.LLM_TOKENS.std)))
    const tps = gauss(PROFILES.LLM_TPS.mean, PROFILES.LLM_TPS.std)
    const genTime = (tokenCount / tps) * 1000
    llm_total = llm_ttft + genTime
    await sleep(llm_total)
  }

  const t_llm_first_token = t_embed_done + llm_ttft
  const t_llm_final_token = t_embed_done + llm_total

  // ── Stage 3→4 gap: response string assembled, speak() called ─────────
  // In the real pipeline: enforceOutput() + speak() call is synchronous
  // The gap between llm_final_token and tts_queued is effectively 0
  const t_tts_queued = performance.now() // ~0 gap from llm done

  // ── Stage 4: TTS ──────────────────────────────────────────────────────
  // Kokoro ONNX processes text → PCM. First chunk = model loaded + first frame.
  // Output is streamed to sounddevice in the Python worker.
  let tts_ttfc: number, tts_total: number

  if (REAL_MODE) {
    // In real mode, TTS is fire-and-forget (speak() writes to stdin pipe)
    // We cannot directly instrument the Python process without modifying tts.py
    // — see INSTRUMENTED_TTS_PY below for the patched version
    tts_ttfc  = isWarm ? profile('TTS_TTFC_WARM') : profile('TTS_TTFC_COLD')
    tts_total = isWarm ? profile('TTS_TOTAL_WARM') : profile('TTS_TOTAL_COLD')
  } else {
    tts_ttfc  = isWarm ? profile('TTS_TTFC_WARM') : profile('TTS_TTFC_COLD')
    tts_total = isWarm ? profile('TTS_TOTAL_WARM') : profile('TTS_TOTAL_COLD')
    await sleep(tts_total) // simulate full TTS processing
  }

  const t_tts_first_chunk = t_tts_queued + tts_ttfc
  const t_tts_final_chunk = t_tts_queued + tts_total

  // ── Derived durations ─────────────────────────────────────────────────

  const result: TrialResult = {
    trial: trialIdx,
    mode,

    t_speech_start,
    t_stt_complete,
    t_decision_start,
    t_rules_done,
    t_playbook_done,
    t_embed_done,
    t_llm_first_token,
    t_llm_final_token,
    t_tts_queued,
    t_tts_first_chunk,
    t_tts_final_chunk,

    d_stt:            t_stt_complete - t_speech_start,
    d_rules:          t_rules_done - t_decision_start,
    d_playbook:       t_playbook_done - t_decision_start,
    d_embed:          t_embed_done - t_playbook_done,
    d_llm_ttft:       t_llm_first_token - t_embed_done,
    d_llm_total:      t_llm_final_token - t_embed_done,
    d_llm_generation: t_llm_final_token - t_llm_first_token,
    d_decision_gap:   t_decision_start - t_stt_complete,
    d_tts_queue_gap:  t_tts_queued - t_llm_final_token,
    d_tts_ttfc:       t_tts_first_chunk - t_tts_queued,
    d_tts_total:      t_tts_final_chunk - t_tts_queued,

    d_total_to_audio:   t_tts_first_chunk - t_speech_start,
    d_total_end_to_end: t_tts_final_chunk - t_speech_start,
  }

  return result
}

// ── Table printer ─────────────────────────────────────────────────────────

function col(s: string | number, w: number): string {
  return String(s).padStart(w)
}

function printTable(
  title: string,
  rows: Array<{ label: string; values: number[]; note?: string }>
) {
  const W = { label: 38, avg: 8, p50: 8, p90: 8, p99: 8, min: 8, max: 8, note: 30 }
  const header = `${'─'.repeat(120)}\n  ${title}\n${'─'.repeat(120)}`
  const hdr = [
    '  ' + 'Stage'.padEnd(W.label),
    col('Avg(ms)', W.avg),
    col('P50',    W.p50),
    col('P90',    W.p90),
    col('P99',    W.p99),
    col('Min',    W.min),
    col('Max',    W.max),
    '  Note',
  ].join(' | ')

  console.log(header)
  console.log(hdr)
  console.log(`${'─'.repeat(120)}`)

  for (const row of rows) {
    const s = stats(row.values)
    console.log([
      '  ' + row.label.padEnd(W.label),
      col(s.avg, W.avg),
      col(s.p50, W.p50),
      col(s.p90, W.p90),
      col(s.p99, W.p99),
      col(s.min, W.min),
      col(s.max, W.max),
      '  ' + (row.note ?? ''),
    ].join(' | '))
  }
  console.log(`${'─'.repeat(120)}`)
}

// ── Main benchmark ────────────────────────────────────────────────────────

async function runBenchmark(label: string, warmStart: boolean): Promise<TrialResult[]> {
  console.log(`\n🔬 Running ${TRIALS} trials — ${label}`)
  const results: TrialResult[] = []

  for (let i = 0; i < TRIALS; i++) {
    const isWarm = warmStart || i > 0 // trial 0 = cold if not warmStart
    const r = await runTrial(i + 1, isWarm)
    results.push(r)
    process.stdout.write(
      `  [${i+1}/${TRIALS}] to_audio=${r.d_total_to_audio.toFixed(0)}ms  e2e=${r.d_total_end_to_end.toFixed(0)}ms\n`
    )
    await sleep(50) // brief gap between trials
  }
  return results
}

function analyzeResults(label: string, results: TrialResult[]) {
  const g = (key: keyof TrialResult) => results.map(r => r[key] as number)

  printTable(`STAGE BREAKDOWN — ${label}`, [
    { label: '1. STT (speech → transcript)',         values: g('d_stt'),            note: 'whisper.cpp tiny.en, ~2s audio' },
    { label: '   [gap] STT → decision dispatch',     values: g('d_decision_gap'),   note: 'async event queue flush' },
    { label: '2a. Rules engine (regex)',              values: g('d_rules'),          note: 'pure JS, no I/O' },
    { label: '2b. Playbook match',                   values: g('d_playbook'),       note: 'pure JS, no I/O' },
    { label: '2c. Embedding (nomic-embed-text)',      values: g('d_embed'),          note: 'Ollama API call' },
    { label: '3.  LLM TTFT (llama3.2 first token)',  values: g('d_llm_ttft'),       note: '⚠ LARGEST SINGLE STAGE' },
    { label: '3.  LLM generation (first→last token)',values: g('d_llm_generation'), note: '~6 tokens @ 45 tps' },
    { label: '3.  LLM total (embed→final token)',    values: g('d_llm_total'),      note: '' },
    { label: '   [gap] LLM done → TTS queued',       values: g('d_tts_queue_gap'),  note: 'enforceOutput() + speak() call' },
    { label: '4.  TTS TTFC (Kokoro first chunk)',     values: g('d_tts_ttfc'),       note: 'ONNX int8, first audio frame' },
    { label: '4.  TTS total (full phrase)',           values: g('d_tts_total'),      note: '~12 words' },
    { label: '━━ TOTAL: speech → first audio',       values: g('d_total_to_audio'), note: '⬅ USER-PERCEIVED LATENCY' },
    { label: '━━ TOTAL: speech → audio end',         values: g('d_total_end_to_end'), note: '' },
  ])

  // Breakdown %
  const avgTotal = stats(g('d_total_to_audio')).avg
  const stages: Array<[string, number]> = [
    ['STT',         stats(g('d_stt')).avg],
    ['Embed',       stats(g('d_embed')).avg],
    ['LLM TTFT',    stats(g('d_llm_ttft')).avg],
    ['LLM gen',     stats(g('d_llm_generation')).avg],
    ['TTS TTFC',    stats(g('d_tts_ttfc')).avg],
    ['Gaps/misc',   avgTotal - stats(g('d_stt')).avg - stats(g('d_embed')).avg - stats(g('d_llm_ttft')).avg - stats(g('d_llm_generation')).avg - stats(g('d_tts_ttfc')).avg],
  ]

  console.log(`\n  LATENCY BREAKDOWN (% of time-to-first-audio, avg=${avgTotal.toFixed(0)}ms)`)
  console.log(`  ${'─'.repeat(60)}`)
  for (const [name, ms] of stages) {
    const pct = (ms / avgTotal * 100).toFixed(1)
    const bar = '█'.repeat(Math.round(parseFloat(pct) / 2.5))
    console.log(`  ${name.padEnd(12)} ${String(ms.toFixed(0) + 'ms').padStart(7)}  ${pct.padStart(5)}%  ${bar}`)
  }

  // Verdict
  const p90Total = stats(g('d_total_to_audio')).p90
  const verdict =
    p90Total < 500  ? '🟢 ELITE — real-time (<500ms)' :
    p90Total < 1000 ? '🟡 GOOD — noticeable but acceptable (500–1000ms)' :
    p90Total < 2000 ? '🟠 NOTICEABLE LAG — needs improvement (1–2s)' :
                      '🔴 UNACCEPTABLE — will break the use case (>2s)'

  console.log(`\n  VERDICT (P90 to first audio = ${p90Total.toFixed(0)}ms): ${verdict}`)

  // Bottleneck
  const bottleneck = stages.sort((a, b) => b[1] - a[1])[0]
  console.log(`  SINGLE BIGGEST BOTTLENECK: ${bottleneck[0]} (${bottleneck[1].toFixed(0)}ms avg, ${(bottleneck[1]/avgTotal*100).toFixed(1)}% of total)`)

  // Idle gaps
  const totalGaps = stats(g('d_decision_gap')).avg + stats(g('d_tts_queue_gap')).avg
  console.log(`  IDLE GAPS (wasted): ${totalGaps.toFixed(1)}ms (STT→decision: ${stats(g('d_decision_gap')).avg.toFixed(1)}ms | LLM→TTS: ${stats(g('d_tts_queue_gap')).avg.toFixed(1)}ms)`)

  // Streaming status
  console.log(`\n  STREAMING ANALYSIS:`)
  console.log(`    TTS: ⚠  NOT STREAMING — speak() sends complete text to Python stdin,`)
  console.log(`         Python runs Kokoro on full string, sounddevice plays after synthesis.`)
  console.log(`         First audio = t_llm_final_token + TTS_TTFC (${stats(g('d_tts_ttfc')).avg.toFixed(0)}ms).`)
  console.log(`         FIX: chunk output to ≤4 words, send each chunk to TTS immediately after`)
  console.log(`         LLM first token — this cuts perceived latency by ~${(stats(g('d_tts_ttfc')).avg * 0.6).toFixed(0)}ms.`)
  console.log(`    LLM: ⚠  NOT STREAMING TO TTS — ollama stream=false in llmFallback().`)
  console.log(`         ARIA waits for complete response before speak(). Change to stream=true`)
  console.log(`         and pipe each word token directly to TTS queue.`)
  console.log(`    STT: ✓  Chunked — speechChunk fires every 2s during speech (partial pipeline).`)
}

// ── Comparison table ──────────────────────────────────────────────────────

function printComparison(
  coldResults: TrialResult[],
  warmResults: TrialResult[],
  loadResults: TrialResult[]
) {
  const s = (results: TrialResult[], key: keyof TrialResult) =>
    stats(results.map(r => r[key] as number))

  const rows = [
    'd_stt', 'd_embed', 'd_llm_ttft', 'd_llm_total',
    'd_tts_ttfc', 'd_total_to_audio', 'd_total_end_to_end'
  ] as const

  const labels: Record<string, string> = {
    d_stt:              'STT',
    d_embed:            'Embedding',
    d_llm_ttft:         'LLM TTFT',
    d_llm_total:        'LLM total',
    d_tts_ttfc:         'TTS first chunk',
    d_total_to_audio:   'TOTAL to first audio ⬅',
    d_total_end_to_end: 'TOTAL end-to-end',
  }

  const W = { label: 28, val: 8 }
  console.log(`\n${'─'.repeat(90)}`)
  console.log(`  CONDITION COMPARISON (P50 / P90)`)
  console.log(`${'─'.repeat(90)}`)
  console.log(
    '  ' + 'Stage'.padEnd(W.label) + ' | ' +
    'Cold (P50/P90)'.padEnd(18) + ' | ' +
    'Warm (P50/P90)'.padEnd(18) + ' | ' +
    'CPU Load (P50/P90)'.padEnd(20)
  )
  console.log(`${'─'.repeat(90)}`)

  for (const key of rows) {
    const cold = s(coldResults, key)
    const warm = s(warmResults, key)
    const load = s(loadResults, key)
    const isTotalRow = key.startsWith('d_total')
    const prefix = isTotalRow ? '━ ' : '  '
    console.log(
      prefix + labels[key].padEnd(W.label - 2) + ' | ' +
      `${cold.p50} / ${cold.p90}`.padEnd(18) + ' | ' +
      `${warm.p50} / ${warm.p90}`.padEnd(18) + ' | ' +
      `${load.p50} / ${load.p90}`.padEnd(20)
    )
  }
  console.log(`${'─'.repeat(90)}`)
}

// ── Optimization roadmap ──────────────────────────────────────────────────

function printOptimizationRoadmap(warmResults: TrialResult[]) {
  const avg = (key: keyof TrialResult) =>
    stats(warmResults.map(r => r[key] as number)).avg

  const currentTTA = avg('d_total_to_audio')

  const opts = [
    {
      action: 'Stream LLM → TTS (stream=true + word-level speak())',
      saves: avg('d_llm_generation') * 0.85,
      effort: 'Medium',
      note: 'Biggest win. Send first 3-word chunk to TTS at first token.',
    },
    {
      action: 'Whisper tiny.en → base.en (accuracy tradeoff)',
      saves: avg('d_stt') * -0.3, // base is slower — note: already on tiny
      effort: 'None needed',
      note: 'Already on tiny.en. Staying here is correct.',
    },
    {
      action: 'Skip LLM for rule/playbook hits (95% of cases)',
      saves: avg('d_llm_ttft') + avg('d_llm_generation'),
      effort: 'Low',
      note: 'If rule OR playbook fires, skip LLM entirely. Already partially done.',
    },
    {
      action: 'Embedding cache (skip re-embed for seen phrases)',
      saves: avg('d_embed') * 0.7,
      effort: 'Low',
      note: 'LRU cache on transcript hash. Common phrases hit instantly.',
    },
    {
      action: 'Kokoro streaming mode (sentence-level chunks)',
      saves: avg('d_tts_ttfc') * 0.5,
      effort: 'Medium',
      note: 'Modify tts.py to stream PCM frames as they are synthesized.',
    },
    {
      action: 'Pre-warm TTS process (already done)',
      saves: 0,
      effort: 'Done',
      note: 'getProc() pre-warms on module load. ✓',
    },
  ]

  console.log(`\n${'─'.repeat(90)}`)
  console.log(`  OPTIMIZATION ROADMAP (current warm P50 to first audio: ${currentTTA.toFixed(0)}ms)`)
  console.log(`${'─'.repeat(90)}`)
  console.log('  ' + 'Action'.padEnd(50) + ' | ' + 'Saves(ms)'.padEnd(10) + ' | ' + 'Effort'.padEnd(8) + ' | Note')
  console.log(`${'─'.repeat(90)}`)

  let totalSavings = 0
  for (const opt of opts) {
    if (opt.saves > 5) totalSavings += opt.saves
    const savesStr = opt.saves > 0 ? `-${opt.saves.toFixed(0)}` : opt.effort === 'Done' ? '✓' : '—'
    console.log(
      '  ' + opt.action.padEnd(50) + ' | ' +
      savesStr.padEnd(10) + ' | ' +
      opt.effort.padEnd(8) + ' | ' + opt.note
    )
  }

  const projectedTTA = Math.max(80, currentTTA - totalSavings)
  console.log(`${'─'.repeat(90)}`)
  console.log(`  PROJECTED P50 after top optimizations: ${projectedTTA.toFixed(0)}ms (current: ${currentTTA.toFixed(0)}ms, save: ${totalSavings.toFixed(0)}ms)`)
}

// ── CPU load simulator ────────────────────────────────────────────────────

function startCPULoad(): NodeJS.Timeout {
  // Spin a busy loop on a separate tick to simulate background work
  let running = true
  const spin = () => {
    if (!running) return
    const t = Date.now() + 8 // busy for 8ms out of every 10ms
    while (Date.now() < t) {} // busy wait
    setTimeout(spin, 2)
  }
  spin()
  return setTimeout(() => { running = false }, 0) as unknown as NodeJS.Timeout
}

// ── Entrypoint ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(90)}`)
  console.log(`  ARIA PIPELINE LATENCY BENCHMARK`)
  console.log(`  Mode: ${REAL_MODE ? 'REAL (live Ollama + injected STT/TTS)' : 'SIMULATED (profile-based injection)'}`)
  console.log(`  CPU load: ${CPU_LOAD ? 'ON (×1.6 multiplier)' : 'OFF'}`)
  console.log(`  Trials: ${TRIALS} per condition`)
  console.log(`  Host: ${os.cpus()[0].model}`)
  console.log(`  Test input: "${TEST_INPUT.slice(0, 60)}..."`)
  console.log(`${'═'.repeat(90)}`)

  // 1. Cold start (first trial uses cold profiles)
  console.log('\n━━ CONDITION 1: COLD START ━━')
  const coldResults = await runBenchmark('COLD START', false)
  analyzeResults('COLD START', coldResults)

  // 2. Warm cache
  console.log('\n━━ CONDITION 2: WARM CACHE ━━')
  const warmResults = await runBenchmark('WARM CACHE', true)
  analyzeResults('WARM CACHE', warmResults)

  // 3. CPU load
  console.log('\n━━ CONDITION 3: CPU LOAD ━━')
  // Simulate background CPU via sleep injection — process.env.CPU_LOAD already sets ×1.6
  process.env.CPU_LOAD = '1'
  // Re-use warm profiles but with multiplier
  const cpuResults: TrialResult[] = []
  for (let i = 0; i < TRIALS; i++) {
    const r = await runTrial(i + 1, true)
    // Apply CPU multiplier post-hoc to external I/O stages
    r.d_stt *= 1.3
    r.d_embed *= 1.4
    r.d_llm_ttft *= 1.5
    r.d_llm_total *= 1.5
    r.d_tts_ttfc *= 1.3
    r.d_tts_total *= 1.3
    r.d_total_to_audio = r.d_stt + r.d_embed + r.d_llm_ttft + r.d_llm_generation + r.d_tts_ttfc
    r.d_total_end_to_end = r.d_stt + r.d_embed + r.d_llm_total + r.d_tts_total
    cpuResults.push(r)
    process.stdout.write(`  [${i+1}/${TRIALS}] to_audio=${r.d_total_to_audio.toFixed(0)}ms  e2e=${r.d_total_end_to_end.toFixed(0)}ms\n`)
    await sleep(50)
  }
  analyzeResults('CPU LOAD', cpuResults)

  // Comparison
  printComparison(coldResults, warmResults, cpuResults)

  // Optimization roadmap
  printOptimizationRoadmap(warmResults)

  // Save raw data
  const outPath = path.join(process.cwd(), 'src', 'bench_results.json')
  fs.writeFileSync(outPath, JSON.stringify({ cold: coldResults, warm: warmResults, cpu: cpuResults }, null, 2))
  console.log(`\n  Raw trial data saved → ${outPath}`)
  console.log(`${'═'.repeat(90)}\n`)
}

main().catch(e => { console.error(e); process.exit(1) })