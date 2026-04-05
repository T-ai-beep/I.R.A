/**
 * demo.ts — Exhaustive ARIA test suite
 * Tests every capability ARIA claims to have.
 * Audio always off. Results scored at end.
 */

export type DemoScenario =
  | 'negotiation'
  | 'meeting'
  | 'followup'
  | 'interview'
  | 'investor'
  | 'social'
  | 'competitor'
  | 'stalling'
  | 'agreement'
  | 'question'
  | 'education'
  | 'lecture'
  | 'bug_tracking'
  | 'college_app'
  | 'hiring'
  | 'cofounder'
  | 'customer_objection'
  | 'cold_outreach'
  | 'panic'
  | 'edge_cases'

export interface DemoTurn {
  speaker: 'prospect' | 'user' | 'aria'
  text: string
  expectedAction?: string
  delayMs: number
}

export interface DemoScript {
  name: string
  scenario: DemoScenario
  mode: 'negotiation' | 'meeting' | 'interview' | 'social'
  description: string
  turns: DemoTurn[]
}

export const DEMO_SCRIPTS: Record<DemoScenario, DemoScript> = {

  // ── 1. Core negotiation ───────────────────────────────────────────────────
  negotiation: {
    name: 'TTC Sales — Full Price Objection Flow',
    scenario: 'negotiation',
    mode: 'negotiation',
    description: 'HVAC operator pushes back on price. Tests all negotiation signals.',
    turns: [
      { speaker: 'prospect', text: "We're actually pretty happy with ServiceTitan right now.", expectedAction: 'Competitor mentioned', delayMs: 1000 },
      { speaker: 'prospect', text: "Your pricing is way too high for us. We just can't afford it.", expectedAction: 'Price objection — hold number', delayMs: 2000 },
      { speaker: 'prospect', text: "I need to check with my business partner before I can commit.", expectedAction: 'Approval needed — ask who', delayMs: 2000 },
      { speaker: 'prospect', text: "Can you do any better on the price? Give us a discount?", expectedAction: 'Discount asked — reject', delayMs: 2000 },
      { speaker: 'prospect', text: "Okay, let's move forward. Send me the contract.", expectedAction: 'Agreement — confirm terms', delayMs: 2000 },
    ],
  },

  // ── 2. Meeting accountability ─────────────────────────────────────────────
  meeting: {
    name: 'Team Meeting — Accountability',
    scenario: 'meeting',
    mode: 'meeting',
    description: 'Tests stat flagging, ownership assignment, opinion detection.',
    turns: [
      { speaker: 'prospect', text: "I think we'll see about 40 percent growth in Q3.", expectedAction: 'Stat uncited — ask source', delayMs: 1000 },
      { speaker: 'prospect', text: "We should assign someone to own the customer onboarding flow.", expectedAction: 'No owner — name someone', delayMs: 2000 },
      { speaker: 'prospect', text: "I believe this strategy is the right one for us.", expectedAction: 'Opinion as fact — push back', delayMs: 2000 },
      { speaker: 'prospect', text: "Anyway, let's move on to the next agenda item.", expectedAction: 'Topic buried — redirect now', delayMs: 2000 },
    ],
  },

  // ── 3. Follow-up pressure ─────────────────────────────────────────────────
  followup: {
    name: 'Follow-Up Pressure — Hot Lead',
    scenario: 'followup',
    mode: 'negotiation',
    description: 'Tests follow-up signal detection and stall handling.',
    turns: [
      { speaker: 'prospect', text: "Send me the pricing details and I'll take a look.", expectedAction: 'Info request — send, set deadline', delayMs: 1000 },
      { speaker: 'prospect', text: "I'll get back to you by end of week.", expectedAction: 'Stall — check in', delayMs: 2000 },
      { speaker: 'prospect', text: "We need to think about it more. Maybe next quarter.", expectedAction: 'Timing deflection — ask what changes', delayMs: 2000 },
    ],
  },

  // ── 4. Interview trap questions ───────────────────────────────────────────
  interview: {
    name: 'Job Interview — Trap Questions',
    scenario: 'interview',
    mode: 'interview',
    description: 'Tests interview coaching — framing, traps, comp, STAR.',
    turns: [
      { speaker: 'prospect', text: "Tell me about yourself.", expectedAction: 'Open framing — lead with impact', delayMs: 1000 },
      { speaker: 'prospect', text: "What would you say is your biggest weakness?", expectedAction: 'Trap question — lead with growth', delayMs: 2000 },
      { speaker: 'prospect', text: "What are your salary expectations?", expectedAction: 'Comp question — flip to their range', delayMs: 2000 },
      { speaker: 'prospect', text: "Give me an example of a time you failed.", expectedAction: 'Example needed — use STAR format', delayMs: 2000 },
    ],
  },

  // ── 5. Investor pitch ─────────────────────────────────────────────────────
  investor: {
    name: 'Investor Pitch — Valuation Hold',
    scenario: 'investor',
    mode: 'negotiation',
    description: 'Investor lowballing. Tests ARIA preventing equity cave.',
    turns: [
      { speaker: 'prospect', text: "We're interested but the valuation seems high for this stage.", expectedAction: 'Price objection — hold number', delayMs: 1000 },
      { speaker: 'prospect', text: "What if we came in at a lower number and you gave us more equity?", expectedAction: 'Discount asked — reject', delayMs: 2000 },
      { speaker: 'prospect', text: "We need to run this by our partners before we can commit.", expectedAction: 'Approval needed — ask who', delayMs: 2000 },
      { speaker: 'prospect', text: "We want to move fast on this. Can we close this week?", expectedAction: 'Closing — confirm terms', delayMs: 2000 },
    ],
  },

  // ── 6. Social networking ──────────────────────────────────────────────────
  social: {
    name: 'Networking — Investor at Event',
    scenario: 'social',
    mode: 'social',
    description: 'Tests investor detection, opportunity flagging, overshare detection.',
    turns: [
      { speaker: 'prospect', text: "So what do you do?", expectedAction: 'Opportunity window — anchor your work', delayMs: 1000 },
      { speaker: 'prospect', text: "We run a fund focused on early stage B2B.", expectedAction: 'Investor detected — engage directly', delayMs: 2000 },
      { speaker: 'prospect', text: "I just really feel like the market isn't ready for this kind of thing yet.", expectedAction: 'Oversharing — stop talking', delayMs: 2000 },
      { speaker: 'prospect', text: "What are you working on right now?", expectedAction: 'Opportunity window — anchor your work', delayMs: 2000 },
    ],
  },

  // ── 7. Competitor lock-in ─────────────────────────────────────────────────
  competitor: {
    name: 'Competitor Lock-In — ServiceTitan',
    scenario: 'competitor',
    mode: 'negotiation',
    description: 'Tests competitor detection, switching cost objection.',
    turns: [
      { speaker: 'prospect', text: "We've been using ServiceTitan for three years.", expectedAction: 'Competitor — find the gap', delayMs: 1000 },
      { speaker: 'prospect', text: "We're pretty happy with our current solution honestly.", expectedAction: 'Competitor lock-in — surface the gap', delayMs: 2000 },
      { speaker: 'prospect', text: "The switching cost would be too high for us right now.", expectedAction: 'Price objection — anchor ROI', delayMs: 2000 },
      { speaker: 'prospect', text: "What makes you different from what we already have?", expectedAction: 'Question — ARIA responds', delayMs: 2000 },
    ],
  },

  // ── 8. Stalling ───────────────────────────────────────────────────────────
  stalling: {
    name: 'Stall Pattern — Momentum Dying',
    scenario: 'stalling',
    mode: 'negotiation',
    description: 'Tests stall detection through multiple stall signals.',
    turns: [
      { speaker: 'prospect', text: "Let me think about it and get back to you.", expectedAction: 'Stall — wait silent', delayMs: 1000 },
      { speaker: 'prospect', text: "I'm not sure yet. Maybe next month.", expectedAction: 'Timing deflection — ask what changes', delayMs: 2000 },
      { speaker: 'prospect', text: "We'll see. I need more time to decide.", expectedAction: 'Stall — ask what stops you', delayMs: 2000 },
      { speaker: 'prospect', text: "Let's reconnect next quarter when budget resets.", expectedAction: 'Budget frozen — ask when resets', delayMs: 2000 },
    ],
  },

  // ── 9. Agreement close ────────────────────────────────────────────────────
  agreement: {
    name: 'Close Sequence — Agreement Signals',
    scenario: 'agreement',
    mode: 'negotiation',
    description: 'Tests agreement signal detection at each stage of closing.',
    turns: [
      { speaker: 'prospect', text: "That sounds really good actually.", expectedAction: 'Agreement signal — push to close', delayMs: 1000 },
      { speaker: 'prospect', text: "I think we can make this work.", expectedAction: 'Agreement signal — confirm terms now', delayMs: 2000 },
      { speaker: 'prospect', text: "We'd like to move forward with this.", expectedAction: 'Agreement — confirm terms', delayMs: 2000 },
      { speaker: 'prospect', text: "Okay let's do it. Send me the contract.", expectedAction: 'Agreement — close now', delayMs: 2000 },
    ],
  },

  // ── 10. Question routing ──────────────────────────────────────────────────
  question: {
    name: 'Question Routing — ARIA Knowledge Base',
    scenario: 'question',
    mode: 'negotiation',
    description: 'Tests KB routing for who/what/goals and meta queries.',
    turns: [
      { speaker: 'prospect', text: "Who is Nathan?", expectedAction: 'ARIA_QUERY — KB answer', delayMs: 1000 },
      { speaker: 'prospect', text: "What is TTC?", expectedAction: 'ARIA_QUERY — KB answer', delayMs: 2000 },
      { speaker: 'prospect', text: "What are Tanay's goals?", expectedAction: 'ARIA_QUERY — KB answer', delayMs: 2000 },
      { speaker: 'prospect', text: "What should I say right now?", expectedAction: 'ARIA_QUERY — active mode', delayMs: 2000 },
    ],
  },

  // ── 11. Education ─────────────────────────────────────────────────────────
  education: {
    name: 'Education — Classroom Mode',
    scenario: 'education',
    mode: 'meeting',
    description: 'Tests ARIA in a classroom setting. Same signals as meeting mode.',
    turns: [
      { speaker: 'prospect', text: "Studies show that 80 percent of startups fail in the first year.", expectedAction: 'Stat uncited — ask source', delayMs: 1000 },
      { speaker: 'prospect', text: "I think this theory applies to all modern economies.", expectedAction: 'Opinion as fact — push back', delayMs: 2000 },
      { speaker: 'prospect', text: "We will cover the remaining chapters next week.", expectedAction: 'No owner — name someone', delayMs: 2000 },
      { speaker: 'prospect', text: "Anyway let's wrap up and move to the next topic.", expectedAction: 'Topic buried — redirect now', delayMs: 2000 },
    ],
  },

  // ── 12. Lecture / AP class ────────────────────────────────────────────────
  lecture: {
    name: 'Lecture — AP Class Note Taking',
    scenario: 'lecture',
    mode: 'meeting',
    description: 'Simulates Tanay in AP class. ARIA flags key facts and opinions.',
    turns: [
      { speaker: 'prospect', text: "The GDP grew by 3.2 percent last quarter according to the Fed.", expectedAction: 'Stat — note key figure', delayMs: 1000 },
      { speaker: 'prospect', text: "I believe the main cause of the crash was overleveraging.", expectedAction: 'Opinion as fact — flag it', delayMs: 2000 },
      { speaker: 'prospect', text: "We should review chapters 4 through 6 before the exam.", expectedAction: 'No owner — name someone', delayMs: 2000 },
      { speaker: 'prospect', text: "Alright moving on — next topic is monetary policy.", expectedAction: 'Topic buried — redirect', delayMs: 2000 },
    ],
  },

  // ── 13. Dev standup ───────────────────────────────────────────────────────
  bug_tracking: {
    name: 'Dev Standup — Bug Tracking',
    scenario: 'bug_tracking',
    mode: 'meeting',
    description: 'Dev standup. ARIA flags unowned bugs and vague timelines.',
    turns: [
      { speaker: 'prospect', text: "We think the API is failing about 15 percent of requests.", expectedAction: 'Stat uncited — ask source', delayMs: 1000 },
      { speaker: 'prospect', text: "Someone should probably look into the auth bug.", expectedAction: 'No owner — name someone', delayMs: 2000 },
      { speaker: 'prospect', text: "I believe we can ship this by Friday.", expectedAction: 'Opinion as fact — push back', delayMs: 2000 },
      { speaker: 'prospect', text: "Let's move on and circle back to this later.", expectedAction: 'Topic buried — redirect now', delayMs: 2000 },
    ],
  },

  // ── 14. College admissions ────────────────────────────────────────────────
  college_app: {
    name: 'College Interview — Admissions',
    scenario: 'college_app',
    mode: 'interview',
    description: 'College admissions interview coaching.',
    turns: [
      { speaker: 'prospect', text: "Tell me about yourself and what makes you unique.", expectedAction: 'Open framing — lead with impact', delayMs: 1000 },
      { speaker: 'prospect', text: "What would you say is your biggest academic weakness?", expectedAction: 'Trap question — lead with growth', delayMs: 2000 },
      { speaker: 'prospect', text: "Describe a time you showed leadership under pressure.", expectedAction: 'Example needed — use STAR format', delayMs: 2000 },
      { speaker: 'prospect', text: "What are your salary expectations after graduation?", expectedAction: 'Comp question — flip to their range', delayMs: 2000 },
    ],
  },

  // ── 15. Hiring a dev ──────────────────────────────────────────────────────
  hiring: {
    name: 'Hiring — Recruiting a Developer',
    scenario: 'hiring',
    mode: 'negotiation',
    description: 'Tanay hiring a dev for TTC. Tests comp anchoring and stall detection.',
    turns: [
      { speaker: 'prospect', text: "I'm looking for something in the range of $120k to $150k.", expectedAction: 'Comp anchor — hold or flip', delayMs: 1000 },
      { speaker: 'prospect', text: "I need to think about it. I have another offer on the table.", expectedAction: 'Stall — competing offer | push now', delayMs: 2000 },
      { speaker: 'prospect', text: "Can you do any better on the equity?", expectedAction: 'Discount asked — reject, add value', delayMs: 2000 },
      { speaker: 'prospect', text: "Okay I'm in. When do we start?", expectedAction: 'Agreement — confirm terms', delayMs: 2000 },
    ],
  },

  // ── 16. Cofounder conflict ────────────────────────────────────────────────
  cofounder: {
    name: 'Cofounder Conflict — Nathan',
    scenario: 'cofounder',
    mode: 'meeting',
    description: 'Disagreement with Nathan. ARIA flags vague ownership and opinion drift.',
    turns: [
      { speaker: 'prospect', text: "I think we should rebuild the entire frontend from scratch.", expectedAction: 'Opinion as fact — push back', delayMs: 1000 },
      { speaker: 'prospect', text: "We will get this done by next sprint easily.", expectedAction: 'No owner — name someone', delayMs: 2000 },
      { speaker: 'prospect', text: "I believe the users will love this new approach.", expectedAction: 'Opinion as fact — push back', delayMs: 2000 },
      { speaker: 'prospect', text: "Anyway we can figure out the details later.", expectedAction: 'Topic buried — redirect now', delayMs: 2000 },
    ],
  },

  // ── 17. Boring Solutions objections ───────────────────────────────────────
  customer_objection: {
    name: 'Boring Solutions — Customer Objections',
    scenario: 'customer_objection',
    mode: 'negotiation',
    description: 'Small HVAC operator objecting to Boring Solutions pricing.',
    turns: [
      { speaker: 'prospect', text: "Fifteen hundred upfront is way too much for a small operation like ours.", expectedAction: 'Price objection — anchor ROI', delayMs: 1000 },
      { speaker: 'prospect', text: "We track everything manually right now and it works fine.", expectedAction: 'Competitor — find the gap', delayMs: 2000 },
      { speaker: 'prospect', text: "Can you do a trial period or a lower upfront cost?", expectedAction: 'Discount asked — reject, add value', delayMs: 2000 },
      { speaker: 'prospect', text: "Let me talk to my wife about it. She handles the finances.", expectedAction: 'Approval needed — ask who', delayMs: 2000 },
    ],
  },

  // ── 18. Cold outreach ─────────────────────────────────────────────────────
  cold_outreach: {
    name: 'Cold Outreach — Inbound Response',
    scenario: 'cold_outreach',
    mode: 'negotiation',
    description: 'Inbound from cold email. Tests warm-to-close sequence.',
    turns: [
      { speaker: 'prospect', text: "I saw your email. Can you send me more information about what you offer?", expectedAction: 'Info request — send, set deadline', delayMs: 1000 },
      { speaker: 'prospect', text: "Sounds interesting. What's the pricing look like?", expectedAction: 'Offer discuss — anchor value first', delayMs: 2000 },
      { speaker: 'prospect', text: "That's a bit more than I expected. Can you work with us on the price?", expectedAction: 'Discount asked — reject, add value', delayMs: 2000 },
      { speaker: 'prospect', text: "Alright, let's set up a call to go over the details.", expectedAction: 'Agreement — confirm terms', delayMs: 2000 },
    ],
  },

  // ── 19. Panic mode ────────────────────────────────────────────────────────
  panic: {
    name: 'Panic Mode — Losing a Deal Live',
    scenario: 'panic',
    mode: 'negotiation',
    description: 'Deal collapsing in real time. Tests ARIA under maximum pressure.',
    turns: [
      { speaker: 'prospect', text: "We've decided to go with ServiceTitan instead. Sorry.", expectedAction: 'Competitor — surface the gap fast', delayMs: 1000 },
      { speaker: 'prospect', text: "We already signed with them last week actually.", expectedAction: 'Lost deal — exit or challenge', delayMs: 2000 },
      { speaker: 'prospect', text: "Unless you can beat their price by a significant margin.", expectedAction: 'Discount asked — hold firm or exit', delayMs: 2000 },
      { speaker: 'prospect', text: "What can you do for us right now to make this work?", expectedAction: 'Question — ARIA responds with anchor', delayMs: 2000 },
    ],
  },

  // ── 20. Edge cases ────────────────────────────────────────────────────────
  edge_cases: {
    name: 'Edge Cases — Noise, Short, Ambiguous',
    scenario: 'edge_cases',
    mode: 'negotiation',
    description: 'Tests ARIA handling noise, short utterances, ambiguous signals, and rambling.',
    turns: [
      { speaker: 'prospect', text: "Hmm.", expectedAction: 'PASS — too short', delayMs: 1000 },
      { speaker: 'prospect', text: "Yeah.", expectedAction: 'PASS — ambiguous', delayMs: 2000 },
      { speaker: 'prospect', text: "I don't know.", expectedAction: 'Weak answer detected', delayMs: 2000 },
      { speaker: 'prospect', text: "This is just so complicated and I'm not sure where to even start with all of this because there are so many moving parts and it's really hard to make a decision when you don't know all the variables involved in the whole situation.", expectedAction: 'Rambling — stop, ask question', delayMs: 2000 },
      { speaker: 'prospect', text: "What?", expectedAction: 'PASS — too short', delayMs: 2000 },
    ],
  },
}

