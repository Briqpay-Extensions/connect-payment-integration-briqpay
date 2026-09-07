import { sha256Hex } from '../utils/content-hash'

/**
 * Briqpay itself puts no length limit on a cart line reference, but some PSPs
 * downstream reject anything 64 characters or longer, so the connector caps them
 * here. Merchant-authored values (SKU, key) and joined cart-discount ids can both
 * exceed that.
 *
 * The budget is counted in UTF-8 bytes, not UTF-16 code units: a 63-character
 * reference carrying accents or dashes is up to 68 bytes, so a character-based cap
 * would still overrun a PSP that measures bytes. Bytes are never fewer than
 * characters, so this satisfies either reading of the limit.
 */
const MAX_BYTES = 63
const HASH_LENGTH = 10
const HEAD_BYTES = MAX_BYTES - HASH_LENGTH - 1

/** Truncates to at most maxBytes of UTF-8, never leaving a split code point behind. */
const truncateUtf8 = (value: string, maxBytes: number): string => {
  const head = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8')

  // A cut mid-code-point decodes to trailing U+FFFD; drop it rather than ship it
  return head.replace(/\uFFFD+$/, '')
}

/**
 * Caps a cart line reference, keeping a head a merchant can still recognise and
 * appending a hash of the full original value. Pure and deterministic: session
 * create/update, capture and refund all rebuild their lines from the same cart and
 * must produce the same reference for the same line.
 */
export const boundCartLineReference = (reference: string): string => {
  if (Buffer.byteLength(reference, 'utf8') <= MAX_BYTES) {
    return reference
  }

  return `${truncateUtf8(reference, HEAD_BYTES)}-${sha256Hex(reference).slice(0, HASH_LENGTH)}`
}
