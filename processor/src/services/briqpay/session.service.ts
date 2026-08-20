import { Cart, CommercetoolsCartService } from '@commercetools/connect-payments-sdk'
import { PaymentAmount } from '@commercetools/connect-payments-sdk/dist/commercetools/types/payment.type'
import { appLogger } from '../../payment-sdk'

import { MediumBriqpayResponse } from '../types/briqpay-payment.type'
import Briqpay from '../../libs/briqpay/BriqpayService'
import { briqpaySessionAmountsEqual, readBriqpaySessionAmounts } from '../../libs/briqpay/session-amounts'
import { apiRoot } from '../../libs/commercetools/api-root'
import {
  SessionAlreadyCompletedError,
  SessionInitializationPendingError,
  SessionNotFoundError,
} from '../../libs/errors/briqpay-errors'
import CtConflictRetry from '../../libs/commercetools/ct-conflict-retry'
import { getBriqpayTypeKey } from '../../connectors/actions'
import {
  briqpayCheckoutTransactionItemIdFieldName,
  briqpayFutureOrderNumberFieldName,
  briqpaySessionIdFieldName,
  briqpaySyncedPayloadHashFieldName,
} from '../../custom-types/custom-types'

type CTSetCustomFieldAction = { action: 'setCustomField'; name: string; value: string }

const CT_CART_WRITE_MAX_ATTEMPTS = 8

export type ResolvedBriqpaySession = {
  session: MediumBriqpayResponse
  /** Only set when Briqpay accepted this cart data. Undefined leaves whatever the cart already stores. */
  syncedPayloadHash?: string
}

export type CTCartBriqpayMetadata = {
  briqpaySessionId: string
  futureOrderNumber?: string
  checkoutTransactionItemId?: string
  syncedPayloadHash?: string
}

export class BriqpaySessionService {
  constructor(private readonly ctCartService: CommercetoolsCartService) {}

  /**
   * Writes the Briqpay session metadata onto the cart's custom fields.
   *
   * `briqpay-future-order-number` is write-once. The merchant backend reads it back on
   * later checkout entries, which is what keeps Briqpay's reference1 aligned with the
   * eventual Order.orderNumber, so the value from the first entry has to survive.
   *
   * Conflict-retried because the cart is contended: CT Checkout and the storefront write
   * to it while /config runs, so the caller's snapshot - taken before the slow Briqpay
   * calls - is usually stale by now (409, then 500, then no widget). Each attempt
   * re-fetches and re-derives, so a concurrent writer that already stored these values
   * makes the retry a no-op.
   */
  public async updateCTCartWithBriqpaySession(ctCart: Cart, metadata: CTCartBriqpayMetadata): Promise<void> {
    // Read before the write, and only used to tell our own session from a replacement.
    const snapshotSessionId = ctCart.custom?.fields?.[briqpaySessionIdFieldName]

    // Nothing to write is the normal case on a widget reload; skip the round trips.
    const alreadyInSync = ctCart.custom !== undefined && this.buildCTCartMetadataActions(ctCart, metadata).length === 0

    if (alreadyInSync) {
      return
    }

    const runUpdate = async (dropSyncedPayloadHash: boolean): Promise<void> => {
      const cart = await this.ctCartService.getCart({ id: ctCart.id })

      const versionForUpdate = cart.custom
        ? cart.version
        : await this.setBriqpayCustomTypeOnCTCart(cart, metadata.briqpaySessionId)

      // Actions are re-derived per attempt against the fresh cart. The hash is not: it was
      // computed from the payload that was actually sent, so recomputing it here would
      // describe a payload nobody sent.
      const actions = this.buildCTCartMetadataActions(cart, metadata).filter(
        (action) => !dropSyncedPayloadHash || action.name !== briqpaySyncedPayloadHashFieldName,
      )

      if (actions.length === 0) {
        return
      }

      appLogger.info(
        {
          briqpaySessionId: metadata.briqpaySessionId,
          persistedFutureOrderNumber: actions.some((a) => a.name === briqpayFutureOrderNumberFieldName)
            ? metadata.futureOrderNumber
            : undefined,
          actionNames: actions.map((a) => a.name),
        },
        'Updating cart custom fields with Briqpay session metadata',
      )

      await apiRoot
        .carts()
        .withId({ ID: cart.id })
        .post({
          body: {
            version: versionForUpdate,
            actions,
          },
        })
        .execute()
    }

    try {
      // The default 5 attempts (~1.5s) measurably ran out under real checkout load, which
      // brought back the 409 -> 500 this retry exists to prevent. 8 buys ~7s.
      await CtConflictRetry.withConflictRetry(() => runUpdate(false), CT_CART_WRITE_MAX_ATTEMPTS)
    } catch (error) {
      await this.recoverFromCTCartWriteFailure(error, ctCart, metadata, snapshotSessionId, runUpdate)
    }
  }

