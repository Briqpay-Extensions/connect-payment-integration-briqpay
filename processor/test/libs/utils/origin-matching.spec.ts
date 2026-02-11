import { matchOriginPattern } from '../../../src/libs/utils/origin-matching'

describe('matchOriginPattern', () => {
  describe('exact match', () => {
    it('should match identical origins', () => {
      expect(matchOriginPattern('https://example.com', 'https://example.com')).toBe(true)
    })

    it('should not match different origins without wildcard', () => {
      expect(matchOriginPattern('https://example.com', 'https://other.com')).toBe(false)
    })
  })

  describe('wildcard matching', () => {
    it('should match a single subdomain with wildcard', () => {
      expect(matchOriginPattern('https://*.example.com', 'https://app.example.com')).toBe(true)
    })

    it('should match a hyphenated subdomain with wildcard', () => {
      expect(matchOriginPattern('https://*.example.com', 'https://my-app.example.com')).toBe(true)
    })

    it('should match numeric subdomains with wildcard', () => {
      expect(matchOriginPattern('https://*.example.com', 'https://pr123.example.com')).toBe(true)
    })

    it('should not match nested subdomains (only single segment)', () => {
      expect(matchOriginPattern('https://*.example.com', 'https://a.b.example.com')).toBe(false)
    })

    it('should not match the bare domain against a wildcard pattern', () => {
      expect(matchOriginPattern('https://*.example.com', 'https://example.com')).toBe(false)
    })
  })

  describe('scheme enforcement', () => {
    it('should not match when schemes differ (http vs https)', () => {
      expect(matchOriginPattern('https://*.example.com', 'http://app.example.com')).toBe(false)
    })

    it('should not match https origin against http wildcard pattern', () => {
      expect(matchOriginPattern('http://*.example.com', 'https://app.example.com')).toBe(false)
    })
  })

  describe('invalid inputs', () => {
    it('should return false for pattern without scheme', () => {
      expect(matchOriginPattern('*.example.com', 'https://app.example.com')).toBe(false)
    })

    it('should return false for invalid origin URL', () => {
      expect(matchOriginPattern('https://*.example.com', 'not-a-url')).toBe(false)
    })
  })
})
