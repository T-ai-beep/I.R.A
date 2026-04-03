import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const ARIA_DIR = path.join(os.homedir(), '.aria')
const FOLLOWUPS_FILE = path.join(ARIA_DIR, 'followups.jsonl')

export type FollowUpStatus = 'pending' | 'sent' | 'dismissed'

export interface FollowUp {
  id: string
  created: number
  updated: number
  status: FollowUpStatus
  trigger: string              // raw transcript that created this
  person: string | null        // who to follow up with
  suggestedAction: string      // e.g. "Follow up — send details"
  resurfaceAt: number
  resurfaced: number
  context: string | null       // what was discussed
}

function ensureDir() {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
}

function loadAll(): FollowUp[] {
  ensureDir()
  if (!fs.existsSync(FOLLOWUPS_FILE)) return []
  try {
    return fs.readFileSync(FOLLOWUPS_FILE, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as FollowUp)
  } catch { return [] }
}

function saveAll(items: FollowUp[]) {
  ensureDir()
  fs.writeFileSync(FOLLOWUPS_FILE, items.map(i => JSON.stringify(i)).join('\n') + '\n')
}

function genId(): string {
  return `fu_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
}

// ── Detection patterns ─────────────────────────────────────────────────────

interface FollowUpSignal {
  pattern: RegExp
  action: string
  delayHours: number
}

const SIGNALS: FollowUpSignal[] = [
  // explicit send/info requests
  { pattern: /send (?:me|us|over|that|the)?\s*(?:more )?(?:info|details|pricing|proposal|contract|deck|link)/i,
    action: 'Follow up — send details',
    delayHours: 2 },

  // reconnect signals
  { pattern: /(?:let's|let us|we should|we'll|we will)\s+(?:reconnect|connect|talk|chat|catch up|sync)/i,
    action: 'Follow up — schedule call',
    delayHours: 24 },

  // get back to you
  { pattern: /(?:i'll|i will|we'll|we will)\s+get back (?:to you|with you)?/i,
    action: 'Follow up — check in',
    delayHours: 48 },

  { pattern: /(?:i'll|i will|we'll|we will)\s+(?:think about it|consider|review|look into|check)/i,
    action: 'Follow up — check in',
    delayHours: 48 },

  // after X timeframe
  { pattern: /(?:call|email|ping|reach out|talk)\s+(?:next week|tomorrow|friday|monday|in a few days)/i,
    action: 'Follow up — call scheduled',
    delayHours: 72 },

  // stall signals that need follow-up
  { pattern: /not (?:sure|ready) yet|need (?:more )?time|maybe later|check with my/i,
    action: 'Follow up — re-engage',
    delayHours: 72 },

  // agreement/verbal commit
  { pattern: /(?:sounds good|let's do it|we're in|i'll take it|we're interested|move forward)/i,
    action: 'Follow up — confirm terms',
    delayHours: 4 },

  // email me / calendar
  { pattern: /(?:email me|send me an? (?:invite|calendar|meeting))/i,
    action: 'Follow up — send invite',
    delayHours: 1 },
]

// ── Extract person from transcript ────────────────────────────────────────

function extractPersonFromContext(transcript: string): string | null {
  const m = transcript.match(
    /(?:with|to|for|from)\s+([A-Z][a-z]{1,14}(?:\s+[A-Z][a-z]{1,14})?)/
  )
  return m?.[1] ?? null
}

// ── Detect ─────────────────────────────────────────────────────────────────

export interface DetectedFollowUp {
  action: string
  delayHours: number
  person: string | null
}

export function detectFollowUp(transcript: string): DetectedFollowUp | null {
  for (const signal of SIGNALS) {
    if (signal.pattern.test(transcript)) {
      return {
        action: signal.action,
        delayHours: signal.delayHours,
        person: extractPersonFromContext(transcript),
      }
    }
  }
  return null
}

// ── Create ─────────────────────────────────────────────────────────────────

export function createFollowUp(transcript: string, detected: DetectedFollowUp, context?: string): FollowUp {
  const fu: FollowUp = {
    id: genId(),
    created: Date.now(),
    updated: Date.now(),
    status: 'pending',
    trigger: transcript,
    person: detected.person,
    suggestedAction: detected.action,
    resurfaceAt: Date.now() + detected.delayHours * 3600 * 1000,
    resurfaced: 0,
    context: context ?? null,
  }
  const all = loadAll()
  all.push(fu)
  saveAll(all)
  console.log(`[FOLLOWUP] created — "${fu.suggestedAction}"${fu.person ? ` re: ${fu.person}` : ''} resurface in ${detected.delayHours}h`)
  return fu
}

// ── Resurface ──────────────────────────────────────────────────────────────

const MAX_RESURFACES = 2

export function getDueFollowUps(): FollowUp[] {
  const now = Date.now()
  return loadAll().filter(f =>
    f.status === 'pending' &&
    f.resurfaceAt <= now &&
    f.resurfaced < MAX_RESURFACES
  )
}

export function markFollowUpResurfaced(id: string): void {
  const all = loadAll()
  const f = all.find(f => f.id === id)
  if (f) {
    f.resurfaced += 1
    f.resurfaceAt = Date.now() + 8 * 3600 * 1000
    f.updated = Date.now()
  }
  saveAll(all)
}

export function dismissFollowUp(id: string): void {
  const all = loadAll()
  const f = all.find(f => f.id === id)
  if (f) { f.status = 'dismissed'; f.updated = Date.now() }
  saveAll(all)
}

export function markFollowUpSent(id: string): void {
  const all = loadAll()
  const f = all.find(f => f.id === id)
  if (f) { f.status = 'sent'; f.updated = Date.now() }
  saveAll(all)
}

// ── Context for ARIA ──────────────────────────────────────────────────────

export function getFollowUpContext(): string {
  const pending = loadAll().filter(f => f.status === 'pending').slice(-3)
  if (!pending.length) return ''
  return `Pending follow-ups:\n${pending.map(f =>
    `- ${f.suggestedAction}${f.person ? ` (re: ${f.person})` : ''}`
  ).join('\n')}`
}