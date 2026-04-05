import { Mode } from './decision.js'

interface Rule {
  patterns: RegExp[]
  action: string
  priority: number
  severity?: 'critical' | 'normal'
}

const RULES: Record<Mode, Rule[]> = {
  negotiation: [
    {
      priority: 10,
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
      ],
      action: '⚠ Price objection — fear signal | hold number'
    },
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /need to think/i,
        /think about it/i,
        /get back to you/i,
        /not (sure|ready|convinced)/i,
        /let me (think|consider|look into)/i,
      ],
      action: 'They stalled — buying time | wait silent'
    },
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /need approval/i,
        /check with my (team|boss|manager|ceo|cfo)/i,
        /run it by/i,
        /not my (call|decision)/i,
        /have to ask/i,
      ],
      action: 'Approval needed — not decision maker | ask who'
    },
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /using (a )?competitor/i,
        /already use/i,
        /currently use/i,
        /we have (service|software|a tool|a system)/i,
        /service ?titan|servicetitan|jobber|housecall/i,
      ],
      action: 'Competitor mentioned — pain unaddressed | find the gap'
    },
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /no budget/i,
        /budget is (gone|used|frozen|tight|limited)/i,
        /budget (doesn't|don't|wont|won't) allow/i,
      ],
      action: 'Budget frozen — timing issue | ask when resets'
    },
    {
      priority: 10,
      severity: 'normal',
      patterns: [
        /just send|send me (more )?info|send (over )?details/i,
        /email me/i,
        /send (it|something) over/i,
      ],
      action: 'Info request — stall tactic | send, set deadline'
    },
    {
      priority: 9,
      severity: 'critical',
      patterns: [
        /can you do better/i,
        /any (more )?flexibility/i,
        /best (you can do|price|offer)/i,
        /discount|deal|negotiate/i,
        /lower the price/i,
      ],
      action: '⚠ Discount asked — frame breaking | reject, add value'
    },
    {
      priority: 9,
      severity: 'normal',
      patterns: [
        /not ready/i,
        /bad timing/i,
        /maybe later/i,
        /next (quarter|year|month)/i,
        /not (the )?right time/i,
      ],
      action: 'Timing deflection — avoiding decision | ask what changes'
    },
    {
      priority: 8,
      severity: 'normal',
      patterns: [/^(?!.*\?).{200,}$/i],
      action: 'Rambling detected — losing frame | stop, ask question'
    },
  ],

  meeting: [
    {
      priority: 10,
      severity: 'critical',
      patterns: [/\d+(\.\d+)?(%| percent| million| billion)/i],
      action: '⚠ Stat uncited — credibility risk | ask the source'
    },
    {
      priority: 10,
      severity: 'normal',
      patterns: [/we should|we will|we are going to/i],
      action: 'No owner assigned — task will die | name someone'
    },
    {
      priority: 9,
      severity: 'normal',
      patterns: [/i think|i believe|i feel like/i],
      action: 'Opinion as fact — frame drift | push back'
    },
    {
      priority: 8,
      severity: 'normal',
      patterns: [/anyway|moving on|next topic|let's move/i],
      action: 'Topic buried — decision delayed | redirect now'
    },
  ],

  interview: [
    {
      priority: 10,
      severity: 'normal',
      patterns: [/weakness|struggle|fail|difficult/i],
      action: 'Trap question — reframe risk | lead with growth'
    },
    {
      priority: 10,
      severity: 'critical',
      patterns: [/salary|compensation|pay|rate|expectations/i],
      action: '⚠ Comp question — anchor risk | flip to their range'
    },
    {
      priority: 10,
      severity: 'normal',
      patterns: [/tell me about yourself|walk me through/i],
      action: 'Open framing — first impression | lead with impact'
    },
    {
      priority: 9,
      severity: 'normal',
      patterns: [/give me an example|tell me a time|describe a situation/i],
      action: 'Example needed — vague answer loses | use STAR format'
    },
    {
      priority: 8,
      severity: 'normal',
      patterns: [/^(?!.*\d).{150,}$/i],
      action: 'No numbers — weak answer | quantify the result'
    },
  ],

  social: [
    {
      priority: 10,
      severity: 'normal',
      patterns: [/i (just|really|actually) (think|feel|believe)/i],
      action: 'Oversharing detected — value dropping | stop talking'
    },
    {
      priority: 9,
      severity: 'normal',
      patterns: [/what do you do|what are you working on/i],
      action: 'Opportunity window — closing fast | anchor your work'
    },
    {
      priority: 10,
      severity: 'normal',
      patterns: [/invest|fund|capital|raise|portfolio/i],
      action: 'Investor detected — high leverage | engage directly'
    },
    {
      priority: 8,
      severity: 'normal',
      patterns: [/^(?!.*\?).{180,}$/i],
      action: 'Frame lost — they are leading | reset with question'
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