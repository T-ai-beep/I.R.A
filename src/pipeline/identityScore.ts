/**
 * identityScore.ts
 * Ranks known people by importance.
 * Drives ARIA urgency: investor → respond now vs random → low priority.
 */

import { PersonRecord, getAllPeople, lookupPerson } from './people.js'

export type ImportanceLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface IdentityScore {
  name: string
  displayName: string
  score: number             // 0–1
  level: ImportanceLevel
  reason: string            // e.g. "investor, 3 mentions, last offer $5000"
  urgencyLabel: string      // spoken by ARIA: "Investor — respond now"
}

// ── Tag weights ────────────────────────────────────────────────────────────

const TAG_WEIGHTS: Record<string, number> = {
  investor:   1.00,
  client:     0.90,
  lead:       0.80,
  partner:    0.70,
  internal:   0.60,
  competitor: 0.40,
}

const DEFAULT_WEIGHT = 0.20

// ── Score a single person ──────────────────────────────────────────────────

export function scoreIdentity(record: PersonRecord): IdentityScore {
  let score = DEFAULT_WEIGHT

  // tag-based base score (highest tag wins)
  const tagScores = record.tags
    .map(t => TAG_WEIGHTS[t] ?? DEFAULT_WEIGHT)
  if (tagScores.length) {
    score = Math.max(...tagScores)
  }

  // mention multiplier — more interaction = more important (capped)
  const mentionBonus = Math.min(0.15, record.mentions * 0.01)
  score += mentionBonus

  // offer presence — dealing with money signals real deal
  if (record.lastOffer !== null) score += 0.10

  // recency bonus — seen in last 24h
  const hoursSince = (Date.now() - record.lastSeen) / 3_600_000
  if (hoursSince < 1)  score += 0.10
  if (hoursSince < 24) score += 0.05

  // intent boost
  if (record.lastIntent === 'AGREEMENT')      score += 0.15
  if (record.lastIntent === 'PRICE_OBJECTION') score += 0.05

  score = Math.min(1.0, parseFloat(score.toFixed(3)))

  const level = scoreToLevel(score)
  const reason = buildReason(record, score)
  const urgencyLabel = buildUrgencyLabel(record, level)

  return {
    name: record.name,
    displayName: record.displayName,
    score,
    level,
    reason,
    urgencyLabel,
  }
}

function scoreToLevel(score: number): ImportanceLevel {
  if (score >= 0.85) return 'CRITICAL'
  if (score >= 0.65) return 'HIGH'
  if (score >= 0.40) return 'MEDIUM'
  return 'LOW'
}

function buildReason(record: PersonRecord, score: number): string {
  const parts: string[] = []
  if (record.tags.length) parts.push(record.tags.join(', '))
  if (record.mentions > 1) parts.push(`${record.mentions} mentions`)
  if (record.lastOffer)    parts.push(`last offer $${record.lastOffer}`)
  if (record.lastIntent)   parts.push(`intent: ${record.lastIntent}`)
  return parts.join(' | ') || `score ${score}`
}

function buildUrgencyLabel(record: PersonRecord, level: ImportanceLevel): string {
  const topTag = record.tags[0] ?? 'contact'
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

  switch (level) {
    case 'CRITICAL': return `${capitalize(topTag)} — respond now`
    case 'HIGH':     return `${capitalize(topTag)} — prioritize`
    case 'MEDIUM':   return `${capitalize(topTag)} — when ready`
    case 'LOW':      return `Low priority — ${record.displayName}`
  }
}

// ── Lookup score for a person by name ─────────────────────────────────────

export function getIdentityScore(name: string): IdentityScore | null {
  const record = lookupPerson(name)
  if (!record) return null
  return scoreIdentity(record)
}

// ── Get all scored people, ranked ─────────────────────────────────────────

export function getRankedIdentities(): IdentityScore[] {
  return getAllPeople()
    .map(scoreIdentity)
    .sort((a, b) => b.score - a.score)
}

// ── Check if a transcript mentions high-importance people ─────────────────

export function getHighImportancePeople(transcript: string): IdentityScore[] {
  const all = getAllPeople()
  const mentioned = all.filter(p =>
    transcript.toLowerCase().includes(p.name) ||
    transcript.toLowerCase().includes(p.displayName.toLowerCase())
  )
  return mentioned
    .map(scoreIdentity)
    .filter(s => s.level === 'CRITICAL' || s.level === 'HIGH')
    .sort((a, b) => b.score - a.score)
}

// ── Context string for ARIA ────────────────────────────────────────────────

export function getIdentityContext(transcript: string): string {
  const high = getHighImportancePeople(transcript)
  if (!high.length) return ''
  return `High-importance contacts:\n${high.map(s => `- ${s.urgencyLabel} (${s.reason})`).join('\n')}`
}