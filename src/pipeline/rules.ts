import { Mode } from './decision.js'

interface Rule {
  patterns: RegExp[]
  action: string
  priority: number
}

const RULES: Record<Mode, Rule[]> = {
  negotiation: [
    {
      priority: 10,
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
      action: 'Anchor — ROI'
    },
    {
      priority: 10,
      patterns: [
        /need to think/i,
        /think about it/i,
        /get back to you/i,
        /not (sure|ready|convinced)/i,
        /let me (think|consider|look into)/i,
      ],
      action: 'Wait — silence'
    },
    {
      priority: 10,
      patterns: [
        /need approval/i,
        /check with my (team|boss|manager|ceo|cfo)/i,
        /run it by/i,
        /not my (call|decision)/i,
        /have to ask/i,
      ],
      action: 'Ask — who decides'
    },
    {
      priority: 10,
      patterns: [
        /using (a )?competitor/i,
        /already use/i,
        /currently use/i,
        /we have (service|software|a tool|a system)/i,
        /service ?titan|servicetitan|jobber|housecall/i,
      ],
      action: 'Challenge — whats missing'
    },
    {
      priority: 10,
      patterns: [
        /no budget/i,
        /budget is (gone|used|frozen|tight|limited)/i,
        /budget (doesn't|don't|wont|won't) allow/i,
      ],
      action: 'Ask — when resets'
    },
    {
      priority: 10,
      patterns: [
        /just send|send me (more )?info|send (over )?details/i,
        /email me/i,
        /send (it|something) over/i,
      ],
      action: 'Ask — what convinces'
    },
    {
      priority: 9,
      patterns: [
        /can you do better/i,
        /any (more )?flexibility/i,
        /best (you can do|price|offer)/i,
        /discount|deal|negotiate/i,
        /lower the price/i,
      ],
      action: 'Reject — hold price'
    },
    {
      priority: 9,
      patterns: [
        /not ready/i,
        /bad timing/i,
        /maybe later/i,
        /next (quarter|year|month)/i,
        /not (the )?right time/i,
      ],
      action: 'Ask — what changes'
    },
    {
      priority: 8,
      patterns: [/^(?!.*\?).{200,}$/i],
      action: 'Wait — let talk'
    },
  ],

  meeting: [
    {
      priority: 10,
      patterns: [/\d+(\.\d+)?(%| percent| million| billion)/i],
      action: 'Challenge — source'
    },
    {
      priority: 10,
      patterns: [/we should|we will|we are going to/i],
      action: 'Clarify — who owns'
    },
    {
      priority: 9,
      patterns: [/i think|i believe|i feel like/i],
      action: 'Push — your point'
    },
    {
      priority: 8,
      patterns: [/anyway|moving on|next topic|let's move/i],
      action: 'Anchor — redirect'
    },
  ],

  interview: [
    {
      priority: 10,
      patterns: [/weakness|struggle|fail|difficult/i],
      action: 'Clarify — reframe growth'
    },
    {
      priority: 10,
      patterns: [/salary|compensation|pay|rate|expectations/i],
      action: 'Delay — their range'
    },
    {
      priority: 10,
      patterns: [/tell me about yourself|walk me through/i],
      action: 'Anchor — lead impact'
    },
    {
      priority: 9,
      patterns: [/give me an example|tell me a time|describe a situation/i],
      action: 'Clarify — STAR format'
    },
    {
      priority: 8,
      patterns: [/^(?!.*\d).{150,}$/i],
      action: 'Push — quantify result'
    },
  ],

  social: [
    {
      priority: 10,
      patterns: [/i (just|really|actually) (think|feel|believe)/i],
      action: 'Wait — let talk'
    },
    {
      priority: 9,
      patterns: [/what do you do|what are you working on/i],
      action: 'Anchor — your work'
    },
    {
      priority: 8,
      patterns: [/^(?!.*\?).{180,}$/i],
      action: 'Wait — let talk'
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