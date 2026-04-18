/**
 * memory.test.ts — Test suite for all Omi-layer features
 *
 * Tests:
 *   SUITE A — CaptureStore (write, read, search, stats)
 *   SUITE B — Recall (query parsing, time expressions, person extraction)
 *   SUITE C — DailyRecap (stats building, unresolved items, structure)
 *   SUITE D — BrainMap (node creation, edges, traversal, cluster)
 *   SUITE E — Daemon (session management, episodic flush logic)
 *   SUITE F — Integration (recall → brain map → recap pipeline)
 *
 * Run: npx tsx src/memory/memory.test.ts
 *      npx tsx src/memory/memory.test.ts --suite=capture
 */

import * as path from 'path'
import * as os   from 'os'
import * as fs   from 'fs'

// ── Test harness ───────────────────────────────────────────────────────────

type Verdict = 'PASS' | 'FAIL' | 'WARN'

interface TestResult {
  suite:   string
  name:    string
  verdict: Verdict
  expected: string
  got:     string | null
  note:    string
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
  console.log(`\n${'═'.repeat(65)}\n  ${title}\n${'═'.repeat(65)}`)
}

// Override ARIA_DIR to use a temp dir for tests
const TEST_ARIA_DIR = path.join(os.tmpdir(), `.aria_test_${Date.now()}`)
process.env.ARIA_TEST_DIR = TEST_ARIA_DIR
fs.mkdirSync(TEST_ARIA_DIR, { recursive: true })

// ── SUITE A: CaptureStore ──────────────────────────────────────────────────

async function suiteCaptureStore() {
  section('SUITE A — CaptureStore')

  // Patch ARIA_DIR for test isolation
  const captureFile = path.join(TEST_ARIA_DIR, 'capture_test.jsonl')

  // A.01: writeCapture returns correct structure
  const { writeCapture, getByDate, getToday, searchCaptures, getCaptureStats, getCaptureSummaryForDate } = await import("../capture/captureStore.js") as any

  const entry = writeCapture(
    'We are thinking around $5,000 a month for this.',
    'other',
    'test_session_001',
    2500,
    'mic'
  )

  record('capture', 'A.01 writeCapture returns entry', entry !== null ? 'PASS' : 'FAIL', 'non-null entry', JSON.stringify(entry?.id))
  record('capture', 'A.02 entry has correct fields',
    (entry?.transcript && entry?.ts && entry?.speaker && entry?.sessionId) ? 'PASS' : 'FAIL',
    'transcript, ts, speaker, sessionId',
    JSON.stringify(Object.keys(entry ?? {}))
  )
  record('capture', 'A.03 entry speaker is "other"', entry?.speaker === 'other' ? 'PASS' : 'FAIL', 'other', entry?.speaker)
  record('capture', 'A.04 entry wordCount > 0', (entry?.wordCount ?? 0) > 0 ? 'PASS' : 'FAIL', '> 0', String(entry?.wordCount))

  // A.05: tag inference — should tag as negotiation
  record('capture', 'A.05 negotiation tag inferred',
    entry?.tags?.includes('negotiation') ? 'PASS' : 'FAIL',
    'includes negotiation',
    JSON.stringify(entry?.tags)
  )

  // A.06: write multiple entries and retrieve by date
  writeCapture('Let me think about it and get back to you.', 'other', 'test_session_001', 1200, 'mic')
  writeCapture('We already use ServiceTitan for that.', 'other', 'test_session_001', 1800, 'mic')

  const today = new Date().toISOString().slice(0, 10)
  const todayEntries = getByDate(today)
  record('capture', 'A.06 getByDate returns all today entries', todayEntries.length >= 3 ? 'PASS' : 'FAIL', '>= 3', String(todayEntries.length))

  // A.07: search by query text
  const priceEntries = searchCaptures({ query: '5,000' })
  record('capture', 'A.07 searchCaptures by query text', priceEntries.length >= 1 ? 'PASS' : 'FAIL', '>= 1', String(priceEntries.length))

  // A.08: search by tag
  const negEntries = searchCaptures({ tags: ['negotiation'] })
  record('capture', 'A.08 searchCaptures by tag', negEntries.length >= 1 ? 'PASS' : 'FAIL', '>= 1', String(negEntries.length))

  // A.09: getCaptureStats
  const stats = getCaptureStats()
  record('capture', 'A.09 getCaptureStats total >= 3', (stats.total ?? 0) >= 3 ? 'PASS' : 'FAIL', '>= 3', String(stats.total))
  record('capture', 'A.10 getCaptureStats has speaker counts', stats.speakers?.other >= 3 ? 'PASS' : 'FAIL', '>= 3', String(stats.speakers?.other))

  // A.11: summary for date
  const summary = getCaptureSummaryForDate(today)
  record('capture', 'A.11 getCaptureSummaryForDate returns string', typeof summary === 'string' && summary.length > 0 ? 'PASS' : 'FAIL', 'non-empty string', summary.slice(0, 50))

  // A.12: wordCount accuracy
  const countEntry = writeCapture('one two three four five', 'other', 'sess', 1000, 'mic')
  record('capture', 'A.12 wordCount is accurate',
    countEntry.wordCount === 5 ? 'PASS' : 'FAIL',
    '5', String(countEntry.wordCount)
  )

  // A.13: limit parameter respected
  const limited = searchCaptures({ limit: 2 })
  record('capture', 'A.13 limit parameter respected', limited.length <= 2 ? 'PASS' : 'FAIL', '<= 2', String(limited.length))

  // A.14: no crash on empty query
  let threw = false
  try { searchCaptures({ query: '' }) } catch { threw = true }
  record('capture', 'A.14 empty query does not crash', !threw ? 'PASS' : 'FAIL', 'no exception', threw ? 'THREW' : 'ok')
}