  /**
   * A buyer who pays while /config is still running turns the cart into an Order, which
   * is immutable (400 InvalidOperation). The write is moot at that point and must not
   * stop the widget rendering for the session they just paid - webhook ingestion
   * enriches the Order instead.
   *
   * But CT answers 400 InvalidOperation for permanent misconfigurations too (missing
   * type key, field not on the type), so the code alone proves nothing. Hence the
   * Ordered probe, and hence Frozen/Merged carts and 404s still throw.
   *
   * It also has to be the buyer's own session. A different id on an ordered cart is a
   * session minted after they finished paying, and rendering its widget could charge
   * them twice.
   */
  private async recoverFromCTCartWriteFailure(
    error: unknown,
    ctCart: Cart,
    metadata: CTCartBriqpayMetadata,
    snapshotSessionId: unknown,
    runUpdate: (dropSyncedPayloadHash: boolean) => Promise<void>,
  ): Promise<void> {
    const wroteBuyersOwnSession = !snapshotSessionId || snapshotSessionId === metadata.briqpaySessionId
    const invalidOperation = CtConflictRetry.isInvalidOperation(error)
    const cartOrderedDuringUpdate =
      wroteBuyersOwnSession && invalidOperation && (await this.hasCTCartBeenOrdered(ctCart.id))

    if (cartOrderedDuringUpdate) {
      appLogger.info(
        {
          cartId: ctCart.id,
          briqpaySessionId: metadata.briqpaySessionId,
          error: error instanceof Error ? error.message : error,
        },
        'Cart no longer writable (ordered), skipping Briqpay session metadata write',
      )

      return
    }

    // A new connector version serves traffic before post-deploy adds the hash field to
    // the CT type, and writing a field the type does not define is a 400. Dropping it and
    // retrying keeps checkout up, since the field only ever saves a redundant update.
    if (!invalidOperation || metadata.syncedPayloadHash === undefined) {
      throw error
    }

    appLogger.warn(
      {
        cartId: ctCart.id,
        field: briqpaySyncedPayloadHashFieldName,
        error: error instanceof Error ? error.message : error,
      },
      'Cart write rejected; retrying without the synced-payload-hash field. Run the connector post-deploy to add it to the cart custom type.',
    )

    await CtConflictRetry.withConflictRetry(() => runUpdate(true), CT_CART_WRITE_MAX_ATTEMPTS)
  }

  /**
   * Attaches the Briqpay custom type to a cart that has none. Returns the version that
   * update produced, which the field write immediately after has to use.
   */
  private async setBriqpayCustomTypeOnCTCart(cart: Cart, briqpaySessionId: string): Promise<number> {
    // Not necessarily the field name - the connector may have extended an existing type.
    const typeKey = await getBriqpayTypeKey()
    appLogger.info({ briqpaySessionId, typeKey }, 'Setting custom type for cart')
    const cartResponse = await apiRoot
      .carts()
      .withId({ ID: cart.id })
      .post({
        body: {
          version: cart.version,
          actions: [
            {
              action: 'setCustomType',
              type: {
                key: typeKey,
                typeId: 'type',
              },
            },
          ],
        },
      })
      .execute()

    return cartResponse.body.version
  }

