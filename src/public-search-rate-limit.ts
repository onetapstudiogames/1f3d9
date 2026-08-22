export const PUBLIC_SEARCH_RATE_CAPACITY = 12
export const PUBLIC_SEARCH_TOKEN_REFILL_MS = 5_000
const PUBLIC_SEARCH_RATE_BUCKET_MAX = 2_048

interface SearchRateBucket {
  readonly tokens: number
  readonly updatedAt: number
}

export interface PublicSearchRateAdmission {
  readonly allowed: boolean
  readonly retryAfterSeconds: number
}

let buckets: ReadonlyMap<string, SearchRateBucket> = new Map()

function nextBuckets(callerKey: string, bucket: SearchRateBucket, now: number) {
  const fullyRefilledBefore = now - PUBLIC_SEARCH_RATE_CAPACITY * PUBLIC_SEARCH_TOKEN_REFILL_MS
  const entries = [...buckets.entries()]
    .filter(([key, value]) => key !== callerKey && value.updatedAt > fullyRefilledBefore)
  const newest = [...entries, [callerKey, bucket] as const]
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    .slice(-PUBLIC_SEARCH_RATE_BUCKET_MAX)
  return new Map(newest)
}

/**
 * A process-local, memory-capped fairness guard. Keys are caller hashes; no
 * address, query, result, or durable reading history is retained.
 */
export function takePublicSearchToken(
  callerKey: string,
  now = Date.now(),
): PublicSearchRateAdmission {
  const current = buckets.get(callerKey)
  const elapsed = current ? Math.max(0, now - current.updatedAt) : 0
  const available = current
    ? Math.min(PUBLIC_SEARCH_RATE_CAPACITY, current.tokens + elapsed / PUBLIC_SEARCH_TOKEN_REFILL_MS)
    : PUBLIC_SEARCH_RATE_CAPACITY
  const allowed = available >= 1
  const tokens = allowed ? available - 1 : available
  const updatedAt = current ? Math.max(now, current.updatedAt) : now
  buckets = nextBuckets(callerKey, Object.freeze({ tokens, updatedAt }), now)
  return Object.freeze({
    allowed,
    retryAfterSeconds: allowed
      ? 0
      : Math.max(1, Math.ceil((1 - available) * PUBLIC_SEARCH_TOKEN_REFILL_MS / 1_000)),
  })
}