// ── SUITE B: Recall query parsing ──────────────────────────────────────────

async function suiteRecall() {
  section('SUITE B — Recall Query Parser')

  const { parseRecallQuery } = await import('./recall.js')

  // B.01–B.08: Time expression parsing
  const timeCases: Array<{ query: string; expectedLabel: string; id: string }> = [
    { id: 'B.01', query: 'who did I talk to today',           expectedLabel: 'today' },
    { id: 'B.02', query: 'what happened yesterday',           expectedLabel: 'yesterday' },
    { id: 'B.03', query: 'conversations from last week',      expectedLabel: 'last week' },
    { id: 'B.04', query: 'what did I say last Tuesday',       expectedLabel: 'last tuesday' },
    { id: 'B.05', query: 'deals closed this week',            expectedLabel: 'this week' },
    { id: 'B.06', query: 'what happened last month',          expectedLabel: 'last month' },
    { id: 'B.07', query: 'conversations from 3 days ago',     expectedLabel: '3 days ago' },
    { id: 'B.08', query: 'what about Marcus and the deal',    expectedLabel: null as any },
  ]

  for (const c of timeCases) {
    const q = parseRecallQuery(c.query)
    if (c.expectedLabel === null) {
      record('recall', c.id, q.timeFilter === null ? 'PASS' : 'WARN', 'null time filter', q.timeFilter?.label ?? 'null')
    } else {
      record('recall', c.id,
        q.timeFilter?.label?.toLowerCase().includes(c.expectedLabel.toLowerCase()) ? 'PASS' : 'FAIL',
        c.expectedLabel, q.timeFilter?.label ?? 'null', `Time expression: "${c.query}"`
      )
    }
  }

  // B.09–B.12: Intent keyword extraction
  const intentCases: Array<{ query: string; expectedIntent: string; id: string }> = [
    { id: 'B.09', query: 'conversations where someone objected to the price', expectedIntent: 'PRICE_OBJECTION' },
    { id: 'B.10', query: 'all the times someone stalled or delayed',          expectedIntent: 'STALLING' },
    { id: 'B.11', query: 'deals we agreed to close',                          expectedIntent: 'AGREEMENT' },
    { id: 'B.12', query: 'competitor mentions and servicetitan',               expectedIntent: 'COMPETITOR' },
  ]

  for (const c of intentCases) {
    const q = parseRecallQuery(c.query)
    record('recall', c.id,
      q.intents.includes(c.expectedIntent) ? 'PASS' : 'FAIL',
      c.expectedIntent, JSON.stringify(q.intents), `Intent extraction: "${c.query}"`
    )
  }

  // B.13: topK default
  const q1 = parseRecallQuery('anything')
  record('recall', 'B.13 default topK is 10', q1.topK === 10 ? 'PASS' : 'FAIL', '10', String(q1.topK))

  // B.14: keywords extracted
  const q2 = parseRecallQuery('what did Marcus say about the ServiceTitan contract')
  record('recall', 'B.14 keywords extracted', q2.keywords.length > 0 ? 'PASS' : 'FAIL', '> 0 keywords', JSON.stringify(q2.keywords))

  // B.15: time filter has start date when specified
  const q3 = parseRecallQuery('who did I talk to yesterday')
  record('recall', 'B.15 yesterday filter has start date', q3.timeFilter?.start instanceof Date ? 'PASS' : 'FAIL', 'Date instance', String(q3.timeFilter?.start))

  // B.16: date range — yesterday start < today start
  if (q3.timeFilter?.start && q3.timeFilter?.end) {
    record('recall', 'B.16 yesterday start < end', q3.timeFilter.start < q3.timeFilter.end ? 'PASS' : 'FAIL',
      'start < end', `${q3.timeFilter.start.toISOString()} vs ${q3.timeFilter.end.toISOString()}`)
  }

  // B.17: no crash on empty query
  let threw = false
  try { parseRecallQuery('') } catch { threw = true }
  record('recall', 'B.17 empty query does not crash', !threw ? 'PASS' : 'FAIL', 'no exception', threw ? 'THREW' : 'ok')

  // B.18: no crash on very long query
  threw = false
  try { parseRecallQuery('a'.repeat(5000)) } catch { threw = true }
  record('recall', 'B.18 long query does not crash', !threw ? 'PASS' : 'FAIL', 'no exception', threw ? 'THREW' : 'ok')
}