  /**
   * Only changed values produce actions, which is what lets a retry against a fresh cart
   * come back empty when a concurrent writer already stored the same metadata.
   */
  private buildCTCartMetadataActions(cart: Cart, metadata: CTCartBriqpayMetadata): CTSetCustomFieldAction[] {
    const existingBriqpaySessionId = cart.custom?.fields?.[briqpaySessionIdFieldName]
    const existingFutureOrderNumber = cart.custom?.fields?.[briqpayFutureOrderNumberFieldName]
    const existingCheckoutTransactionItemId = cart.custom?.fields?.[briqpayCheckoutTransactionItemIdFieldName]
    const existingSyncedPayloadHash = cart.custom?.fields?.[briqpaySyncedPayloadHashFieldName]

    const actions: CTSetCustomFieldAction[] = []

    if (existingBriqpaySessionId !== metadata.briqpaySessionId) {
      actions.push({
        action: 'setCustomField',
        name: briqpaySessionIdFieldName,
        value: metadata.briqpaySessionId,
      })
    }

    if (metadata.futureOrderNumber && !existingFutureOrderNumber) {
      actions.push({
        action: 'setCustomField',
        name: briqpayFutureOrderNumberFieldName,
        value: metadata.futureOrderNumber,
      })
    }

    // Deliberately not write-once: this has to point at the live Checkout session, because
    // it is what the webhook fallback links its Payment to. A leftover id from an abandoned
    // entry links to nothing and blocks Order creation.
    if (
      metadata.checkoutTransactionItemId &&
      existingCheckoutTransactionItemId !== metadata.checkoutTransactionItemId
    ) {
      actions.push({
        action: 'setCustomField',
        name: briqpayCheckoutTransactionItemIdFieldName,
        value: metadata.checkoutTransactionItemId,
      })
    }

    // Undefined means leave it alone, not clear it. Callers whose update never reached
    // Briqpay pass nothing, and clearing would then claim a match that does not exist.
    if (metadata.syncedPayloadHash !== undefined && existingSyncedPayloadHash !== metadata.syncedPayloadHash) {
      actions.push({
        action: 'setCustomField',
        name: briqpaySyncedPayloadHashFieldName,
        value: metadata.syncedPayloadHash,
      })
    }

    return actions
  }

  /**
   * Ordered is the one cart state where dropping the metadata write is safe. Anything else,
   * including a failed probe, returns false so the caller's error surfaces rather than
   * being swallowed on a guess.
   */
  private async hasCTCartBeenOrdered(cartId: string): Promise<boolean> {
    try {
      const cart = await this.ctCartService.getCart({ id: cartId })

      return cart.cartState === 'Ordered'
    } catch {
      return false
    }
  }

