import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { CONFIG } from '../config.js'

const ARIA_DIR = path.join(os.homedir(), '.aria')
const DECISIONS_FILE = path.join(ARIA_DIR, 'decisions.jsonl')

export type DecisionOutcome = 'won' | 'lost' | 'ignored' | 'followed' | 'pending'
export type DecisionSource = 'rule' | 'embedding' | 'llm' | 'aria_active'

export interface DecisionLog {
  id: string
  ts: number
  transcript: string
  eventType: string
  suggestion: string
  source: DecisionSource
  outcome: DecisionOutcome
  mode: string
  person: string | null
  offer: number | null
  notes: string | null
}

export interface Pattern {
  type: string
  description: string
  severity: 'critical' | 'warning' | 'info'
  count: number
  rate: number
}

function ensureDir() {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
}

function loadAll(): DecisionLog[] {
  ensureDir()
  if (!fs.existsSync(DECISIONS_FILE)) return []
  try {
    return fs.readFileSync(DECISIONS_FILE, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as DecisionLog)
  } catch { return [] }
}

function saveAll(logs: DecisionLog[]) {
  ensureDir()
  fs.writeFileSync(DECISIONS_FILE, logs.map(l => JSON.stringify(l)).join('\n') + '\n')
}

function genId(): string {
  return `dec_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
}

// ── Log a decision ─────────────────────────────────────────────────────────

export function logDecision(
  transcript: string,
  eventType: string,
  suggestion: string,
  source: DecisionSource,
  mode: string,
  person: string | null = null,
  offer: number | null = null
): DecisionLog {
  const log: DecisionLog = {
    id: genId(),
    ts: Date.now(),
    transcript: transcript.slice(0, 200),
    eventType,
    suggestion,
    source,
    outcome: 'pending',
    mode,
    person,
    offer,
    notes: null,
  }

  const all = loadAll()
  all.push(log)
  saveAll(all)

  console.log(`[DLOG] ${source} — "${suggestion}" | event=${eventType}`)
  return log
}

// ── Update outcome ─────────────────────────────────────────────────────────

export function updateOutcome(id: string, outcome: DecisionOutcome, notes?: string): void {
  const all = loadAll()
  const log = all.find(l => l.id === id)
  if (log) {
    log.outcome = outcome
    if (notes) log.notes = notes
    saveAll(all)
    console.log(`[DLOG] outcome updated — ${id} → ${outcome}`)
  }
}

// ── Mark last pending decision with outcome ────────────────────────────────

export function markLastOutcome(outcome: DecisionOutcome, eventTypeFilter?: string): void {
  const all = loadAll()
  const pending = all.filter(l => l.outcome === 'pending')
  if (!pending.length) return

  const target = eventTypeFilter
    ? pending.reverse().find(l => l.eventType === eventTypeFilter)
    : pending[pending.length - 1]

  if (target) {
    target.outcome = outcome
    saveAll(all)
    console.log(`[DLOG] marked last "${target.eventType}" as ${outcome}`)
  }
}

// ── Pattern detection ──────────────────────────────────────────────────────

export function detectPatterns(): Pattern[] {
  const all = loadAll().filter(l => l.outcome !== 'pending')
  if (all.length < 5) return [] // need enough data

  const patterns: Pattern[] = []

  // Pattern 1: Caving on price
  const priceEvents = all.filter(l => l.eventType === 'PRICE_OBJECTION')
  if (priceEvents.length >= 3) {
    const caved = priceEvents.filter(l => l.outcome === 'lost' || l.outcome === 'ignored').length
    const rate = caved / priceEvents.length
    if (rate >= 0.5) {
      patterns.push({
        type: 'PRICE_CAVE',
        description: `You cave on price ${Math.round(rate * 100)}% of the time — hold the number`,
        severity: rate >= 0.7 ? 'critical' : 'warning',
        count: caved,
        rate,
      })
    }
  }

  // Pattern 2: Ignoring follow-ups
  const followUpEvents = all.filter(l => l.suggestion.includes('Follow up'))
  if (followUpEvents.length >= 3) {
    const ignored = followUpEvents.filter(l => l.outcome === 'ignored').length
    const rate = ignored / followUpEvents.length
    if (rate >= 0.4) {
      patterns.push({
        type: 'FOLLOWUP_IGNORE',
        description: `You ignore follow-ups ${Math.round(rate * 100)}% of the time — dropped deals`,
        severity: rate >= 0.6 ? 'critical' : 'warning',
        count: ignored,
        rate,
      })
    }
  }

  // Pattern 3: Stalling — not pushing through
  const stallingEvents = all.filter(l => l.eventType === 'STALLING')
  if (stallingEvents.length >= 3) {
    const lost = stallingEvents.filter(l => l.outcome === 'lost').length
    const rate = lost / stallingEvents.length
    if (rate >= 0.5) {
      patterns.push({
        type: 'STALL_LOSE',
        description: `You lose ${Math.round(rate * 100)}% of stalled deals — push harder earlier`,
        severity: 'warning',
        count: lost,
        rate,
      })
    }
  }

  // Pattern 4: Agreement signals not closed
  const agreementEvents = all.filter(l => l.eventType === 'AGREEMENT')
  if (agreementEvents.length >= 3) {
    const lost = agreementEvents.filter(l => l.outcome === 'lost').length
    const rate = lost / agreementEvents.length
    if (rate >= 0.3) {
      patterns.push({
        type: 'AGREEMENT_LOST',
        description: `You miss ${Math.round(rate * 100)}% of verbal agreements — close faster when they say yes`,
        severity: 'critical',
        count: lost,
        rate,
      })
    }
  }

  // Pattern 5: Win rate overall
  const won = all.filter(l => l.outcome === 'won').length
  const winRate = won / all.length
  if (all.length >= 10) {
    patterns.push({
      type: 'WIN_RATE',
      description: `Overall win rate: ${Math.round(winRate * 100)}% (${won}/${all.length} decisions)`,
      severity: winRate >= 0.6 ? 'info' : winRate >= 0.4 ? 'warning' : 'critical',
      count: won,
      rate: winRate,
    })
  }

  // Pattern 6: LLM suggestions ignored more than rules
  const llmLogs = all.filter(l => l.source === 'llm')
  const ruleLogs = all.filter(l => l.source === 'rule')
  if (llmLogs.length >= 5 && ruleLogs.length >= 5) {
    const llmFollowed = llmLogs.filter(l => l.outcome === 'followed' || l.outcome === 'won').length / llmLogs.length
    const ruleFollowed = ruleLogs.filter(l => l.outcome === 'followed' || l.outcome === 'won').length / ruleLogs.length
    if (ruleFollowed - llmFollowed > 0.2) {
      patterns.push({
        type: 'LLM_LOW_TRUST',
        description: `You follow rule suggestions ${Math.round(ruleFollowed * 100)}% vs LLM ${Math.round(llmFollowed * 100)}% — LLM needs tuning`,
        severity: 'info',
        count: llmLogs.length,
        rate: llmFollowed,
      })
    }
  }

  return patterns.sort((a, b) => {
    const s = { critical: 0, warning: 1, info: 2 }
    return s[a.severity] - s[b.severity]
  })
}

// ── Pattern summary for ARIA system prompt ────────────────────────────────

export function getPatternContext(): string {
  const patterns = detectPatterns()
  if (!patterns.length) return ''

  const critical = patterns.filter(p => p.severity === 'critical')
  const warnings = patterns.filter(p => p.severity === 'warning')

  const lines: string[] = []
  if (critical.length) {
    lines.push(`CRITICAL patterns:\n${critical.map(p => `- ${p.description}`).join('\n')}`)
  }
  if (warnings.length) {
    lines.push(`Warning patterns:\n${warnings.map(p => `- ${p.description}`).join('\n')}`)
  }

  return lines.length ? `Tanay's decision patterns:\n${lines.join('\n')}` : ''
}

// ── Stats summary ──────────────────────────────────────────────────────────

export function getStats(): string {
  const all = loadAll()
  if (!all.length) return 'No decisions logged yet.'

  const resolved = all.filter(l => l.outcome !== 'pending')
  const won = resolved.filter(l => l.outcome === 'won').length
  const lost = resolved.filter(l => l.outcome === 'lost').length
  const followed = resolved.filter(l => l.outcome === 'followed').length
  const ignored = resolved.filter(l => l.outcome === 'ignored').length

  return `Decision log: ${all.length} total (${resolved.length} resolved)
Won: ${won} | Lost: ${lost} | Followed: ${followed} | Ignored: ${ignored}
Win rate: ${resolved.length ? Math.round(won / resolved.length * 100) : 0}%`
}

// ── Recent decisions (last N) ──────────────────────────────────────────────

export function getRecentDecisions(n = 10): DecisionLog[] {
  return loadAll().slice(-n)
}