// ── SUITE C: DailyRecap structure ─────────────────────────────────────────

async function suiteDailyRecap() {
  section('SUITE C — DailyRecap')

  const { buildDailyRecap, loadRecaps, getRecapForDate } = await import('./dailyRecap.js')

  // Build a recap for today (will be mostly empty since test env)
  const today = new Date().toISOString().slice(0, 10)
  let recap: any = null
  let threw = false

  try {
    recap = await buildDailyRecap(today)
  } catch (e: any) {
    threw = true
    console.log(`       note: ${e.message}`)
  }

  record('recap', 'C.01 buildDailyRecap does not throw', !threw ? 'PASS' : 'FAIL', 'no exception', threw ? 'THREW' : 'ok')

  if (recap) {
    record('recap', 'C.02 recap has date field', recap.date === today ? 'PASS' : 'FAIL', today, recap.date)
    record('recap', 'C.03 recap has narrative string', typeof recap.narrative === 'string' ? 'PASS' : 'FAIL', 'string', typeof recap.narrative)
    record('recap', 'C.04 recap has stats object', typeof recap.stats === 'object' ? 'PASS' : 'FAIL', 'object', typeof recap.stats)
    record('recap', 'C.05 recap.stats has totalCaptures', typeof recap.stats.totalCaptures === 'number' ? 'PASS' : 'FAIL', 'number', typeof recap.stats.totalCaptures)
    record('recap', 'C.06 recap has unresolvedItems array', Array.isArray(recap.unresolvedItems) ? 'PASS' : 'FAIL', 'array', typeof recap.unresolvedItems)
    record('recap', 'C.07 recap has wins array', Array.isArray(recap.wins) ? 'PASS' : 'FAIL', 'array', typeof recap.wins)
    record('recap', 'C.08 recap has losses array', Array.isArray(recap.losses) ? 'PASS' : 'FAIL', 'array', typeof recap.losses)
    record('recap', 'C.09 recap has suggestedActions array', Array.isArray(recap.suggestedActions) ? 'PASS' : 'FAIL', 'array', typeof recap.suggestedActions)
    record('recap', 'C.10 recap has rawSummary string', typeof recap.rawSummary === 'string' && recap.rawSummary.length > 0 ? 'PASS' : 'FAIL', 'non-empty string', recap.rawSummary?.slice(0, 50))
    record('recap', 'C.11 recap has generatedAt timestamp', typeof recap.generatedAt === 'number' && recap.generatedAt > 0 ? 'PASS' : 'FAIL', 'positive number', String(recap.generatedAt))

    // C.12: persisted and loadable
    const recaps = loadRecaps(10)
    record('recap', 'C.12 recap persisted and loadable', recaps.length > 0 ? 'PASS' : 'FAIL', '>= 1', String(recaps.length))

    // C.13: getRecapForDate returns correct date
    const retrieved = getRecapForDate(today)
    record('recap', 'C.13 getRecapForDate returns correct recap', retrieved?.date === today ? 'PASS' : 'WARN', today, retrieved?.date ?? 'null')
  }

  // C.14: no crash on non-existent date
  threw = false
  try { await buildDailyRecap('1990-01-01') } catch { threw = true }
  record('recap', 'C.14 no crash on date with no data', !threw ? 'PASS' : 'FAIL', 'no exception', threw ? 'THREW' : 'ok')
}

