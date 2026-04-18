/**
 * embedCache.ts
 * LRU cache for embedding vectors, keyed by transcript hash.
 *
 * Why: embedding (nomic-embed-text via Ollama) costs ~44ms warm.
 * Repeated/near-identical phrases hit this cache and pay 0ms.
 *
 * Strategy:
 *   key  = FNV-1a 32-bit hash of lowercased+trimmed transcript
 *   size = 256 entries (covers a full conversation many times over)
 *   eviction = LRU (Map insertion order + delete-on-access trick)
 */

const CACHE_SIZE = 256

// Map preserves insertion order; we delete+reinsert on hit to keep LRU order.
const cache = new Map<number, number[]>()

// ── FNV-1a 32-bit hash (no deps, <1μs) ───────────────────────────────────

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    // Multiply by FNV prime (32-bit safe via bitwise)
    h = (h * 0x01000193) >>> 0
  }
  return h
}

function cacheKey(transcript: string): number {
  return fnv1a(transcript.toLowerCase().trim())
}

// ── Public API ────────────────────────────────────────────────────────────

export function getCachedEmbed(transcript: string): number[] | null {
  const k = cacheKey(transcript)
  const hit = cache.get(k)
  if (!hit) return null

  // Move to tail (most-recently-used) by delete+reinsert
  cache.delete(k)
  cache.set(k, hit)
  return hit
}

export function setCachedEmbed(transcript: string, embedding: number[]): void {
  const k = cacheKey(transcript)

  // Evict LRU (first entry) if at capacity
  if (cache.size >= CACHE_SIZE && !cache.has(k)) {
    const lruKey = cache.keys().next().value
    if (lruKey !== undefined) cache.delete(lruKey)
  }

  cache.delete(k)     // remove old entry if present (to update LRU position)
  cache.set(k, embedding)
}

export function getCacheStats(): { size: number; capacity: number } {
  return { size: cache.size, capacity: CACHE_SIZE }
}

export function clearEmbedCache(): void {
  cache.clear()
}