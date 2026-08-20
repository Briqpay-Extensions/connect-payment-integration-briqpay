import { describe, expect, it } from '@jest/globals'
import { BRIQPAY_USER_AGENT } from '../../../src/libs/briqpay/user-agent'

describe('BRIQPAY_USER_AGENT', () => {
  // The name and semver guard against template leftovers regressing into what Briqpay
  // uses to identify the plugin; the shape keeps it parseable on the Briqpay side.
  it('carries the plugin name, a semver version and the node runtime', () => {
    expect(BRIQPAY_USER_AGENT).toMatch(
      /^briqpay-commercetools-connector\/\d+\.\d+\.\d+(-beta\.\d+)? \(node\/\d+\.\d+\.\d+\)$/,
    )
  })
})