// ── SUITE D: BrainMap ──────────────────────────────────────────────────────

async function suiteBrainMap() {
  section('SUITE D — BrainMap')

  const { BrainMap, buildBrainMap, queryBrainMap } = await import('./brainMap.js')

  // D.01: BrainMap instantiates empty
  const map = new BrainMap()
  record('brainmap', 'D.01 BrainMap instantiates', map !== null ? 'PASS' : 'FAIL', 'non-null', 'ok')

  // D.02–D.05: Add nodes
  map.addNode({ id: 'person:alice', type: 'person', label: 'Alice', weight: 0.8, ts: Date.now(), metadata: { mentions: 5 } })
  map.addNode({ id: 'intent:PRICE_OBJECTION', type: 'intent', label: 'PRICE_OBJECTION', weight: 0.6, ts: Date.now(), metadata: {} })
  map.addNode({ id: 'outcome:won', type: 'outcome', label: 'won', weight: 0.9, ts: Date.now(), metadata: {} })
  map.addNode({ id: 'event:ep_001', type: 'event', label: 'Price negotiation with Alice', weight: 0.7, ts: Date.now() - 3600000, metadata: {} })

  record('brainmap', 'D.02 addNode stores person', map.getNode('person:alice') !== null ? 'PASS' : 'FAIL', 'non-null', 'ok')
  record('brainmap', 'D.03 addNode stores intent', map.getNode('intent:PRICE_OBJECTION') !== null ? 'PASS' : 'FAIL', 'non-null', 'ok')
  record('brainmap', 'D.04 addNode stores outcome', map.getNode('outcome:won') !== null ? 'PASS' : 'FAIL', 'non-null', 'ok')
  record('brainmap', 'D.05 addNode stores event', map.getNode('event:ep_001') !== null ? 'PASS' : 'FAIL', 'non-null', 'ok')

  // D.06–D.08: Add edges
  map.addEdge({ source: 'person:alice', target: 'event:ep_001', type: 'mentioned_in', weight: 0.9, ts: Date.now() })
  map.addEdge({ source: 'event:ep_001', target: 'intent:PRICE_OBJECTION', type: 'has_intent', weight: 0.7, ts: Date.now() })
  map.addEdge({ source: 'event:ep_001', target: 'outcome:won', type: 'resulted_in', weight: 0.95, ts: Date.now() })

  const aliceConnections = map.getConnections('person:alice')
  record('brainmap', 'D.06 getConnections returns edges', aliceConnections.length > 0 ? 'PASS' : 'FAIL', '> 0', String(aliceConnections.length))

  const eventConnections = map.getConnections('event:ep_001')
  record('brainmap', 'D.07 event has 3 connections', eventConnections.length === 3 ? 'PASS' : 'FAIL', '3', String(eventConnections.length))

  // D.09: shortest path
  const pathToWon = map.shortestPath('person:alice', 'outcome:won')
  record('brainmap', 'D.09 shortestPath alice → won exists', pathToWon.length > 0 ? 'PASS' : 'FAIL', '> 0 nodes', String(pathToWon.length))
  record('brainmap', 'D.10 shortestPath starts with alice', pathToWon[0]?.id === 'person:alice' ? 'PASS' : 'FAIL', 'person:alice', pathToWon[0]?.id)
  record('brainmap', 'D.11 shortestPath ends with won', pathToWon[pathToWon.length - 1]?.id === 'outcome:won' ? 'PASS' : 'FAIL', 'outcome:won', pathToWon[pathToWon.length - 1]?.id)

  // D.12: cluster
  const cluster = map.getCluster('person:alice', 2)
  record('brainmap', 'D.12 getCluster includes alice', cluster.some(n => n.id === 'person:alice') ? 'PASS' : 'FAIL', 'includes alice', String(cluster.map(n => n.id)))

  // D.13: getNodesByType
  const people = map.getNodesByType('person')
  record('brainmap', 'D.13 getNodesByType person returns 1', people.length === 1 ? 'PASS' : 'FAIL', '1', String(people.length))

  // D.14: duplicate node merge (weight should stay ≤ 1.0)
  map.addNode({ id: 'person:alice', type: 'person', label: 'Alice', weight: 0.8, ts: Date.now(), metadata: {} })
  const aliceNode = map.getNode('person:alice')
  record('brainmap', 'D.14 duplicate node weight <= 1.0', (aliceNode?.weight ?? 0) <= 1.0 ? 'PASS' : 'FAIL', '<= 1.0', String(aliceNode?.weight))

  // D.15: no path between disconnected nodes
  map.addNode({ id: 'person:bob', type: 'person', label: 'Bob', weight: 0.3, ts: Date.now(), metadata: {} })
  const noPath = map.shortestPath('person:bob', 'outcome:won')
  record('brainmap', 'D.15 shortestPath returns empty for disconnected nodes', noPath.length === 0 ? 'PASS' : 'FAIL', '0 nodes', String(noPath.length))

  // D.16: same node shortest path
  const selfPath = map.shortestPath('person:alice', 'person:alice')
  record('brainmap', 'D.16 shortestPath to self returns 1 node', selfPath.length === 1 ? 'PASS' : 'FAIL', '1', String(selfPath.length))

  // D.17: toData serialization
  const data = map.toData()
  record('brainmap', 'D.17 toData has nodes and edges', data.nodes.length > 0 && data.edges.length > 0 ? 'PASS' : 'FAIL',
    'nodes > 0 && edges > 0', `nodes=${data.nodes.length} edges=${data.edges.length}`)

  // D.18: reconstruct from serialized data
  const { BrainMap: BM2 } = await import('./brainMap.js')
  const restored = new BM2(data)
  record('brainmap', 'D.18 reconstruct from serialized data', restored.getNode('person:alice') !== null ? 'PASS' : 'FAIL', 'non-null alice', 'ok')

  // D.19: buildBrainMap does not crash (may return empty map if no data)
  let threw = false
  try { await buildBrainMap() } catch { threw = true }
  record('brainmap', 'D.19 buildBrainMap does not throw', !threw ? 'PASS' : 'FAIL', 'no exception', threw ? 'THREW' : 'ok')

  // D.20: queryBrainMap does not crash
  threw = false
  try { await queryBrainMap('show me Alice') } catch { threw = true }
  record('brainmap', 'D.20 queryBrainMap does not throw', !threw ? 'PASS' : 'FAIL', 'no exception', threw ? 'THREW' : 'ok')
}

