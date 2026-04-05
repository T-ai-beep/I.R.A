/**
 * demo.ts
 * Scripted demo flows — clean input → guaranteed output.
 * Bypasses VAD/Whisper entirely. Feeds transcripts directly into the pipeline.
 */

export type DemoScenario = 'negotiation' | 'meeting' | 'followup'

export interface DemoTurn {
  speaker: 'prospect' | 'user' | 'aria'
  text: string
  expectedAction?: string     // what ARIA should fire
  delayMs: number             // pause before this turn
}

export interface DemoScript {
  name: string
  scenario: DemoScenario
  mode: 'negotiation' | 'meeting' | 'interview' | 'social'
  description: string
  turns: DemoTurn[]
}

// ── Scripts ────────────────────────────────────────────────────────────────

export const DEMO_SCRIPTS: Record<DemoScenario, DemoScript> = {

  negotiation: {
    name: 'TTC Sales — Price Objection',
    scenario: 'negotiation',
    mode: 'negotiation',
    description: 'HVAC operator pushes back on price. ARIA coaches through anchoring and silence.',
    turns: [
      {
        speaker: 'prospect',
        text: "We're actually pretty happy with ServiceTitan right now.",
        expectedAction: 'Challenge — whats missing',
        delayMs: 1000,
      },
      {
        speaker: 'prospect',
        text: "Your pricing is way too high for us. We just can't afford it.",
        expectedAction: 'Anchor — ROI',
        delayMs: 2000,
      },
      {
        speaker: 'prospect',
        text: "I need to check with my business partner before I can commit.",
        expectedAction: 'Ask — who decides',
        delayMs: 2000,
      },
      {
        speaker: 'prospect',
        text: "Can you do any better on the price? Give us a discount?",
        expectedAction: 'Reject — hold price',
        delayMs: 2000,
      },
      {
        speaker: 'prospect',
        text: "Okay, let's move forward. Send me the contract.",
        expectedAction: 'Accept — confirm terms',
        delayMs: 2000,
      },
    ],
  },

  meeting: {
    name: 'Team Meeting — Accountability',
    scenario: 'meeting',
    mode: 'meeting',
    description: 'Team meeting. ARIA flags vague ownership and unsourced numbers.',
    turns: [
      {
        speaker: 'prospect',
        text: "I think we'll see about 40 percent growth in Q3.",
        expectedAction: 'Challenge — source',
        delayMs: 1000,
      },
      {
        speaker: 'prospect',
        text: "We should assign someone to own the customer onboarding flow.",
        expectedAction: 'Clarify — who owns',
        delayMs: 2000,
      },
      {
        speaker: 'prospect',
        text: "Anyway, let's move on to the next agenda item.",
        expectedAction: 'Anchor — redirect',
        delayMs: 2000,
      },
    ],
  },

  followup: {
    name: 'Follow-Up Pressure — Hot Lead',
    scenario: 'followup',
    mode: 'negotiation',
    description: 'Hot lead goes cold. ARIA escalates follow-up pressure.',
    turns: [
      {
        speaker: 'prospect',
        text: "Send me the pricing details and I'll take a look.",
        expectedAction: 'Follow up — send details',
        delayMs: 1000,
      },
      {
        speaker: 'prospect',
        text: "I'll get back to you by end of week.",
        expectedAction: 'Follow up — check in',
        delayMs: 2000,
      },
      {
        speaker: 'prospect',
        text: "We need to think about it more. Maybe next quarter.",
        expectedAction: 'Ask — what changes',
        delayMs: 2000,
      },
    ],
  },
}

// ── Runner ─────────────────────────────────────────────────────────────────

export async function runDemo(
  scenario: DemoScenario,
  opts: { speak: boolean; verbose: boolean } = { speak: true, verbose: true }
): Promise<void> {
  console.log(`\n[DEMO] starting — scenario: ${scenario}`)

  const script = DEMO_SCRIPTS[scenario]
  if (!script) throw new Error(`Unknown demo scenario: ${scenario}`)

  // lazy — avoids resolution at import time
  const { decide, setMode } = await import('./decision.js')
  const { speak: speakFn }  = await import('./tts.js')

  console.log(`[DEMO] ▶ ${script.name}`)
  console.log(`[DEMO] ${script.description}\n`)

  setMode(script.mode)

  for (const turn of script.turns) {
    await new Promise(r => setTimeout(r, turn.delayMs))

    if (turn.speaker !== 'aria') {
      console.log(`\n[DEMO] ${turn.speaker.toUpperCase()}: "${turn.text}"`)
      if (turn.expectedAction) {
        console.log(`[DEMO] expected → ${turn.expectedAction}`)
      }

      const action = await decide(turn.text)
      if (action) {
        console.log(`[DEMO] ARIA → "${action}"`)
        if (opts.speak) speakFn(action)
      } else {
        console.log('[DEMO] ARIA → (no action)')
      }
    }
  }

  console.log('\n[DEMO] ✓ complete\n')
}