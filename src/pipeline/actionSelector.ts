/**
 * actionSelector.ts
 * Takes candidate actions from rules / embeddings / LLM.
 * Scores them. Returns exactly ONE best_action — always.
 */

import { EventType } from './decision.js'
import { loadWeights } from "../pipeline/adaptiveWeights.js"

export type Urgency = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
export type CommandType =
  | 'WAIT' | 'PUSH' | 'REJECT' | 'ACCEPT'
  | 'ASK' | 'ANCHOR' | 'CHALLENGE' | 'CLARIFY'
  | 'DELAY' | 'EXIT' | 'FOLLOW_UP' | 'ARIA_QUERY'

export interface ActionCandidate {
  command: CommandType
  message: string        // e.g. "Anchor — ROI"
  source: 'rule' | 'embedding' | 'llm'
  score: number          // raw confidence 0–1
}

export interface BestAction {
  command: CommandType
  message: string
  urgency: Urgency
  source: 'rule' | 'embedding' | 'llm'
  confidence: number     // final weighted score
}

// ── Source base trust (before adaptive weights) ────────────────────────────

const SOURCE_BASE: Record<ActionCandidate['source'], number> = {
  rule:      0.90,
  embedding: 0.75,
  llm:       0.60,
}

// ── Event → urgency mapping ────────────────────────────────────────────────

const EVENT_URGENCY: Partial<Record<EventType, Urgency>> = {
  PRICE_OBJECTION: 'HIGH',
  AGREEMENT:       'CRITICAL',
  COMPETITOR:      'HIGH',
  AUTHORITY:       'HIGH',
  STALLING:        'MEDIUM',
  QUESTION:        'MEDIUM',
  OFFER_DISCUSS:   'HIGH',
  DEADLINE:        'CRITICAL',
  UNKNOWN:         'LOW',
}

// ── Command → urgency floor (command always at least this urgent) ──────────

const COMMAND_URGENCY_FLOOR: Partial<Record<CommandType, Urgency>> = {
  ACCEPT:    'CRITICAL',
  REJECT:    'HIGH',
  PUSH:      'HIGH',
  ANCHOR:    'HIGH',
  CHALLENGE: 'HIGH',
  FOLLOW_UP: 'HIGH',
  WAIT:      'LOW',
  DELAY:     'LOW',
}

function resolveUrgency(command: CommandType, event: EventType): Urgency {
  const fromEvent   = EVENT_URGENCY[event]   ?? 'LOW'
  const fromCommand = COMMAND_URGENCY_FLOOR[command] ?? 'LOW'

  const rank = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 }
  const max = rank[fromEvent] >= rank[fromCommand] ? fromEvent : fromCommand
  return max
}

function parseCommand(message: string): CommandType {
  const first = message.split(/[\s—\-]/)[0].toUpperCase()
  const valid: CommandType[] = [
    'WAIT','PUSH','REJECT','ACCEPT','ASK','ANCHOR',
    'CHALLENGE','CLARIFY','DELAY','EXIT','FOLLOW_UP','ARIA_QUERY'
  ]
  return valid.includes(first as CommandType) ? first as CommandType : 'WAIT'
}

// ── Main selector ──────────────────────────────────────────────────────────

export function selectBestAction(
  candidates: ActionCandidate[],
  event: EventType
): BestAction | null {
  if (!candidates.length) return null

  const weights = loadWeights()

  const scored = candidates.map(c => {
    const sourceTrust = SOURCE_BASE[c.source]

    // adaptive weight for this specific message
    const adaptiveKey = c.message.toLowerCase().replace(/\s+/g, '_')
    const adaptive = weights[adaptiveKey] ?? 1.0

    const final = c.score * sourceTrust * adaptive
    return { ...c, finalScore: final }
  })

  // sort descending
  scored.sort((a, b) => b.finalScore - a.finalScore)
  const best = scored[0]

  const command = parseCommand(best.message)
  const urgency = resolveUrgency(command, event)

  return {
    command,
    message: best.message,
    urgency,
    source: best.source,
    confidence: parseFloat(best.finalScore.toFixed(3)),
  }
}

// ── Format for speak / log ─────────────────────────────────────────────────

export function formatAction(action: BestAction): string {
  return action.message
}