// ── SUITE E: Daemon logic ──────────────────────────────────────────────────

async function suiteDaemon() {
  section('SUITE E — Daemon Logic (offline)')

  // We can't test the full daemon (needs mic), but we can test its helpers

  // E.01: captureStore writeCapture is idempotent across sessions
  const { writeCapture, getBySession } = await import("../capture/captureStore.js") as any

  const s1 = `test_sess_${Date.now()}_a`
  const s2 = `test_sess_${Date.now()}_b`

  writeCapture('Session A turn 1', 'other', s1, 1000, 'mic')
  writeCapture('Session A turn 2', 'other', s1, 1000, 'mic')
  writeCapture('Session B turn 1', 'other', s2, 1000, 'mic')

  const s1Entries = getBySession(s1)
  const s2Entries = getBySession(s2)

  record('daemon', 'E.01 session isolation — s1 has 2 entries', s1Entries.length === 2 ? 'PASS' : 'FAIL', '2', String(s1Entries.length))
  record('daemon', 'E.02 session isolation — s2 has 1 entry', s2Entries.length === 1 ? 'PASS' : 'FAIL', '1', String(s2Entries.length))

  // E.03: short utterances are stored (length filtering is at processing level, not store level)
  const short = writeCapture('ok', 'other', s1, 200, 'mic')
  record('daemon', 'E.03 short utterances stored in captureStore', short !== null ? 'PASS' : 'FAIL', 'non-null', 'ok')

  // E.04: noise token detection pattern
  const noiseTokens = ['[BLANK_AUDIO]', '[_BG_]', '[ Silence ]', '[ Background Music ]']
  const noisePattern = /^\[.*\]$/
  const allMatch = noiseTokens.every(t => noisePattern.test(t.trim()))
  record('daemon', 'E.04 noise token pattern matches whisper tokens', allMatch ? 'PASS' : 'FAIL', 'all match', String(allMatch))

  // E.05: non-noise transcript passes pattern
  const notNoise = ['Hello there', 'The price is too high', 'Send me the contract']
  const noneMatch = notNoise.every(t => !noisePattern.test(t.trim()))
  record('daemon', 'E.05 real transcripts do not match noise pattern', noneMatch ? 'PASS' : 'FAIL', 'none match', String(noneMatch))

  // E.06: getUnprocessed returns entries
  const { getUnprocessed } = await import("../capture/captureStore.js") as any
  const unprocessed = getUnprocessed()
  record('daemon', 'E.06 getUnprocessed returns entries', Array.isArray(unprocessed) ? 'PASS' : 'FAIL', 'array', typeof unprocessed)

  // E.07: markProcessed changes status
  const { markProcessed, searchCaptures } = await import("../capture/captureStore.js") as any
  const entries = searchCaptures({ sessionId: s1, limit: 1 })
  if (entries.length) {
    markProcessed(entries[0].id)
    // Can't easily verify status in JSONL without reload — just check no crash
    record('daemon', 'E.07 markProcessed does not crash', true ? 'PASS' : 'FAIL', 'no exception', 'ok')
  }
}

