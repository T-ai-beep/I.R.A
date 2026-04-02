import { CONFIG } from '../config.js'

interface Example {
  text: string
  action: string
  embedding?: number[]
}

const EXAMPLES: Example[] = [
  // price objections
  { text: "that's too expensive for us", action: "Anchor — ROI" },
  { text: "we can't afford that right now", action: "Anchor — ROI" },
  { text: "the price is way too high", action: "Anchor — ROI" },
  { text: "we don't have budget for this", action: "Anchor — ROI" },
  { text: "that's out of our price range", action: "Anchor — ROI" },
  { text: "that's a lot of money for us", action: "Anchor — ROI" },
  { text: "we're tight on budget right now", action: "Anchor — ROI" },
  { text: "can you do anything on the price", action: "Reject — hold price" },
  { text: "is there any flexibility there", action: "Reject — hold price" },
  { text: "can we get a discount", action: "Reject — hold price" },

  // stalling
  { text: "let me think about it", action: "Wait — silence" },
  { text: "i need more time to decide", action: "Wait — silence" },
  { text: "i'll get back to you", action: "Ask — what stops you" },
  { text: "we're not ready to move forward yet", action: "Ask — what changes" },
  { text: "maybe next quarter", action: "Ask — what changes" },

  // authority
  { text: "i need to check with my team", action: "Ask — who decides" },
  { text: "my boss has to approve this", action: "Ask — who decides" },
  { text: "i can't make this decision alone", action: "Ask — who decides" },
  { text: "let me run it by our CFO", action: "Ask — who decides" },
  { text: "i have to go over it with my manager", action: "Ask — who decides" },

  // competitor
  { text: "we already use servicetitan", action: "Challenge — whats missing" },
  { text: "we have a system in place", action: "Challenge — whats missing" },
  { text: "we're happy with our current solution", action: "Challenge — switching cost" },
  { text: "we use another platform for that", action: "Challenge — whats missing" },

  // agreement signals
  { text: "that sounds really good", action: "Push — close now" },
  { text: "i think we're interested", action: "Push — close now" },
  { text: "we'd like to move forward", action: "Accept — confirm terms" },
  { text: "i think we can make this work", action: "Push — close now" },

  // seller rambling
  { text: "and also we have this feature and that feature and you can do this and that", action: "Wait — let talk" },
  { text: "so basically what we do is we take your data and we process it and then we", action: "Wait — let talk" },
  { text: "let me explain everything we offer starting with the first module", action: "Wait — let talk" },

  // meeting
  { text: "i think the numbers show about 40 percent growth", action: "Challenge — source" },
  { text: "we should probably assign someone to own this", action: "Clarify — who owns" },
  { text: "let's table this and move on", action: "Anchor — revisit" },

  // interview
  { text: "what would you say is your biggest weakness", action: "Clarify — reframe growth" },
  { text: "what are your salary expectations", action: "Delay — their range" },
  { text: "tell me about yourself", action: "Anchor — lead impact" },

  // social
  { text: "so what do you do", action: "Anchor — your work" },
  { text: "i just feel like nobody really gets it", action: "Wait — let talk" },

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