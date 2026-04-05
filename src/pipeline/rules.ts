import { Mode } from './decision.js'

interface Rule {
  patterns: RegExp[]
  action: string
  priority: number
  severity?: 'critical' | 'normal'
}

const RULES: Record<Mode, Rule[]> = {
  negotiation: [
    // ── CRITICAL: Agreement / close signals ───────────────────────────────
    {
      priority: 12,
      severity: 'critical',
      patterns: [
        /let's move forward/i,
        /send me the contract/i,
        /we're ready to sign/i,
        /let's do it/i,
        /okay.*move forward/i,
        /we're in/i,
        /i'll take it/i,
        /okay let's do it/i,
        /when do we start/i,
        /i'm in/i,
      ],
      action: '⚠ Agreement signal — close now | confirm terms',
    },

    // ── CRITICAL: Price objection ─────────────────────────────────────────
    {
      priority: 11,
      severity: 'critical',
      patterns: [
        /too expensive/i,
        /price is too high/i,
        /can't afford/i,
        /out of budget/i,
        /too much money/i,
        /can't (justify|spend|shell|pay)/i,
        /\$[\d,]+\s*(a month|per month|monthly)/i,
        /don't have the (budget|money|funds)/i,
        /not worth (it|the price|the cost)/i,
        /switching cost/i,
        /cost to switch/i,
        /valuation seems high/i,
        /fifteen hundred.*too much/i,
        /too much for a small/i,
        /upfront is.*too/i,
      ],
      action: '⚠ Price objection — fear signal | hold number',
    },

    // ── CRITICAL: Comp anchor stated (hiring / salary) ────────────────────
    {
      priority: 11,
      severity: 'critical',
      patterns: [
        /looking for.*range/i,
        /in the range of/i,
        /between \$[\d,]+ and \$[\d,]+/i,
        /\$[\d,]+k? to \$[\d,]+k?/i,
        /expecting.*\$[\d,]+/i,
        /i need.*\$[\d,]+/i,
      ],
      action: '⚠ Comp anchor — flip | ask total comp picture',
    },

    // ── CRITICAL: Discount / trial / lower cost asked ─────────────────────
    {
      priority: 11,
      severity: 'critical',
      patterns: [
        /can you do better/i,
        /any (more )?flexibility/i,
        /best (you can do|price|offer)/i,
        /discount|negotiate/i,
        /lower the price/i,
        /lower (the )?number/i,
        /come in (at )?lower/i,
        /give us more equity/i,
        /better on the price/i,
        /trial period/i,
        /lower upfront/i,
        /pilot program/i,
        /try before/i,
        /test it (out|first)/i,
        /month.to.month/i,
        /work with us on the price/i,
      ],
      action: '⚠ Discount asked — frame breaking | reject, add value',
    },

    // ── HIGH: Stall signals ───────────────────────────────────────────────
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /need to think/i,
        /think about it/i,
        /get back to you/i,
        /not (sure|ready|convinced)/i,
        /let me (think|consider|look into)/i,
        /i have another offer/i,
        /competing offer/i,
      ],
      action: 'They stalled — buying time | wait silent',
    },

    // ── HIGH: Authority block — formal ────────────────────────────────────
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /need approval/i,
        /check with my (team|boss|manager|ceo|cfo|partner|business partner|partners)/i,
        /run it by/i,
        /not my (call|decision)/i,
        /have to ask/i,
        /run this by our/i,
      ],
      action: 'Approval needed — not decision maker | ask who',
    },

    // ── HIGH: Authority block — informal (spouse, family) ─────────────────
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /talk to my (wife|husband|spouse)/i,
        /she handles|he handles/i,
        /my (wife|husband) (handles|manages|does) the/i,
        /run it by my (wife|husband)/i,
        /ask my (wife|husband)/i,
      ],
      action: 'Approval needed — not decision maker | ask who',
    },

    // ── HIGH: Competitor mentioned ────────────────────────────────────────
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /using (a )?competitor/i,
        /already use/i,
        /currently use/i,
        /we have (service|software|a tool|a system)/i,
        /service ?titan|servicetitan|jobber|housecall/i,
        /been using.*(three|two|four|five|\d+) years/i,
        /went with|decided to go with/i,
        /chose.*instead/i,
        /signed with/i,
      ],
      action: 'Competitor mentioned — pain unaddressed | find the gap',
    },

    // ── HIGH: Manual tracking objection ───────────────────────────────────
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /track.*(manually|by hand|spreadsheet)/i,
        /do it manually/i,
        /works fine.*manual/i,
        /manual(ly)?.*(works|fine|okay|good)/i,
        /we track everything manually/i,
        /pen and paper/i,
        /excel for that/i,
        /google sheets/i,
      ],
      action: 'Manual process — find the slip | ask what falls through',
    },

    // ── HIGH: Budget frozen ────────────────────────────────────────────────
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /no budget/i,
        /budget is (gone|used|frozen|tight|limited)/i,
        /budget (doesn't|don't|wont|won't) allow/i,
        /when budget resets/i,
        /next quarter.*budget/i,
      ],
      action: 'Budget frozen — timing issue | ask when resets',
    },

    // ── HIGH: Info request (stall tactic) ────────────────────────────────
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /send me (the |more )?pricing/i,
        /send (over |me )?details/i,
        /just send|send me (more )?info/i,
        /email me/i,
        /send (it|something) over/i,
        /i'll take a look/i,
        /can you send me more information/i,
        /more information about what you offer/i,
      ],
      action: 'Info request — stall tactic | send, set deadline',
    },

    // ── MEDIUM: Timing deflection ─────────────────────────────────────────
    {
      priority: 9,
      severity: 'normal',
      patterns: [
        /not ready/i,
        /bad timing/i,
        /maybe later/i,
        /next (quarter|year|month)/i,
        /not (the )?right time/i,
        /reconnect next/i,
      ],
      action: 'Timing deflection — avoiding decision | ask what changes',
    },

    // ── LOW: Rambling ─────────────────────────────────────────────────────
    {
      priority: 8,
      severity: 'normal',
      patterns: [/^(?!.*\?).{200,}$/i],
      action: 'Rambling detected — losing frame | stop, ask question',
    },
  ],

  meeting: [
    // ── CRITICAL: Stat without source ────────────────────────────────────
    {
      priority: 10,
      severity: 'critical',
      patterns: [/\d+(\.\d+)?(%| percent| million| billion)/i],
      action: '⚠ Stat uncited — credibility risk | ask the source',
    },

    // ── HIGH: No owner assigned ───────────────────────────────────────────
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /we should|we will|we are going to/i,
        /someone should/i,
        /someone (probably |needs to |has to )?look into/i,
        /somebody should/i,
        /we need someone to/i,
      ],
      action: 'No owner assigned — task will die | name someone',
    },

    // ── MEDIUM: Opinion stated as fact ────────────────────────────────────
    {
      priority: 9,
      severity: 'normal',
      patterns: [/i think|i believe|i feel like/i],
      action: 'Opinion as fact — frame drift | push back',
    },

    // ── LOW: Topic being buried ───────────────────────────────────────────
    {
      priority: 8,
      severity: 'normal',
      patterns: [/anyway|moving on|next topic|let's move|circle back|wrap up/i],
      action: 'Topic buried — decision delayed | redirect now',
    },
  ],

  interview: [
    // ── CRITICAL: Comp question ───────────────────────────────────────────
    {
      priority: 10,
      severity: 'critical',
      patterns: [/salary|compensation|pay|rate|expectations/i],
      action: '⚠ Comp question — anchor risk | flip to their range',
    },

    // ── HIGH: Trap / weakness question ────────────────────────────────────
    {
      priority: 10,
      severity: 'normal',
      patterns: [/weakness|struggle|fail|difficult/i],
      action: 'Trap question — reframe risk | lead with growth',
    },

    // ── HIGH: Open framing ────────────────────────────────────────────────
    {
      priority: 10,
      severity: 'normal',
      patterns: [/tell me about yourself|walk me through/i],
      action: 'Open framing — first impression | lead with impact',
    },

    // ── HIGH: Behavioral example needed ──────────────────────────────────
    {
      priority: 9,
      severity: 'normal',
      patterns: [
        /give me an example/i,
        /tell me a time/i,
        /describe a situation/i,
        /describe a time/i,
        /walk me through a time/i,
        /tell me about a time/i,
      ],
      action: 'Example needed — vague answer loses | use STAR format',
    },

    // ── LOW: No numbers in answer ─────────────────────────────────────────
    {
      priority: 8,
      severity: 'normal',
      patterns: [/^(?!.*\d).{150,}$/i],
      action: 'No numbers — weak answer | quantify the result',
    },
  ],

  social: [
    // ── CRITICAL: Oversharing ─────────────────────────────────────────────
    {
      priority: 11,
      severity: 'critical',
      patterns: [
        /i (just|really|actually) (think|feel|believe)/i,
        /feel like the market/i,
        /nobody (really )?gets it/i,
      ],
      action: 'Oversharing detected — value dropping | stop talking',
    },

    // ── HIGH: Investor detected ───────────────────────────────────────────
    {
      priority: 10,
      severity: 'normal',
      patterns: [/invest|fund|capital|raise|portfolio/i],
      action: 'Investor detected — high leverage | engage directly',
    },

    // ── MEDIUM: Opportunity window ────────────────────────────────────────
    {
      priority: 9,
      severity: 'normal',
      patterns: [/what do you do|what are you working on/i],
      action: 'Opportunity window — closing fast | anchor your work',
    },

    // ── LOW: Frame lost ───────────────────────────────────────────────────
    {
      priority: 8,
      severity: 'normal',
      patterns: [/^(?!.*\?).{180,}$/i],
      action: 'Frame lost — they are leading | reset with question',
    },
  ],
}

export function matchRule(transcript: string, mode: Mode): string | null {
  const rules = RULES[mode]
  if (!rules) return null

  const sorted = [...rules].sort((a, b) => b.priority - a.priority)

  for (const rule of sorted) {
    for (const pattern of rule.patterns) {
      if (pattern.test(transcript)) {
        return rule.action
      }
    }
  }

  return null
}