// ── Runner ─────────────────────────────────────────────────────────────────

export async function runDemo(
  scenario: DemoScenario,
  opts: { speak: boolean; verbose: boolean } = { speak: false, verbose: true }
): Promise<{ fired: number; passed: number; total: number }> {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`[DEMO] ${scenario.toUpperCase()}`)
  console.log(`${'═'.repeat(60)}`)

  const script = DEMO_SCRIPTS[scenario]
  if (!script) throw new Error(`Unknown demo scenario: ${scenario}`)

  const { decide, setMode } = await import('./decision.js')

  const speakFn = opts.speak
    ? (await import('./tts.js')).speak
    : (text: string) => console.log(`[TTS-MUTED] "${text}"`)

  console.log(`▶ ${script.name}`)
  console.log(`  ${script.description}\n`)

  setMode(script.mode)

  let fired = 0
  let passed = 0

  for (const turn of script.turns) {
    await new Promise(r => setTimeout(r, turn.delayMs))

    if (turn.speaker !== 'aria') {
      console.log(`\n  PROSPECT: "${turn.text}"`)
      if (turn.expectedAction) {
        console.log(`  EXPECTED: ${turn.expectedAction}`)
      }

      const action = await decide(turn.text)
      if (action) {
        fired++
        console.log(`  ARIA ✓  : "${action}"`)
        speakFn(action)
      } else {
        passed++
        console.log(`  ARIA ✗  : (no action)`)
      }
    }
  }

  const total = script.turns.filter(t => t.speaker !== 'aria').length
  const pct = Math.round((fired / total) * 100)
  console.log(`\n  RESULT: ${fired}/${total} fired (${pct}%) — ${passed} passed\n`)

  return { fired, passed, total }
}

// ── Run all ────────────────────────────────────────────────────────────────

export async function runAllDemos(): Promise<void> {
  const scenarios = Object.keys(DEMO_SCRIPTS) as DemoScenario[]
  const results: Record<string, { fired: number; passed: number; total: number }> = {}

  for (const scenario of scenarios) {
    results[scenario] = await runDemo(scenario, { speak: false, verbose: true })
    await new Promise(r => setTimeout(r, 500))
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`ARIA TEST SCORECARD`)
  console.log(`${'═'.repeat(60)}`)

  let totalFired = 0
  let totalTurns = 0

  for (const [scenario, r] of Object.entries(results)) {
    const pct = Math.round((r.fired / r.total) * 100)
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))
    const status = pct === 100 ? '✅' : pct >= 75 ? '🟡' : '❌'
    console.log(`  ${status} ${scenario.padEnd(22)} ${bar} ${pct}% (${r.fired}/${r.total})`)
    totalFired += r.fired
    totalTurns += r.total
  }

  const overallPct = Math.round((totalFired / totalTurns) * 100)
  console.log(`${'─'.repeat(60)}`)
  console.log(`  OVERALL: ${totalFired}/${totalTurns} — ${overallPct}%`)
  console.log(`${'═'.repeat(60)}\n`)
}