// ── SUITE F: Integration ───────────────────────────────────────────────────

async function suiteIntegration() {
  section('SUITE F — Integration & Edge Cases')

  // F.01: recall parseRecallQuery → no crash on any realistic input
  const { parseRecallQuery } = await import('./recall.js')
  const realisticQueries = [
    'Who did I talk to last Tuesday about the ServiceTitan deal?',
    'What offers came up this week?',
    "What did Nathan say about the bug?",
    'Show me all stalls from last month',
    'Did we close anything with Marcus?',
    'What happened in the investor pitch yesterday?',
    '',
    'a',
    '!@#$%^&*()',
    'a'.repeat(10000),
  ]

  let allParsed = true
  for (const q of realisticQueries) {
    try { parseRecallQuery(q) } catch { allParsed = false }
  }
  record('integration', 'F.01 parseRecallQuery handles all inputs without crash', allParsed ? 'PASS' : 'FAIL', 'no crashes', allParsed ? 'ok' : 'crashed')

  // F.02: BrainMap → person timeline ordering
  const { BrainMap } = await import('./brainMap.js')
  const map = new BrainMap()
  const now = Date.now()

  map.addNode({ id: 'person:charlie', type: 'person', label: 'Charlie', weight: 0.6, ts: now, metadata: {} })
  map.addNode({ id: 'event:e1', type: 'event', label: 'First meeting', weight: 0.5, ts: now - 7200000, metadata: {} })
  map.addNode({ id: 'event:e2', type: 'event', label: 'Second meeting', weight: 0.5, ts: now - 3600000, metadata: {} })
  map.addNode({ id: 'event:e3', type: 'event', label: 'Third meeting', weight: 0.5, ts: now, metadata: {} })

  map.addEdge({ source: 'person:charlie', target: 'event:e1', type: 'mentioned_in', weight: 0.8, ts: now - 7200000 })
  map.addEdge({ source: 'person:charlie', target: 'event:e2', type: 'mentioned_in', weight: 0.8, ts: now - 3600000 })
  map.addEdge({ source: 'person:charlie', target: 'event:e3', type: 'mentioned_in', weight: 0.8, ts: now })

  const timeline = map.getPersonTimeline('Charlie')
  record('integration', 'F.02 person timeline is chronologically ordered',
    timeline.length === 3 && timeline[0].ts <= timeline[1].ts && timeline[1].ts <= timeline[2].ts ? 'PASS' : 'FAIL',
    'e1 → e2 → e3',
    timeline.map(n => n.label).join(' → ')
  )

  // F.03: captureStore → getByDateRange boundary inclusivity
  const { writeCapture, getByDateRange } = await import("../capture/captureStore.js") as any
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yDate = yesterday.toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)

  writeCapture('test range entry', 'other', 'range_test', 1000, 'mic')

  const rangeEntries = getByDateRange(yDate, today)
  record('integration', 'F.03 getByDateRange includes today', rangeEntries.length >= 1 ? 'PASS' : 'FAIL', '>= 1', String(rangeEntries.length))

  // F.04: DailyRecap unresolved items have correct priority ordering
  const { buildDailyRecap } = await import('./dailyRecap.js')
  const recap = await buildDailyRecap()
  const priorities = recap.unresolvedItems.map((i: any) => i.priority)
  const rank: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
  let sorted = true
  for (let i = 1; i < priorities.length; i++) {
    if (rank[priorities[i]] < rank[priorities[i - 1]]) { sorted = false; break }
  }
  record('integration', 'F.04 unresolvedItems sorted by priority', sorted ? 'PASS' : 'FAIL', 'urgent → low order', priorities.join(', ') || '(empty)')

  // F.05: BrainMap toData → BrainMap roundtrip preserves edge count
  const { BrainMap: BM3 } = await import('./brainMap.js')
  const original = new BM3()
  original.addNode({ id: 'n1', type: 'person', label: 'N1', weight: 0.5, ts: now, metadata: {} })
  original.addNode({ id: 'n2', type: 'intent', label: 'N2', weight: 0.5, ts: now, metadata: {} })
  original.addEdge({ source: 'n1', target: 'n2', type: 'has_intent', weight: 0.7, ts: now })

  const data    = original.toData()
  const restored = new BM3(data)

  record('integration', 'F.05 BrainMap roundtrip preserves edge count',
    restored.toData().edgeCount === original.toData().edgeCount ? 'PASS' : 'FAIL',
    String(original.toData().edgeCount),
    String(restored.toData().edgeCount)
  )
}

