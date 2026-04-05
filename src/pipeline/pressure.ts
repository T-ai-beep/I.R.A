/**
 * pressure.ts
 * State machine for resurface items.
 * PENDING → SUGGESTED → REMINDED → ESCALATED → FORCED
 *
 * Each stage has escalating language + shorter intervals.
 * FORCED = interrupts active conversation.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const ARIA_DIR       = path.join(os.homedir(), '.aria')
const PRESSURE_FILE  = path.join(ARIA_DIR, 'pressure.jsonl')

export type PressureState = 'PENDING' | 'SUGGESTED' | 'REMINDED' | 'ESCALATED' | 'FORCED'
export type PressureType  = 'task' | 'followup'

export interface PressureItem {
  id: string
  sourceId: string           // task.id or followup.id
  type: PressureType
  description: string
  person: string | null
  state: PressureState
  createdAt: number
  nextFireAt: number
  fireCount: number
  dismissed: boolean
  priority: 'hot' | 'warm' | 'cold' | 'high' | 'medium' | 'low'
}

// ── Interval schedule per state (ms) ──────────────────────────────────────

const INTERVALS: Record<PressureState, number> = {
  PENDING:   0,
  SUGGESTED: 30 * 60 * 1000,   // 30 min
  REMINDED:  15 * 60 * 1000,   // 15 min
  ESCALATED:  5 * 60 * 1000,   //  5 min
  FORCED:     2 * 60 * 1000,   //  2 min (interrupts)
}

// ── Message templates per state ────────────────────────────────────────────

const STATE_MESSAGES: Record<PressureState, (desc: string, person: string | null) => string> = {
  PENDING:   (d, p) => `${d}${p ? ` — ${p}` : ''}`,
  SUGGESTED: (d, p) => `${d}${p ? ` — ${p}` : ''}`,
  REMINDED:  (d, p) => `${d}${p ? ` — ${p}` : ''} — you're delaying`,
  ESCALATED: (d, p) => `${d}${p ? ` — ${p}` : ''} — risk of loss`,
  FORCED:    (d, p) => `URGENT — ${d}${p ? ` — ${p}` : ''} — act now`,
}

// ── State transitions ──────────────────────────────────────────────────────

const NEXT_STATE: Record<PressureState, PressureState | null> = {
  PENDING:   'SUGGESTED',
  SUGGESTED: 'REMINDED',
  REMINDED:  'ESCALATED',
  ESCALATED: 'FORCED',
  FORCED:    null,  // terminal — stays FORCED until dismissed
}

// ── Storage ────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
}

function loadAll(): PressureItem[] {
  ensureDir()
  if (!fs.existsSync(PRESSURE_FILE)) return []
  try {
    return fs.readFileSync(PRESSURE_FILE, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as PressureItem)
  } catch { return [] }
}

function saveAll(items: PressureItem[]) {
  ensureDir()
  fs.writeFileSync(PRESSURE_FILE, items.map(i => JSON.stringify(i)).join('\n') + '\n')
}

function genId(): string {
  return `pr_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
}

// ── Create ─────────────────────────────────────────────────────────────────

export function createPressureItem(
  sourceId: string,
  type: PressureType,
  description: string,
  person: string | null,
  priority: PressureItem['priority'],
  initialDelayMs = 60_000
): PressureItem {
  // dedupe — don't create if sourceId already tracked
  const existing = loadAll().find(p => p.sourceId === sourceId && !p.dismissed)
  if (existing) return existing

  const item: PressureItem = {
    id: genId(),
    sourceId,
    type,
    description,
    person,
    state: 'PENDING',
    createdAt: Date.now(),
    nextFireAt: Date.now() + initialDelayMs,
    fireCount: 0,
    dismissed: false,
    priority,
  }

  const all = loadAll()
  all.push(item)
  saveAll(all)
  console.log(`[PRESSURE] created ${type} — "${description}" state=PENDING`)
  return item
}

// ── Get due items (ready to fire) ─────────────────────────────────────────

export function getDueItems(allowForced = false): PressureItem[] {
  const now = Date.now()
  return loadAll()
    .filter(p =>
      !p.dismissed &&
      p.nextFireAt <= now &&
      (allowForced || p.state !== 'FORCED')
    )
    .sort((a, b) => {
      // hot/high first, then by nextFireAt
      const prank = { hot: 0, high: 0, warm: 1, medium: 1, cold: 2, low: 2 }
      const pd = prank[a.priority] - prank[b.priority]
      return pd !== 0 ? pd : a.nextFireAt - b.nextFireAt
    })
}

export function getForcedItems(): PressureItem[] {
  const now = Date.now()
  return loadAll().filter(p =>
    !p.dismissed &&
    p.state === 'FORCED' &&
    p.nextFireAt <= now
  )
}

// ── Fire an item — advance state and schedule next ────────────────────────

export function fireItem(id: string): { message: string; state: PressureState; isForced: boolean } | null {
  const all = loadAll()
  const item = all.find(p => p.id === id)
  if (!item || item.dismissed) return null

  // advance state
  const nextState = NEXT_STATE[item.state]
  const newState: PressureState = nextState ?? 'FORCED'

  const message = STATE_MESSAGES[newState](item.description, item.person)

  item.state = newState
  item.fireCount += 1
  item.nextFireAt = Date.now() + (INTERVALS[newState] ?? INTERVALS.FORCED)

  saveAll(all)
  console.log(`[PRESSURE] fired "${item.description}" → state=${newState} (×${item.fireCount})`)

  return { message, state: newState, isForced: newState === 'FORCED' }
}

// ── Dismiss ────────────────────────────────────────────────────────────────

export function dismissPressure(id: string): void
export function dismissPressure(sourceId: string, bySourceId: true): void
export function dismissPressure(idOrSource: string, bySourceId?: boolean): void {
  const all = loadAll()
  const item = bySourceId
    ? all.find(p => p.sourceId === idOrSource)
    : all.find(p => p.id === idOrSource)
  if (item) {
    item.dismissed = true
    saveAll(all)
    console.log(`[PRESSURE] dismissed "${item.description}"`)
  }
}

// ── Get message for a state ────────────────────────────────────────────────

export function getPressureMessage(item: PressureItem): string {
  return STATE_MESSAGES[item.state](item.description, item.person)
}

// ── Summary ────────────────────────────────────────────────────────────────

export function getPressureSummary(): string {
  const all = loadAll().filter(p => !p.dismissed)
  if (!all.length) return ''
  const forced    = all.filter(p => p.state === 'FORCED').length
  const escalated = all.filter(p => p.state === 'ESCALATED').length
  const active    = all.length
  return `Pressure: ${active} active${forced ? ` — ${forced} FORCED` : ''}${escalated ? ` — ${escalated} escalated` : ''}`
}