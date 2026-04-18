import { Mode } from './decision.js'

interface Rule {
  patterns: RegExp[]
  action: string
  priority: number
  severity?: 'critical' | 'normal'
}

// ── NEGOTIATION RULES ──────────────────────────────────────────────────────
// Priority scale: 12 = closing, 11 = money, 10 = objections, 9 = timing,
//                 8 = info/stall, 7 = weak, 6 = noise

const NEGOTIATION_RULES: Rule[] = [
  // ── CRITICAL P12: Agreement / close signals ───────────────────────────
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
      /i'm in\b/i,
      /when can we start/i,
      /how do we proceed/i,
      /ready to move forward/i,
      /close this week/i,
      /when do we get started/i,
      // Adversarial: implied agreement
      /could really work for us/i,
      /this could really work/i,
      /yeah.*i am in/i,
      /alright.*let's.*do this/i,
    ],
    action: '⚠ Agreement signal — close now | confirm terms',
  },

  // ── CRITICAL P11: Price objection ─────────────────────────────────────
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
      /don't have the (budget|money|funds)/i,
      /not worth (it|the price|the cost)/i,
      /switching cost/i,
      /cost to switch/i,
      /valuation seems high/i,
      /fifteen hundred.*too/i,
      /too much for a small/i,
      /upfront is.*too/i,
      // Adversarial: implied price pain
      /that is a lot\b/i,
      /that's a lot\b/i,
      /a lot for (a |our )?company/i,
      /a lot for (a |our )?(size|operation|business)/i,
      /was not expecting that number/i,
      /wasn't expecting that number/i,
      /not sure.*get that value/i,
      /not sure.*would get.*value/i,
      /not sure we would get that/i,
      /sticker shock/i,
      /feels like a stretch/i,
      /a stretch for.*budget/i,
      /fifteen hundred bucks is a lot/i,
      /lot for us man/i,
      /feels like too much/i,
    ],
    action: '⚠ Price objection — fear signal | hold number',
  },

  // ── CRITICAL P11: Comp anchor (hiring/salary) ─────────────────────────
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
      /range of \$[\d,]+/i,
      /something in the range/i,
    ],
    action: '⚠ Comp anchor — flip | ask total comp picture',
  },

  // ── CRITICAL P11: Discount / flexibility asked ─────────────────────────
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
      // Adversarial
      /any chance.*wiggle room/i,
      /wiggle room on that/i,
      /some wiggle room/i,
      /is there.*room on/i,
      /come down at all/i,
    ],
    action: '⚠ Discount asked — frame breaking | reject, add value',
  },

  // ── HIGH P10: Stall signals ───────────────────────────────────────────
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
      // Adversarial
      /circle back/i,
      /be in touch/i,
      /will be in touch/i,
      /sounds interesting.*we will/i,
      /this is interesting.*we will/i,
    ],
    action: 'They stalled — buying time | wait silent',
  },

  // ── HIGH P10: Authority block — formal ────────────────────────────────
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
      // Adversarial
      /my business partner would need/i,
      /partner.*weigh in/i,
      /our team would need to align/i,
      /team.*align on/i,
    ],
    action: 'Approval needed — not decision maker | ask who',
  },

  // ── HIGH P10: Authority block — informal (spouse, family) ─────────────
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

  // ── HIGH P10: Competitor mentioned / lost deal ────────────────────────
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
      /happy with.*current/i,
      // Adversarial
      /signed the paperwork with them/i,
      /already signed with/i,
    ],
    action: 'Competitor mentioned — pain unaddressed | find the gap',
  },

  // ── HIGH P10: Manual tracking ─────────────────────────────────────────
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

  // ── HIGH P10: Budget frozen ────────────────────────────────────────────
  {
    priority: 10,
    severity: 'normal',
    patterns: [
      /no budget/i,
      /budget is (gone|used|frozen|tight|limited)/i,
      /budget (doesn't|don't|wont|won't) allow/i,
      /when budget resets/i,
      /next quarter.*budget/i,
      /budget is tight/i,
    ],
    action: 'Budget frozen — timing issue | ask when resets',
  },

  // ── HIGH P10: Info request (stall tactic) ────────────────────────────
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
      /saw your email.*send me more/i,
      /send me more/i,
    ],
    action: 'Info request — stall tactic | send, set deadline',
  },

  // ── MEDIUM P9: Timing deflection ──────────────────────────────────────
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
      /not right now/i,
    ],
    action: 'Timing deflection — avoiding decision | ask what changes',
  },

  // ── LOW P8: Rambling ─────────────────────────────────────────────────
  {
    priority: 8,
    severity: 'normal',
    patterns: [/^(?!.*\?).{200,}$/i],
    action: 'Rambling detected — losing frame | stop, ask question',
  },
]

// ── MEETING RULES ──────────────────────────────────────────────────────────

const MEETING_RULES: Rule[] = [
  // ── CRITICAL P10: Stat without source ────────────────────────────────
  {
    priority: 10,
    severity: 'critical',
    patterns: [/\d+(\.\d+)?(%| percent| million| billion)/i],
    action: '⚠ Stat uncited — credibility risk | ask the source',
  },

  // ── HIGH P10: No owner assigned ───────────────────────────────────────
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

  // ── MEDIUM P9: Opinion stated as fact ────────────────────────────────
  {
    priority: 9,
    severity: 'normal',
    patterns: [/i think|i believe|i feel like/i],
    action: 'Opinion as fact — frame drift | push back',
  },

  // ── LOW P8: Topic being buried ───────────────────────────────────────
  {
    priority: 8,
    severity: 'normal',
    patterns: [/anyway|moving on|next topic|let's move|circle back|wrap up/i],
    action: 'Topic buried — decision delayed | redirect now',
  },
]

// ── INTERVIEW RULES ────────────────────────────────────────────────────────

const INTERVIEW_RULES: Rule[] = [
  // ── CRITICAL P10: Comp question ───────────────────────────────────────
  {
    priority: 10,
    severity: 'critical',
    patterns: [/salary|compensation|pay|rate|expectations/i],
    action: '⚠ Comp question — anchor risk | flip to their range',
  },

  // ── HIGH P10: Trap / weakness question ────────────────────────────────
  {
    priority: 10,
    severity: 'normal',
    patterns: [/weakness|struggle|fail|difficult/i],
    action: 'Trap question — reframe risk | lead with growth',
  },

  // ── HIGH P10: Open framing ────────────────────────────────────────────
  {
    priority: 10,
    severity: 'normal',
    patterns: [/tell me about yourself|walk me through/i],
    action: 'Open framing — first impression | lead with impact',
  },

  // ── HIGH P9: Behavioral example needed ──────────────────────────────
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

  // ── LOW P8: No numbers in answer ─────────────────────────────────────
  {
    priority: 8,
    severity: 'normal',
    patterns: [/^(?!.*\d).{150,}$/i],
    action: 'No numbers — weak answer | quantify the result',
  },
]

// ── SOCIAL RULES ───────────────────────────────────────────────────────────

const SOCIAL_RULES: Rule[] = [
  // ── CRITICAL P11: Oversharing ─────────────────────────────────────────
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

  // ── HIGH P10: Investor detected ───────────────────────────────────────
  {
    priority: 10,
    severity: 'normal',
    patterns: [/invest|fund|capital|raise|portfolio/i],
    action: 'Investor detected — high leverage | engage directly',
  },

  // ── MEDIUM P9: Opportunity window ────────────────────────────────────
  {
    priority: 9,
    severity: 'normal',
    patterns: [/what do you do|what are you working on/i],
    action: 'Opportunity window — closing fast | anchor your work',
  },

  // ── LOW P8: Frame lost ───────────────────────────────────────────────
  {
    priority: 8,
    severity: 'normal',
    patterns: [/^(?!.*\?).{180,}$/i],
    action: 'Frame lost — they are leading | reset with question',
  },
]

// ── Mode → rules map (pre-sorted by priority descending at load time) ──────
// Sorting once here avoids re-sorting on every matchRule() call.

const RULES: Record<Mode, Rule[]> = {
  negotiation: [...NEGOTIATION_RULES].sort((a, b) => b.priority - a.priority),
  meeting:     [...MEETING_RULES].sort((a, b) => b.priority - a.priority),
  interview:   [...INTERVIEW_RULES].sort((a, b) => b.priority - a.priority),
  social:      [...SOCIAL_RULES].sort((a, b) => b.priority - a.priority),
}

export function matchRule(transcript: string, mode: Mode): string | null {
  const rules = RULES[mode]
  if (!rules) return null

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (pattern.test(transcript)) {
        return rule.action
      }
    }
  }

  return null
}