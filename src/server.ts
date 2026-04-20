/**
 * server.ts — I.R.A Event Server
 *
 * Express + WebSocket server that bridges the pipeline to the HUD,
 * analytics dashboard, CRM integration, and mobile companion app.
 *
 * HTTP:      localhost:3000
 * WebSocket: ws://localhost:3000/ws
 *
 * REST endpoints:
 *   GET /               → HUD (live display)
 *   GET /analytics      → Coaching analytics dashboard
 *   GET /api/state      → Current live pipeline state (JSON)
 *   GET /api/analytics  → Decision patterns + stats
 *   GET /api/people     → People records
 *   GET /api/followups  → Due follow-ups
 *   GET /api/episodes   → Recent episodic memory
 *   GET /api/recap      → Today's daily recap
 *   GET /api/decisions  → Recent decision log
 *
 * WebSocket events (server → clients):
 *   ar_signal   { signal, reason }
 *   decision    { event, response, source, level, ms }
 *   session_start { sessionId, ts }
 *   session_end   { summary }
 *   followup    { action, person, priority }
 *   state       { mode, arSignal, event, level, lastOffer, sessionActive, turnCount }
 */

import express       from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import * as http     from 'http'
import * as fs       from 'fs'
import * as path     from 'path'
import * as os       from 'os'
import { CONFIG }    from './config.js'

const ARIA_DIR = path.join(os.homedir(), '.aria')

// ── Live state snapshot (updated by pipeline hooks) ────────────────────────

export interface LiveState {
  mode:          string
  arSignal:      'RED' | 'YELLOW' | 'GREEN' | null
  arReason:      string | null
  event:         string | null
  level:         number
  levelName:     string | null
  lastResponse:  string | null
  lastOffer:     number | null
  sessionActive: boolean
  sessionId:     string | null
  turnCount:     number
  sessionStartTs: number | null
}

const liveState: LiveState = {
  mode:           'negotiation',
  arSignal:       null,
  arReason:       null,
  event:          null,
  level:          0,
  levelName:      null,
  lastResponse:   null,
  lastOffer:      null,
  sessionActive:  false,
  sessionId:      null,
  turnCount:      0,
  sessionStartTs: null,
}

// ── WebSocket broadcast ────────────────────────────────────────────────────

let wss: WebSocketServer | null = null

export function broadcast(type: string, payload: object): void {
  if (!wss) return
  const msg = JSON.stringify({ type, ts: Date.now(), ...payload })
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg, err => { if (err) console.error('[SERVER] ws send error:', err.message) })
    }
  })
}

// ── State update helpers (called by pipeline) ──────────────────────────────

export function emitARSignal(signal: 'RED' | 'YELLOW' | 'GREEN', reason: string): void {
  liveState.arSignal = signal
  liveState.arReason = reason
  broadcast('ar_signal', { signal, reason })
  broadcast('state', liveState)
}

export function emitDecision(payload: {
  event: string
  response: string
  source: string
  level: number
  levelName: string
  ms: number
}): void {
  liveState.event       = payload.event
  liveState.level       = payload.level
  liveState.levelName   = payload.levelName
  liveState.lastResponse = payload.response
  broadcast('decision', payload)
  broadcast('state', liveState)
}

export function emitSessionStart(sessionId: string, ts: number): void {
  liveState.sessionActive  = true
  liveState.sessionId      = sessionId
  liveState.turnCount      = 0
  liveState.sessionStartTs = ts
  broadcast('session_start', { sessionId, ts })
  broadcast('state', liveState)
}

export function emitSessionEnd(summary: object): void {
  liveState.sessionActive  = false
  liveState.sessionId      = null
  liveState.sessionStartTs = null
  broadcast('session_end', { summary })
  broadcast('state', liveState)
}

export function emitFollowUp(action: string, person: string | null, priority: string): void {
  broadcast('followup', { action, person, priority })
}

export function updateLiveState(patch: Partial<LiveState>): void {
  Object.assign(liveState, patch)
  broadcast('state', liveState)
}

// ── JSONL helpers ──────────────────────────────────────────────────────────

function readJsonl<T>(file: string, limit = 100): T[] {
  const p = path.join(ARIA_DIR, file)
  if (!fs.existsSync(p)) return []
  try {
    return fs.readFileSync(p, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as T)
      .slice(-limit)
      .reverse()
  } catch { return [] }
}

// ── Express app ────────────────────────────────────────────────────────────

export function createServer(): http.Server {
  const app = express()
  app.use(express.json())

  const PUBLIC_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'public')
  app.use(express.static(PUBLIC_DIR))

  // ── Page routes ──────────────────────────────────────────────────────────

  app.get('/', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'hud.html'))
  })

  app.get('/analytics', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'analytics.html'))
  })

  // ── REST API ─────────────────────────────────────────────────────────────

  app.get('/api/state', (_req, res) => {
    res.json(liveState)
  })

  app.get('/api/decisions', (_req, res) => {
    const limit = Number(_req.query.limit) || 50
    res.json(readJsonl('decisions.jsonl', limit))
  })

  app.get('/api/analytics', async (_req, res) => {
    try {
      const { detectPatterns, getStats } = await import('./pipeline/decisionLog.js')
      res.json({
        patterns:  detectPatterns(),
        stats:     getStats(),
        decisions: readJsonl('decisions.jsonl', 200),
      })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.get('/api/people', (_req, res) => {
    res.json(readJsonl('people.jsonl', 100))
  })

  app.get('/api/followups', (_req, res) => {
    res.json(readJsonl('followups.jsonl', 50))
  })

  app.get('/api/episodes', (_req, res) => {
    const limit = Number(_req.query.limit) || 30
    res.json(readJsonl('episodic.jsonl', limit))
  })

  app.get('/api/recap', async (_req, res) => {
    try {
      const { buildDailyRecap } = await import('./memory/dailyRecap.js')
      const dateArg = typeof _req.query.date === 'string' ? _req.query.date : undefined
      const recap = await buildDailyRecap(dateArg)
      res.json(recap)
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.get('/api/plays', (_req, res) => {
    res.json(readJsonl('plays.jsonl', 100))
  })

  // ── HTTP server ───────────────────────────────────────────────────────────

  const server = http.createServer(app)

  // ── WebSocket server ──────────────────────────────────────────────────────

  wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws, req) => {
    console.log(`[SERVER] WS client connected from ${req.socket.remoteAddress}`)

    // Send current state immediately on connect
    ws.send(JSON.stringify({ type: 'state', ts: Date.now(), ...liveState }))

    ws.on('error', err => console.error('[SERVER] ws client error:', err.message))
    ws.on('close', () => console.log('[SERVER] WS client disconnected'))
  })

  return server
}

// ── Start ──────────────────────────────────────────────────────────────────

export function startServer(port = CONFIG.SERVER_PORT): void {
  const server = createServer()
  server.listen(port, () => {
    console.log(`[SERVER] listening on http://localhost:${port}`)
    console.log(`[SERVER] HUD      → http://localhost:${port}/`)
    console.log(`[SERVER] Analytics → http://localhost:${port}/analytics`)
    console.log(`[SERVER] API      → http://localhost:${port}/api/state`)
  })
}
