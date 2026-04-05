import { CONFIG } from '../config.js'

interface Example {
  text: string
  action: string
  embedding?: number[]
}

const EXAMPLES: Example[] = [
  // price objections
  { text: "that's too expensive for us", action: "⚠ Price objection — fear signal | hold number" },
  { text: "we can't afford that right now", action: "⚠ Price objection — fear signal | hold number" },
  { text: "the price is way too high", action: "⚠ Price objection — fear signal | hold number" },
  { text: "we don't have budget for this", action: "Budget frozen — timing issue | ask when resets" },
  { text: "that's out of our price range", action: "⚠ Price objection — fear signal | hold number" },
  { text: "that's a lot of money for us", action: "⚠ Price objection — fear signal | hold number" },
  { text: "we're tight on budget right now", action: "Budget frozen — timing issue | ask when resets" },
  { text: "can you do anything on the price", action: "⚠ Discount asked — frame breaking | reject, add value" },
  { text: "is there any flexibility there", action: "⚠ Discount asked — frame breaking | reject, add value" },
  { text: "can we get a discount", action: "⚠ Discount asked — frame breaking | reject, add value" },

  // stalling
  { text: "let me think about it", action: "They stalled — buying time | wait silent" },
  { text: "i need more time to decide", action: "They stalled — buying time | wait silent" },
  { text: "i'll get back to you", action: "Stall signal — momentum dying | ask what stops you" },
  { text: "we're not ready to move forward yet", action: "Timing deflection — avoiding decision | ask what changes" },
  { text: "maybe next quarter", action: "Timing deflection — avoiding decision | ask what changes" },

  // authority
  { text: "i need to check with my team", action: "Approval needed — not decision maker | ask who" },
  { text: "my boss has to approve this", action: "Approval needed — not decision maker | ask who" },
  { text: "i can't make this decision alone", action: "Approval needed — not decision maker | ask who" },
  { text: "let me run it by our CFO", action: "Approval needed — not decision maker | ask who" },
  { text: "i have to go over it with my manager", action: "Approval needed — not decision maker | ask who" },

  // competitor
  { text: "we already use servicetitan", action: "Competitor mentioned — pain unaddressed | find the gap" },
  { text: "we have a system in place", action: "Competitor mentioned — pain unaddressed | find the gap" },
  { text: "we're happy with our current solution", action: "Competitor lock-in — switching cost fear | surface the gap" },
  { text: "we use another platform for that", action: "Competitor mentioned — pain unaddressed | find the gap" },

  // agreement signals
  { text: "that sounds really good", action: "⚠ Agreement signal — deal closing | confirm terms now" },
  { text: "i think we're interested", action: "⚠ Agreement signal — deal closing | push to close" },
  { text: "we'd like to move forward", action: "⚠ Agreement signal — deal closing | confirm terms now" },
  { text: "i think we can make this work", action: "⚠ Agreement signal — deal closing | push to close" },

  // seller rambling
  { text: "and also we have this feature and that feature and you can do this and that", action: "Rambling detected — losing frame | stop, ask question" },
  { text: "so basically what we do is we take your data and we process it and then we", action: "Rambling detected — losing frame | stop, ask question" },
  { text: "let me explain everything we offer starting with the first module", action: "Rambling detected — losing frame | stop, ask question" },

  // meeting
  { text: "i think the numbers show about 40 percent growth", action: "⚠ Stat uncited — credibility risk | ask the source" },
  { text: "we should probably assign someone to own this", action: "No owner assigned — task will die | name someone" },
  { text: "let's table this and move on", action: "Topic buried — decision delayed | redirect now" },

  // interview
  { text: "what would you say is your biggest weakness", action: "Trap question — reframe risk | lead with growth" },
  { text: "what are your salary expectations", action: "⚠ Comp question — anchor risk | flip to their range" },
  { text: "tell me about yourself", action: "Open framing — first impression | lead with impact" },

  // social
  { text: "so what do you do", action: "Opportunity window — closing fast | anchor your work" },
  { text: "i just feel like nobody really gets it", action: "Oversharing detected — value dropping | stop talking" },
  { text: "i'm an investor looking at early stage", action: "Investor detected — high leverage | engage directly" },
  { text: "we run a fund focused on B2B", action: "Investor detected — high leverage | engage directly" },

  // brutal honesty — self-detection
  { text: "well i mean it depends i guess maybe we could", action: "⚠ Weak answer — value unclear | restate with confidence" },
  { text: "i don't know it could be a lot of things", action: "⚠ Weak answer — value unclear | restate with confidence" },
  { text: "sure we can probably do something", action: "⚠ Conceding — frame collapsing | hold position" },

  // meta questions to ARIA — active mode triggers
  { text: "what should I say right now", action: "ARIA_QUERY" },
  { text: "what do I do here", action: "ARIA_QUERY" },
  { text: "help me respond", action: "ARIA_QUERY" },
  { text: "what was the last offer", action: "ARIA_QUERY" },
  { text: "what did they say", action: "ARIA_QUERY" },
  { text: "give me a suggestion", action: "ARIA_QUERY" },
  { text: "what should I do", action: "ARIA_QUERY" },
]

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${CONFIG.OLLAMA_URL.replace('/api/chat', '/api/embed')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: text }),
  })
  const data = await res.json() as { embeddings: number[][] }
  return data.embeddings[0]
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

let warmedUp = false

export async function warmupEmbeddings(): Promise<void> {
  if (warmedUp) return
  console.log('[EMBED] warming up...')
  for (const ex of EXAMPLES) {
    ex.embedding = await embed(ex.text)
  }
  warmedUp = true
  console.log(`[EMBED] ready — ${EXAMPLES.length} examples loaded`)
}

export async function matchEmbedding(
  transcript: string,
  threshold = 0.72
): Promise<{ action: string; score: number } | null> {
  if (!warmedUp) await warmupEmbeddings()

  const t0 = Date.now()
  const queryEmbed = await embed(transcript)

  let best: { action: string; score: number } | null = null

  for (const ex of EXAMPLES) {
    if (!ex.embedding) continue
    const score = cosine(queryEmbed, ex.embedding)
    if (score > (best?.score ?? 0)) {
      best = { action: ex.action, score }
    }
  }

  console.log(`[EMBED] ${Date.now() - t0}ms — best: "${best?.action}" @ ${best?.score.toFixed(3)}`)

  if (!best || best.score < threshold) return null
  return best
}