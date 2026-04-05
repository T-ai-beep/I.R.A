import { PersonRecord, getAllPeople, lookupPerson } from './people.js'

export type ImportanceLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface IdentityScore {
  name: string
  displayName: string
  score: number
  level: ImportanceLevel
  reason: string
  urgencyLabel: string
}

// Tag base scores — investor always starts higher than client so
// even at max mentions/offers they stay ordered
const TAG_BASE: Record<string, number> = {
  investor:   0.90,   // was 1.00 — leave headroom for bonuses
  client:     0.78,   // was 0.90
  lead:       0.68,
  partner:    0.58,
  internal:   0.48,
  competitor: 0.30,
}

const DEFAULT_BASE = 0.18

const MAX_SCORE = 0.99  // hard cap — never reaches 1.0, keeps ordering intact

export function scoreIdentity(record: PersonRecord): IdentityScore {
  let score = DEFAULT_BASE

  const tagScores = record.tags.map(t => TAG_BASE[t] ?? DEFAULT_BASE)
  if (tagScores.length) score = Math.max(...tagScores)

  // mention multiplier — capped tightly so it can't override tag ordering
  const mentionBonus = Math.min(0.06, record.mentions * 0.005)
  score += mentionBonus

  if (record.lastOffer !== null) score += 0.05  // was 0.10

  const hoursSince = (Date.now() - record.lastSeen) / 3_600_000
  if (hoursSince < 1)  score += 0.04
  if (hoursSince < 24) score += 0.02

  if (record.lastIntent === 'AGREEMENT')       score += 0.08
  if (record.lastIntent === 'PRICE_OBJECTION') score += 0.03

  score = Math.min(MAX_SCORE, parseFloat(score.toFixed(3)))

  const level = scoreToLevel(score)
  const reason = buildReason(record, score)
  const urgencyLabel = buildUrgencyLabel(record, level)

  return { name: record.name, displayName: record.displayName, score, level, reason, urgencyLabel }
}

function scoreToLevel(score: number): ImportanceLevel {
  if (score >= 0.82) return 'CRITICAL'
  if (score >= 0.62) return 'HIGH'
  if (score >= 0.38) return 'MEDIUM'
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

export function getIdentityScore(name: string): IdentityScore | null {
  const record = lookupPerson(name)
  if (!record) return null
  return scoreIdentity(record)
}

export function getRankedIdentities(): IdentityScore[] {
  return getAllPeople().map(scoreIdentity).sort((a, b) => b.score - a.score)
}

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

export function getIdentityContext(transcript: string): string {
  const high = getHighImportancePeople(transcript)
  if (!high.length) return ''
  return `High-importance contacts:\n${high.map(s => `- ${s.urgencyLabel} (${s.reason})`).join('\n')}`
}