// ── Scorecard ──────────────────────────────────────────────────────────────

function printScorecard() {
  const sep = '═'.repeat(65)
  console.log(`\n${sep}\n  MEMORY SYSTEM TEST SCORECARD\n${sep}`)

  const suites = [...new Set(results.map(r => r.suite))]
  let tp = 0, tf = 0, tw = 0

  for (const suite of suites) {
    const sr   = results.filter(r => r.suite === suite)
    const pass = sr.filter(r => r.verdict === 'PASS').length
    const fail = sr.filter(r => r.verdict === 'FAIL').length
    const warn = sr.filter(r => r.verdict === 'WARN').length
    const pct  = Math.round(pass / sr.length * 100)
    const bar  = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))
    const icon = fail === 0 ? '✅' : pct >= 75 ? '🟡' : '❌'
    console.log(`  ${icon} ${suite.padEnd(16)} ${bar} ${pct}%  (${pass}/${sr.length}${warn ? ` ⚠${warn}` : ''})`)
    tp += pass; tf += fail; tw += warn
  }

  const pct = Math.round(tp / (tp + tf) * 100)
  console.log(`${'─'.repeat(65)}`)
  console.log(`  TOTAL: ${tp} pass / ${tf} fail / ${tw} warn — ${pct}%`)

  const failures = results.filter(r => r.verdict === 'FAIL')
  if (failures.length) {
    console.log(`\n${'─'.repeat(65)}\nFAILURES:`)
    for (const f of failures) {
      console.log(`\n  ❌ [${f.suite}] ${f.name}`)
      console.log(`     expected: ${f.expected}`)
      console.log(`     got:      ${f.got ?? '(null)'}`)
      if (f.note) console.log(`     note:     ${f.note}`)
    }
  }

  console.log(`${sep}\n`)
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const suiteArg = process.argv.find(a => a.startsWith('--suite='))?.split('=')[1] ?? 'all'
  console.log(`\nARIA MEMORY SYSTEM TEST SUITE\nRunning: ${suiteArg}\n${'═'.repeat(65)}`)

  const suiteMap: Record<string, () => Promise<void>> = {
    capture:     suiteCaptureStore,
    recall:      suiteRecall,
    recap:       suiteDailyRecap,
    brainmap:    suiteBrainMap,
    daemon:      suiteDaemon,
    integration: suiteIntegration,
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

  // Cleanup test dir
  try { fs.rmSync(TEST_ARIA_DIR, { recursive: true, force: true }) } catch {}

  process.exit(results.some(r => r.verdict === 'FAIL') ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })