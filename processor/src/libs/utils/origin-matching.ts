/**
 * Matches an origin against a pattern that may contain a wildcard (*).
 * Supports patterns like:
 *   - `https://example.com` (exact match)
 *   - `https://*.example.com` (wildcard subdomain match)
 *
 * SECURITY: Only a single `*` is supported and it must appear in the hostname
 * portion of the URL. The scheme (protocol) must always match exactly.
 */
export function matchOriginPattern(pattern: string, origin: string): boolean {
  // Exact match fast path
  if (pattern === origin) {
    return true
  }

  // Only process wildcard patterns
  if (!pattern.includes('*')) {
    return false
  }

  try {
    const originUrl = new URL(origin)

    // Split pattern into scheme and rest (e.g. "https://" + "*.example.com")
    const schemeEnd = pattern.indexOf('://')
    if (schemeEnd === -1) {
      return false
    }
    const patternScheme = pattern.slice(0, schemeEnd + 3)
    const patternHost = pattern.slice(schemeEnd + 3)

    // Scheme must match exactly
    if (!origin.startsWith(patternScheme)) {
      return false
    }

    // Convert the wildcard host pattern to a regex
    // Escape dots, replace * with a regex group that matches one or more subdomain segments
    const regexStr =
      '^' + patternHost.replace(/\./g, '\\.').replace(/\*/g, '[a-zA-Z0-9]([a-zA-Z0-9\\-]*[a-zA-Z0-9])?') + '$'

    const regex = new RegExp(regexStr)
    return regex.test(originUrl.host)
  } catch {
    return false
  }
}