  /**
   * Returns the session this cart should check out with, and a snippet that can render.
   *
   * The cart stores a hash of what was last sent to Briqpay, so this can pick the one
   * call each case needs instead of always doing two:
   *
   *   no session yet      create
   *   hash matches        get    (the snippet has to be fetched regardless, and this
   *                              response also refreshes the client token)
   *   hash differs        update (its response carries a snippet too)
   *
   * The hash is only a hint - the fetched session always gets the final say.
   *
   * Recovery follows what Briqpay reports:
   *
   *   session is gone         create a replacement. Retention only ever deletes sessions
   *                           that never completed, so nothing paid can be lost this way.
   *   already completed       return it as-is. Replacing it could charge the buyer twice,
   *                           since it may hold a live authorization.
   *   still initializing      return it as-is so the widget renders.
   *
   * Everything else throws.
   */
  public async resolveBriqpaySession(
    ctCart: Cart,
    amountPlanned: PaymentAmount,
    hostname: string,
    futureOrderNumber?: string,
  ): Promise<ResolvedBriqpaySession> {
    const existingSessionId = ctCart.custom?.fields?.[briqpaySessionIdFieldName]

    if (typeof existingSessionId !== 'string' || !existingSessionId) {
      return this.createBriqpaySession(ctCart, amountPlanned, hostname, futureOrderNumber)
    }

    const update = await Briqpay.buildSessionUpdateRequest(ctCart, amountPlanned)
    const storedHash = ctCart.custom?.fields?.[briqpaySyncedPayloadHashFieldName]
    // Type-guarded so a merchant who declared this field as something other than a String
    // falls back to always updating rather than throwing.
    const inSync = typeof storedHash === 'string' && storedHash === update.hash

    try {
      if (inSync) {
        const session = await Briqpay.getSession(existingSessionId)

        // Racing /config calls can leave the stored hash wrong, so the fetched
        // session decides - never the hash alone.
        if (briqpaySessionAmountsEqual(session, update.amounts)) {
          appLogger.info({ existingSessionId }, 'Briqpay session already matches the cart, reusing it')

          const resolved: ResolvedBriqpaySession = {
            session,
            syncedPayloadHash: update.hash,
          }

          return resolved
        }

        appLogger.error(
          {
            sessionId: existingSessionId,
            expected: update.amounts,
            actual: readBriqpaySessionAmounts(session),
          },
          'Stored hash matches the cart but the session amounts do not - updating the session',
        )
      }

      appLogger.info({ existingSessionId, inSync }, 'Updating Briqpay session with new cart data')
      const session = await Briqpay.updateSession(existingSessionId, update)

      const resolved: ResolvedBriqpaySession = {
        session,
        syncedPayloadHash: update.hash,
      }

      return resolved
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        appLogger.warn(
          { existingSessionId, error },
          'Briqpay session on cart no longer exists upstream, creating a replacement',
        )

        return this.createBriqpaySession(ctCart, amountPlanned, hostname, futureOrderNumber)
      }

      if (error instanceof SessionAlreadyCompletedError) {
        appLogger.warn(
          { existingSessionId },
          'Briqpay session is already completed, returning it untouched without updating it',
        )

        const resolved: ResolvedBriqpaySession = {
          session: await Briqpay.getSession(existingSessionId),
        }

        return resolved
      }

      if (error instanceof SessionInitializationPendingError) {
        appLogger.warn({ existingSessionId }, 'Briqpay session is still initializing, returning it without updating')

        const resolved: ResolvedBriqpaySession = {
          session: await Briqpay.getSession(existingSessionId),
        }

        return resolved
      }

      throw error
    }
  }

  /**
   * Pushes the cart into an existing session, for callers repairing one outside /config.
   *
   * Recording the hash matters as much as the update itself: leaving the old one in place
   * would let the next /config believe the session still matches the cart, and skip.
   */
  public async syncCTCartToBriqpaySession(
    ctCart: Cart,
    sessionId: string,
    amountPlanned: PaymentAmount,
  ): Promise<void> {
    const update = await Briqpay.buildSessionUpdateRequest(ctCart, amountPlanned)
    await Briqpay.updateSession(sessionId, update)

    await this.updateCTCartWithBriqpaySession(ctCart, {
      briqpaySessionId: sessionId,
      syncedPayloadHash: update.hash,
    })
  }

  private createBriqpaySession(
    ctCart: Cart,
    amountPlanned: PaymentAmount,
    hostname: string,
    futureOrderNumber?: string,
  ): Promise<ResolvedBriqpaySession> {
    appLogger.info({ cartId: ctCart.id }, 'Creating a new Briqpay session')

    return Briqpay.createSession(ctCart, amountPlanned, hostname, futureOrderNumber)
  }
}
