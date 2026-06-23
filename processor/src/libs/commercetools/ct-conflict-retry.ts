/**
 * Shared CommerceTools optimistic-concurrency helpers.
 *
 * Lives next to the apiRoot it wraps (api-root.ts / client.ts) because retrying a
 * 409 ConcurrentModification is a CT-client concern, not Briqpay business logic.
 */

// CT errors reach callers via two paths: ctPaymentService (wrapped in CommercetoolsAPIError,
// which exposes httpErrorStatus) and apiRoot/platform-sdk (raw, exposes statusCode). Both
// predicates accept either property so they can't be silently broken by an SDK upgrade or by
// a new caller that uses a different client.
export type CtErrorShape = {
  httpErrorStatus?: number
  statusCode?: number
  code?: string
  fields?: Array<{ code?: string; field?: string }>
}

const isConflict = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') {
    return false
  }

  const e: CtErrorShape = err

  return e.statusCode === 409 || e.httpErrorStatus === 409
}

const isNotFound = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') {
    return false
  }

  const e: CtErrorShape = err

  return e.statusCode === 404 || e.httpErrorStatus === 404
}

const DEFAULT_MAX_ATTEMPTS = 5

/**
 * Runs `run`, retrying on 409 ConcurrentModification with exponential backoff + jitter.
 *
 * `run` MUST re-fetch the resource (for a fresh version) and re-derive its actions on each
 * invocation — CT rejects a stale version with another 409, so replaying the same body never
 * converges. Non-409 errors and a final-attempt 409 propagate to the caller.
 */
const withConflictRetry = async <T>(run: () => Promise<T>, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): Promise<T> => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await run()
    } catch (err) {
      if (!isConflict(err) || attempt === maxAttempts - 1) {
        throw err
      }

      const jitterMs = Math.floor(Math.random() * 100)
      const delayMs = Math.min(100 * Math.pow(2, attempt) + jitterMs, 2000)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  // Unreachable: the loop either returns or throws on the final attempt. Present only to
  // satisfy the compiler's control-flow analysis for the Promise<T> return type.
  throw new Error('withConflictRetry exhausted without returning')
}

const CtConflictRetry = {
  isConflict,
  isNotFound,
  withConflictRetry,
}

export default CtConflictRetry
