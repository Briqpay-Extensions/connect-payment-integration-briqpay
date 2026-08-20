import { Address, Cart, CustomLineItem, LineItem } from '@commercetools/platform-sdk'
import { apiRoot } from '../commercetools/api-root'
import { BriqpayDecisionRequest, PaymentOutcome } from '../../dtos/briqpay-payment.dto'
import {
  CartItem,
  CreateSessionRequestBody,
  CUSTOMER_TYPE,
  EVENT_HOOK,
  Hooks,
  IAddressSchema,
  ITEM_PRODUCT_TYPE,
  MediumBriqpayResponse,
  MODULE_TYPE,
  ORDER_STATUS,
  PAYMENT_TOOLS_PRODUCT,
  RegularCartItem,
  SESSION_INTENT,
  TRANSACTION_STATUS,
} from '../../services/types/briqpay-payment.type'
import { Money } from '@commercetools/connect-payments-sdk'
import { PaymentAmount } from '@commercetools/connect-payments-sdk/dist/commercetools/types/payment.type'
import { appLogger } from '../../payment-sdk'
import { briqpayVariantIdFieldName } from '../../custom-types/custom-types'
import { mapBriqpaySessionError } from './session-error-mapping'
import { BriqpayOrderAmounts } from './session-amounts'
import { sha256Hex } from '../utils/content-hash'
import { BRIQPAY_USER_AGENT } from './user-agent'

/** The `data` subtree shared by the create and update payloads. */
export type BriqpaySessionData = {
  order: { currency: string; amountIncVat: number; amountExVat: number; cart: CartItem[] }
  billing?: IAddressSchema
  shipping?: IAddressSchema
}

export type BriqpaySessionUpdateRequest = {
  readonly body: string
  readonly hash: string
  readonly amounts: BriqpayOrderAmounts
}

export type CreatedBriqpaySession = {
  session: MediumBriqpayResponse
  syncedPayloadHash: string
}

/**
 * Briqpay returns the HTML snippet as `snippet` on some responses and `htmlSnippet`
 * on others. Normalize both the GET and PATCH bodies through here so callers only
 * ever read `htmlSnippet`.
 */
const normalizeSessionResponse = (json: MediumBriqpayResponse, sessionId: string): MediumBriqpayResponse => {
  const raw = json as MediumBriqpayResponse & { snippet?: string }
  if (!raw.htmlSnippet && raw.snippet) {
    raw.htmlSnippet = raw.snippet
  }

  if (!raw?.sessionId) {
    throw new Error(`Invalid Briqpay session response for ${sessionId}: missing sessionId`)
  }

  return raw
}

const mapBriqpayProductType = (item: LineItem) => {
  // Check if the product has a digital-related attribute
  if (item.variant?.attributes) {
    const isDigitalAttr = item.variant.attributes.find((attr) => attr?.name === 'isDigital')
    if (isDigitalAttr?.value === 'true') return ITEM_PRODUCT_TYPE.DIGITAL
  }

  // Check product type (if your setup has a digital category)
  if (item.productType?.id?.toLowerCase().includes('digital')) return ITEM_PRODUCT_TYPE.DIGITAL

  // Default to physical
  return ITEM_PRODUCT_TYPE.PHYSICAL
}

const getLocalizedName = (item: LineItem | CustomLineItem, locale: string): string => {
  const nameRecord = item.name as Record<string, string> | undefined
  if (nameRecord) {
    const localizedName = nameRecord[locale] || nameRecord['en'] || Object.values(nameRecord)[0]
    if (localizedName) return localizedName
  }
  if ('slug' in item) {
    return item.slug || 'Item'
  }
  return item.productKey ?? item.productId ?? 'Item'
}

const createDiscountLineItem = (item: LineItem, localeName: string, taxRate: number): RegularCartItem => {
  const quantity = item.quantity
  const grossUnit = item.price.value.centAmount
  const netUnit = item.taxedPrice?.totalNet
    ? Math.round(item.taxedPrice.totalNet.centAmount / quantity)
    : Math.round(grossUnit / (1 + (item.taxRate?.amount ?? 0)))

  const discountLineItem: RegularCartItem = {
    productType: ITEM_PRODUCT_TYPE.DISCOUNT,
    reference: item.key ?? localeName,
    name: localeName,
    quantity,
    quantityUnit: 'pc',
    unitPrice: netUnit,
    unitPriceIncVat: grossUnit,
    discountPercentage: 0,
    taxRate,
    totalAmount: item.taxedPrice?.totalGross?.centAmount ?? grossUnit * quantity,
    totalVatAmount: item.taxedPrice?.totalTax?.centAmount ?? 0,
    imageUrl: item.variant?.images?.[0]?.url,
  }

  return discountLineItem
}

/**
 * Creates a regular line item using ORIGINAL prices (before any discounts).
 * Discounts are handled as separate discount line items to avoid percentage calculation issues.
 */
const createRegularLineItem = (item: LineItem, localeName: string, taxRate: number): RegularCartItem => {
  const quantity = item.quantity
  const taxRateAmount = item.taxRate?.amount ?? 0

  // Use ORIGINAL price (before discounts) for the line item
  const originalUnitGross = item.price.value.centAmount
  const originalGrossTotal = originalUnitGross * quantity
  const originalNetTotal = Math.round(originalGrossTotal / (1 + taxRateAmount))
  const originalVatTotal = originalGrossTotal - originalNetTotal

  const regularLineItem: RegularCartItem = {
    productType: mapBriqpayProductType(item),
    reference: item.variant?.sku ?? localeName,
    name: localeName,
    quantity,
    quantityUnit: 'pc',
    unitPrice: Math.round(originalNetTotal / quantity),
    unitPriceIncVat: originalUnitGross,
    taxRate,
    discountPercentage: 0, // No percentage - discounts are separate line items
    totalAmount: originalGrossTotal,
    totalVatAmount: originalVatTotal,
    imageUrl: item.variant?.images?.[0]?.url,
  }

  return regularLineItem
}

/**
 * Fetches Cart Discount names from CommerceTools by their IDs.
 * Returns a map of discount ID to localized name.
 */
const fetchCartDiscountNames = async (discountIds: string[], locale: string): Promise<Map<string, string>> => {
  const nameMap = new Map<string, string>()

  if (discountIds.length === 0) {
    return nameMap
  }

  try {
    // Fetch all cart discounts in one query using "in" predicate
    const response = await apiRoot
      .cartDiscounts()
      .get({
        queryArgs: {
          where: `id in (${discountIds.map((id) => `"${id}"`).join(', ')})`,
          limit: discountIds.length,
        },
      })
      .execute()

    for (const cartDiscount of response.body.results) {
      // Get localized name, fallback to 'en' or first available
      const name =
        cartDiscount.name[locale] ||
        cartDiscount.name['en'] ||
        cartDiscount.name['en-GB'] ||
        Object.values(cartDiscount.name)[0] ||
        cartDiscount.key ||
        'Discount'
      nameMap.set(cartDiscount.id, name)
    }
  } catch (error) {
    appLogger.error({ error, discountIds }, 'Failed to fetch cart discount names, using fallback')
  }

  return nameMap
}

/**
 * Creates a discount line item for per-item discounts (discountedPricePerQuantity).
 * Returns null if there's no discount on this item.
 * Uses the exact discount amount from CommerceTools to avoid percentage rounding issues.
 */
const createItemDiscountLineItem = (
  item: LineItem,
  localeName: string,
  taxRate: number,
  discountNameMap: Map<string, string>,
): RegularCartItem | null => {
  // Check if item has per-quantity discounts
  if (!item.discountedPricePerQuantity?.length) {
    return null
  }

  const quantity = item.quantity
  const taxRateAmount = item.taxRate?.amount ?? 0

  // Calculate original total (before discount)
  const originalUnitGross = item.price.value.centAmount
  const originalGrossTotal = originalUnitGross * quantity

  // Get actual discounted total from CommerceTools (what customer actually pays)
  const actualGrossTotal = item.taxedPrice?.totalGross?.centAmount ?? originalGrossTotal

  // Calculate the discount amount (difference between original and actual)
  const discountGrossAmount = originalGrossTotal - actualGrossTotal

  // No discount if amounts are equal
  if (discountGrossAmount <= 0) {
    return null
  }

  // Calculate net and VAT for the discount amount
  const discountNetAmount = Math.round(discountGrossAmount / (1 + taxRateAmount))
  const discountVatAmount = discountGrossAmount - discountNetAmount

  // Get unique discount IDs from this item
  const discountIds = item.discountedPricePerQuantity
    .flatMap((dpq) => dpq.discountedPrice.includedDiscounts)
    .map((d) => d.discount.id)
    .filter((id, index, arr) => arr.indexOf(id) === index) // unique

  // Build discount reference
  const discountReference =
    discountIds.length > 0 ? `discount-${discountIds.join('-')}` : `discount-${item.key ?? localeName}`

  // Build discount name from Cart Discount names, fallback to product name
  const discountNames = discountIds.map((id) => discountNameMap.get(id)).filter((name): name is string => !!name)
  const discountName = discountNames.length > 0 ? discountNames.join(' + ') : `Discount: ${localeName}`

  const itemDiscountLineItem: RegularCartItem = {
    productType: ITEM_PRODUCT_TYPE.DISCOUNT,
    reference: discountReference,
    name: discountName,
    quantity: 1, // Discount is always quantity 1 with total amount
    quantityUnit: 'pc',
    unitPrice: -discountNetAmount, // Negative for discount
    unitPriceIncVat: -discountGrossAmount, // Negative for discount
    taxRate,
    discountPercentage: 0,
    totalAmount: -discountGrossAmount, // Negative for discount
    totalVatAmount: -discountVatAmount, // Negative for discount
    imageUrl: undefined,
  }

  return itemDiscountLineItem
}

/**
 * Collects all unique discount IDs from line items.
 */
const collectDiscountIds = (lineItems: LineItem[]): string[] => {
  const discountIds = lineItems.flatMap((item) =>
    (item.discountedPricePerQuantity ?? []).flatMap((dpq) =>
      dpq.discountedPrice.includedDiscounts.map((d) => d.discount.id),
    ),
  )
  return [...new Set(discountIds)]
}

/**
 * Maps a single line item to cart items (main item + optional discount line).
 */
const mapSingleLineItem = (
  item: LineItem,
  fallbackLocale: string,
  discountNameMap: Map<string, string>,
): CartItem[] => {
  const localeName = getLocalizedName(item, fallbackLocale)
  const taxRate = Math.round((item.taxRate?.amount ?? 0) * 10000)
  const isDiscountLine = item.lineItemMode === 'GiftCard' || item.priceMode === 'Discounted'

  const cartItem = isDiscountLine
    ? createDiscountLineItem(item, localeName, taxRate)
    : createRegularLineItem(item, localeName, taxRate)

  appLogger.info(
    {
      ...cartItem,
      originalUnitGross: item.price.value.centAmount,
      hasDiscountedPrice: !!item.price.discounted,
      hasDiscountedPricePerQuantity: (item.discountedPricePerQuantity?.length ?? 0) > 0,
      taxedPrice: item.taxedPrice,
    },
    isDiscountLine ? 'Created discount line item:' : 'Created regular line item:',
  )

  const result: CartItem[] = [cartItem]

  if (!isDiscountLine) {
    const itemDiscountLine = createItemDiscountLineItem(item, localeName, taxRate, discountNameMap)
    if (itemDiscountLine) {
      appLogger.info(
        {
          ...itemDiscountLine,
          forItem: localeName,
          originalGross: item.price.value.centAmount * item.quantity,
          actualGross: item.taxedPrice?.totalGross?.centAmount,
        },
        'Created per-item discount line:',
      )
      result.push(itemDiscountLine)
    }
  }

  return result
}

/**
 * Maps a CT custom line item (ad-hoc priced item not backed by a catalog product,
 * e.g. fees, gift wrapping, store credit) to a Briqpay cart item.
 *
 * Uses the ACTUAL taxed amounts (not original-price + discount-line like regular
 * items) since custom line items carry their own price and CT already bakes any
 * discounts into taxedPrice/totalPrice.
 */
const mapCustomLineItem = (item: CustomLineItem, locale: string | undefined): RegularCartItem => {
  const fallbackLocale = locale || 'en-GB'
  const localeName = getLocalizedName(item, fallbackLocale)
  const quantity = item.quantity
  const taxRateAmount = item.taxRate?.amount ?? 0

  const grossTotal = item.taxedPrice?.totalGross?.centAmount ?? item.totalPrice.centAmount
  const netTotal = item.taxedPrice?.totalNet?.centAmount ?? Math.round(grossTotal / (1 + taxRateAmount))
  const vatTotal = item.taxedPrice?.totalTax?.centAmount ?? grossTotal - netTotal

  // Merchants use negative custom line items for manual discounts/store credit;
  // those must be sent as discount lines, not negative-priced products.
  const productType = grossTotal < 0 ? ITEM_PRODUCT_TYPE.DISCOUNT : ITEM_PRODUCT_TYPE.PHYSICAL

  const customCartItem: RegularCartItem = {
    productType,
    reference: item.key || item.slug || item.id,
    name: localeName,
    quantity,
    quantityUnit: 'pc',
    unitPrice: Math.round(netTotal / quantity),
    // Derived from gross actuals, NOT item.money: money is the pre-discount list
    // price and is NET when taxRate.includedInPrice is false (US/B2B carts)
    unitPriceIncVat: Math.round(grossTotal / quantity),
    taxRate: Math.round(taxRateAmount * 10000),
    discountPercentage: 0,
    totalAmount: grossTotal,
    totalVatAmount: vatTotal,
    imageUrl: undefined,
  }

  return customCartItem
}

const mapBriqpayCartItem = (
  lineItems: LineItem[],
  customLineItems: CustomLineItem[],
  locale: string | undefined,
  discountNameMap: Map<string, string>,
): CartItem[] => {
  const fallbackLocale = locale || 'en-GB'

  const mappedItems = lineItems.flatMap((item) => mapSingleLineItem(item, fallbackLocale, discountNameMap))
  const mappedCustomItems = customLineItems.map((item) => mapCustomLineItem(item, locale))
  const allItems = [...mappedItems, ...mappedCustomItems]

  appLogger.info(allItems, 'Final mapped items:')
  return allItems
}

/** Discount ids referenced by the cart total, distinct from the per-line-item ones. */
const collectTotalDiscountIds = (cart: Cart): string[] =>
  cart.discountOnTotalPrice?.includedDiscounts?.map((d) => d.discount.id).filter((id) => !!id) ?? []

/**
 * Resolves display names for every discount the cart references, per-item and total,
 * in ONE lookup. Two separate fetches gave two independent chances to degrade
 * differently, since fetchCartDiscountNames swallows its own errors.
 */
const fetchDiscountNamesForCart = async (cart: Cart): Promise<Map<string, string>> => {
  const discountIds = [...new Set([...collectDiscountIds(cart.lineItems), ...collectTotalDiscountIds(cart)])]
  const discountNameMap = await fetchCartDiscountNames(discountIds, cart.locale || 'en-GB')

  appLogger.info({ discountIds, discountNameMap: Object.fromEntries(discountNameMap) }, 'Fetched cart discount names:')

  return discountNameMap
}

const mapBriqpayAddress = (address: Address): IAddressSchema => ({
  companyName: address.company,
  streetAddress: address.streetName,
  streetAddress2: address.additionalStreetInfo,
  zip: address.postalCode,
  city: address.city,
  region: address.region,
  firstName: address.firstName,
  lastName: address.lastName,
  email: address.email,
  phoneNumber: address.phone,
  country: address.country,
})

class BriqpayService {
  private username: string
  private secret: string
  private baseUrl: string

  constructor(username: string, secret: string, baseUrl: string) {
    this.username = username
    this.secret = secret
    this.baseUrl = baseUrl
  }

  async healthCheck() {
    const response = await fetch('https://api.briqpay.com/', {
      headers: { 'User-Agent': BRIQPAY_USER_AGENT },
    })
    if (!response.ok) {
      throw new Error(`Health check failed with status ${response.status}`)
    }
    return response
  }

  private async getTaxRateFromCategory(
    taxCategoryId: string,
    country: string,
    state?: string,
  ): Promise<number | undefined> {
    try {
      const taxCategoryResponse = await apiRoot.taxCategories().withId({ ID: taxCategoryId }).get().execute()

      const rates = taxCategoryResponse.body.rates

      // Try to find exact match with state
      let rate = rates.find((r) => r.country === country && r.state === state)

      // If not found, try without state
      if (!rate) {
        rate = rates.find((r) => r.country === country && !r.state)
      }

      // If still not found, take any rate for the country
      if (!rate) {
        rate = rates.find((r) => r.country === country)
      }

      return rate?.amount
    } catch (e) {
      appLogger.error({ error: e }, 'Error fetching tax category')
      return undefined
    }
  }

  private async getTaxRateFromProduct(productId: string, country: string, state?: string): Promise<number | undefined> {
    try {
      const productResponse = await apiRoot.productProjections().withId({ ID: productId }).get().execute()

      const taxCategoryId = productResponse.body.taxCategory?.id

      if (taxCategoryId) {
        return await this.getTaxRateFromCategory(taxCategoryId, country, state)
      }
    } catch (e) {
      appLogger.error({ error: e }, 'Error fetching product/tax category for tax rate fallback')
    }
    return undefined
  }

  private async getEffectiveTaxRate(ctCart: Cart): Promise<number> {
    const country = ctCart.shippingAddress?.country || ctCart.country

    // Try to get tax rate from line items first
    if (ctCart.lineItems && ctCart.lineItems.length > 0) {
      const firstItem = ctCart.lineItems[0]
      if (firstItem.taxRate?.amount) {
        return firstItem.taxRate.amount
      }

      if (firstItem.productId && country) {
        const rate = await this.getTaxRateFromProduct(firstItem.productId, country, ctCart.shippingAddress?.state)
        if (rate !== undefined) {
          return rate
        }
      }
    }

    // Fallback to shipping tax rate
    if (ctCart.shippingInfo?.taxRate?.amount) {
      return ctCart.shippingInfo.taxRate.amount
    }

    // Last resort: custom line items carry their own tax rate (a cart can consist of
    // ONLY custom line items, which previously made this method throw)
    const customLineItemTaxRate = ctCart.customLineItems.find((item) => item.taxRate?.amount !== undefined)?.taxRate
      ?.amount
    if (customLineItemTaxRate !== undefined) {
      return customLineItemTaxRate
    }

    const errorMessage = `Could not determine effective tax rate for cart ${ctCart.id}. Country: ${country}`
    appLogger.error({ cartId: ctCart.id, country }, errorMessage)
    throw new Error(errorMessage)
  }

  private generateSessionRequestBody(
    ctCart: Cart,
    sessionData: BriqpaySessionData,
    hookUrl: string,
    futureOrderNumber?: string,
  ): CreateSessionRequestBody {
    // Read per session creation (never cached) so each cart resolves to its own Briqpay variant.
    // The merchant stamps this on the cart before the checkout renders; absent it, Briqpay uses
    // the account default variant.
    const configuredVariantId = ctCart.custom?.fields?.[briqpayVariantIdFieldName]
    const variantId = typeof configuredVariantId === 'string' && configuredVariantId ? configuredVariantId : undefined

    const requestBody: CreateSessionRequestBody = {
      product: {
        type: PAYMENT_TOOLS_PRODUCT.PAYMENT,
        intent: SESSION_INTENT.PAYMENT_ONE_TIME,
        ...(variantId && { variantId }),
      },
      customerType: CUSTOMER_TYPE.CONSUMER,
      country: ctCart.country,
      locale: ctCart.locale || 'en-GB',
      urls: {
        terms: process.env.BRIQPAY_TERMS_URL as string,
        redirect: (process.env.ALLOWED_ORIGINS?.split(',')[0]?.trim() as string) || '',
      },
      config: {
        disableSessionCompleteRedirect: true,
      },
      hooks: [
        {
          eventType: EVENT_HOOK.ORDER_STATUS,
          statuses: [
            ORDER_STATUS.ORDER_PENDING,
            ORDER_STATUS.ORDER_REJECTED,
            ORDER_STATUS.ORDER_CANCELLED,
            ORDER_STATUS.ORDER_APPROVED_NOT_CAPTURED,
          ],
          method: 'POST',
          url: hookUrl,
        },
        {
          eventType: EVENT_HOOK.CAPTURE_STATUS,
          statuses: [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.APPROVED, TRANSACTION_STATUS.REJECTED],
          method: 'POST',
          url: hookUrl,
        },
        {
          eventType: EVENT_HOOK.REFUND_STATUS,
          statuses: [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.APPROVED, TRANSACTION_STATUS.REJECTED],
          method: 'POST',
          url: hookUrl,
        },
        ...(process.env.BRIQPAY_EXTERNAL_WEBHOOK_URL
          ? ([
              {
                eventType: EVENT_HOOK.ORDER_STATUS,
                statuses: Object.values(ORDER_STATUS),
                method: 'POST',
                url: process.env.BRIQPAY_EXTERNAL_WEBHOOK_URL,
              },
              {
                eventType: EVENT_HOOK.CAPTURE_STATUS,
                statuses: Object.values(TRANSACTION_STATUS),
                method: 'POST',
                url: process.env.BRIQPAY_EXTERNAL_WEBHOOK_URL,
              },
              {
                eventType: EVENT_HOOK.REFUND_STATUS,
                statuses: Object.values(TRANSACTION_STATUS),
                method: 'POST',
                url: process.env.BRIQPAY_EXTERNAL_WEBHOOK_URL,
              },
            ] satisfies Hooks)
          : []),
      ],
      references: {
        cartId: ctCart.id,
        ...(futureOrderNumber && { reference1: futureOrderNumber }),
      },
      data: sessionData,
      modules: {
        loadModules: [MODULE_TYPE.PAYMENT],
        config: {
          [MODULE_TYPE.PAYMENT]: {
            decision: { enabled: true },
          },
        },
      },
    }

    return requestBody
  }

  /**
   * The cart-total discount line, or undefined when the cart has none.
   * CT amounts are negative; we negate them so Briqpay sees a positive discount.
   */
  private buildTotalDiscountItem(ctCart: Cart, discountNameMap: Map<string, string>): RegularCartItem | undefined {
    if (!ctCart.discountOnTotalPrice?.discountedNetAmount) {
      return undefined
    }

    const net = -ctCart.discountOnTotalPrice.discountedNetAmount.centAmount
    const gross = -(
      ctCart.discountOnTotalPrice.discountedGrossAmount?.centAmount ??
      ctCart.discountOnTotalPrice.discountedNetAmount.centAmount
    )
    const vat = gross - net
    const taxRate = net !== 0 ? Math.round(((gross - net) / net) * 10000) : 0

    const discountIds = collectTotalDiscountIds(ctCart)
    const discountNames = discountIds.map((id) => discountNameMap.get(id)).filter((name): name is string => !!name)
    const discountName = discountNames.length > 0 ? discountNames.join(' + ') : 'Discount'
    const discountReference = discountIds.length > 0 ? `discount-${discountIds.join('-')}` : 'total-discount'

    const discountItem: RegularCartItem = {
      productType: ITEM_PRODUCT_TYPE.DISCOUNT,
      reference: discountReference,
      name: discountName,
      quantity: 1,
      quantityUnit: 'pc',
      unitPrice: net, // ex VAT
      unitPriceIncVat: gross, // incl VAT
      taxRate,
      discountPercentage: 0,
      totalAmount: gross,
      totalVatAmount: vat,
      imageUrl: undefined,
    }

    appLogger.info(
      { ...discountItem, grossAmount: gross, netAmount: net, discountIds },
      'Adding total discount line item:',
    )

    return discountItem
  }

  /**
   * The shipping fee line plus, when shipping is discounted, a separate discount line.
   * Always priced from the ORIGINAL shipping price; discounts are their own lines.
   */
  private buildShippingItems(ctCart: Cart, effectiveTaxRate: number): RegularCartItem[] {
    if (!ctCart.shippingInfo?.price) {
      return []
    }

    const shippingTaxRateAmount = ctCart.shippingInfo.taxRate?.amount ?? effectiveTaxRate
    const taxMultiplier = 1 + shippingTaxRateAmount
    const shippingTaxRate = Math.round(shippingTaxRateAmount * 10000)

    const originalShippingGross = ctCart.shippingInfo.price.centAmount
    const originalShippingNet = Math.round(originalShippingGross / taxMultiplier)

    const shippingItem: RegularCartItem = {
      productType: ITEM_PRODUCT_TYPE.SHIPPING_FEE,
      reference: 'shippingfee',
      name: 'Shipping fee',
      quantity: 1,
      quantityUnit: 'pc',
      unitPrice: originalShippingNet,
      unitPriceIncVat: originalShippingGross,
      taxRate: shippingTaxRate,
      discountPercentage: 0, // No percentage - discounts are separate line items
      totalAmount: originalShippingGross,
      totalVatAmount: originalShippingGross - originalShippingNet,
    }

    appLogger.info({ shippingItem }, 'Added shipping fee item:')

    const discountedPrice = ctCart.shippingInfo.discountedPrice?.value.centAmount
    if (discountedPrice === undefined || discountedPrice >= originalShippingGross) {
      return [shippingItem]
    }

    const shippingDiscountGross = originalShippingGross - discountedPrice
    const shippingDiscountNet = Math.round(shippingDiscountGross / taxMultiplier)
    const shippingDiscountVat = shippingDiscountGross - shippingDiscountNet

    const shippingDiscountItem: RegularCartItem = {
      productType: ITEM_PRODUCT_TYPE.DISCOUNT,
      reference: 'shipping-discount',
      name: 'Shipping Discount',
      quantity: 1,
      quantityUnit: 'pc',
      unitPrice: -shippingDiscountNet, // Negative for discount
      unitPriceIncVat: -shippingDiscountGross, // Negative for discount
      taxRate: shippingTaxRate,
      discountPercentage: 0,
      totalAmount: -shippingDiscountGross, // Negative for discount
      totalVatAmount: -shippingDiscountVat, // Negative for discount
      imageUrl: undefined,
    }

    appLogger.info(
      { shippingDiscountItem, originalShippingGross, discountedPrice, discountAmount: shippingDiscountGross },
      'Added shipping discount line item:',
    )

    return [shippingItem, shippingDiscountItem]
  }

  /**
   * The `data` subtree Briqpay receives, built identically for create and update.
   *
   * Both paths MUST go through here: the sync hash is a claim about these exact
   * bytes, so a second implementation would let create and update drift and make
   * the hash a statement about a payload that was never sent.
   *
   * Reads only cart pricing/address state - never custom fields - so writing the
   * sync hash back onto the cart can never change the hash. That invariant is what
   * stops the resolve/write cycle oscillating.
   */
  private async buildSessionData(ctCart: Cart, amount: PaymentAmount | Money): Promise<BriqpaySessionData> {
    const effectiveTaxRate = await this.getEffectiveTaxRate(ctCart)
    const discountNameMap = await fetchDiscountNamesForCart(ctCart)

    const cartItems = mapBriqpayCartItem(ctCart.lineItems, ctCart.customLineItems, ctCart.locale, discountNameMap)

    const totalDiscountItem = this.buildTotalDiscountItem(ctCart, discountNameMap)
    if (totalDiscountItem) {
      cartItems.push(totalDiscountItem)
    }
    cartItems.push(...this.buildShippingItems(ctCart, effectiveTaxRate))

    const sessionData: BriqpaySessionData = {
      order: {
        currency: amount.currencyCode,
        amountIncVat: amount.centAmount,
        amountExVat: ctCart.taxedPrice?.totalNet?.centAmount ?? Math.round(amount.centAmount / (1 + effectiveTaxRate)),
        cart: cartItems,
      },
      ...(ctCart.billingAddress && { billing: mapBriqpayAddress(ctCart.billingAddress) }),
      ...((ctCart.billingAddress || ctCart.shippingAddress) && {
        shipping: mapBriqpayAddress(ctCart.shippingAddress! || ctCart.billingAddress!),
      }),
    }

    return sessionData
  }

  /**
   * The update payload plus a hash of the exact bytes that will be sent.
   *
   * `updateSession` sends `body` verbatim, which is what makes
   * `hash === sha256(bytes Briqpay accepted)` structurally true instead of a
   * convention someone has to remember. Never mutate `body` after this returns.
   */
  public async buildSessionUpdateRequest(ctCart: Cart, amount: PaymentAmount): Promise<BriqpaySessionUpdateRequest> {
    const data = await this.buildSessionData(ctCart, amount)
    const body = JSON.stringify({ data })

    const request: BriqpaySessionUpdateRequest = {
      body,
      hash: sha256Hex(body),
      amounts: {
        currency: data.order.currency,
        amountIncVat: data.order.amountIncVat,
        amountExVat: data.order.amountExVat,
      },
    }

    return request
  }

  private logFinalAmounts(briqpayCreateSession: CreateSessionRequestBody): void {
    if (!briqpayCreateSession.data?.order?.cart) {
      return
    }

    const regularItems = briqpayCreateSession.data.order.cart.filter(
      (item): item is RegularCartItem =>
        'unitPrice' in item && item.productType !== ITEM_PRODUCT_TYPE.DISCOUNT && item.productType !== 'shipping_fee',
    )
    const discountItems = briqpayCreateSession.data.order.cart.filter(
      (item): item is RegularCartItem => 'unitPrice' in item && item.productType === ITEM_PRODUCT_TYPE.DISCOUNT,
    )
    const shippingItems = briqpayCreateSession.data.order.cart.filter(
      (item): item is RegularCartItem => 'unitPrice' in item && item.productType === 'shipping_fee',
    )

    const regularTotal = regularItems.reduce((sum, item) => sum + item.unitPrice * (item.quantity || 1), 0)
    const discountTotal = discountItems.reduce((sum, item) => sum + item.unitPrice * (item.quantity || 1), 0)
    const shippingTotal = shippingItems.reduce((sum, item) => sum + item.unitPrice * (item.quantity || 1), 0)

    appLogger.info(
      {
        amountIncVat: briqpayCreateSession.data.order.amountIncVat,
        amountExVat: briqpayCreateSession.data.order.amountExVat,
        regularTotal,
        discountTotal,
        shippingTotal,
        cartTotal: regularTotal + discountTotal + shippingTotal,
        regularItems: regularItems.map((item) => ({
          name: item.name,
          productType: item.productType,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          total: item.unitPrice * (item.quantity || 1),
        })),
        discountItems: discountItems.map((item) => ({
          name: item.name,
          productType: item.productType,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          total: item.unitPrice * (item.quantity || 1),
        })),
        shippingItems: shippingItems.map((item) => ({
          name: item.name,
          productType: item.productType,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          total: item.unitPrice * (item.quantity || 1),
        })),
      },
      'Final order amounts:',
    )
  }

  /**
   * Creates a session and reports the sync hash for the `data` it delivered, so the
   * caller can record on the cart that Briqpay already holds this payload. The hash
   * covers the same `data` bytes an update would send - both come from
   * buildSessionData - so it is a true statement about what Briqpay received.
   */
  async createSession(
    ctCart: Cart,
    amountPlanned: PaymentAmount,
    hostname: string,
    futureOrderNumber?: string,
  ): Promise<CreatedBriqpaySession> {
    // Always try https on the default port by default, can always fix the URL from Briqpay if necessary
    const connectorUrl = 'https://' + hostname
    const hookUrl = connectorUrl.endsWith('/') ? connectorUrl + 'notifications' : connectorUrl + '/notifications'

    const sessionData = await this.buildSessionData(ctCart, amountPlanned)
    const briqpayCreateSession = this.generateSessionRequestBody(ctCart, sessionData, hookUrl, futureOrderNumber)

    appLogger.info(
      {
        futureOrderNumber,
        cartId: ctCart.id,
        hasReference1: !!futureOrderNumber,
      },
      'Creating Briqpay session with futureOrderNumber as reference1',
    )

    this.logFinalAmounts(briqpayCreateSession)

    appLogger.info(
      {
        references: briqpayCreateSession.references,
      },
      'Final Briqpay session request prepared',
    )

    const response = await fetch(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
        'content-type': 'application/json',
        'User-Agent': BRIQPAY_USER_AGENT,
      },
      body: JSON.stringify(briqpayCreateSession),
    })

    if (!response.ok) {
      const errorText = await response.text()
      appLogger.error(
        {
          status: response.status,
          statusText: response.statusText,
          errorText,
        },
        'Failed to create Briqpay session',
      )
      throw new Error(`Briqpay session creation failed: ${response.status} ${response.statusText}`)
    }

    const responseData = await response.json()
    appLogger.info({ sessionId: responseData?.sessionId }, 'Briqpay create session response received')

    // Ensure the response has the expected structure
    if (!responseData || !responseData.sessionId) {
      appLogger.error({ responseData }, 'Invalid Briqpay session response: missing sessionId')
      throw new Error('Invalid Briqpay session response: missing sessionId')
    }

    const created: CreatedBriqpaySession = {
      session: normalizeSessionResponse(responseData, responseData.sessionId),
      syncedPayloadHash: sha256Hex(JSON.stringify({ data: sessionData })),
    }

    return created
  }

  async capture(
    ctCart: Cart,
    amount: Omit<PaymentAmount, 'fractionDigits'>,
    sessionId: string,
  ): Promise<{ captureId: string; status: PaymentOutcome } & Record<string, unknown>> {
    const cartItems = mapBriqpayCartItem(
      ctCart.lineItems,
      ctCart.customLineItems,
      ctCart.locale,
      await fetchDiscountNamesForCart(ctCart),
    )
    const briqpayCaptureRequest: Pick<CreateSessionRequestBody, 'data'> = {
      data: {
        order: {
          currency: amount.currencyCode,
          amountIncVat: amount.centAmount,
          amountExVat:
            ctCart.taxedPrice?.totalNet?.centAmount ??
            (ctCart.lineItems.reduce(
              (acc, item) =>
                // totalNet is already the LINE total; only the unit price needs * quantity
                acc + Number(item.taxedPrice?.totalNet?.centAmount ?? item.price.value.centAmount * item.quantity),
              0,
            ) +
              ctCart.customLineItems.reduce(
                (acc, item) => acc + Number(item.taxedPrice?.totalNet?.centAmount ?? item.totalPrice.centAmount),
                0,
              ) ||
              amount.centAmount),
          cart: cartItems,
        },
        // Temporary cast
      } as unknown as Record<string, string | number>,
    }
    return fetch(`${this.baseUrl}/session/${sessionId}/order/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
        'content-type': 'application/json',
        'User-Agent': BRIQPAY_USER_AGENT,
      },
      body: JSON.stringify(briqpayCaptureRequest),
    }).then(async (res) => {
      if (!res.ok) {
        const errorText = await res.text()
        appLogger.error(
          {
            status: res.status,
            data: errorText,
          },
          'Briqpay capture error details:',
        )
        throw new Error(`Briqpay capture error: ${errorText}`)
      }
      return res.json()
    })
  }

  async refund(
    ctCart: Cart,
    amount: Omit<PaymentAmount, 'fractionDigits'>,
    sessionId: string,
    captureId?: string,
  ): Promise<{ refundId: string; status: PaymentOutcome } & Record<string, unknown>> {
    const cartItems = mapBriqpayCartItem(
      ctCart.lineItems,
      ctCart.customLineItems,
      ctCart.locale,
      await fetchDiscountNamesForCart(ctCart),
    )
    const briqpayRefundRequest: Pick<CreateSessionRequestBody, 'data'> & { captureId?: string } = {
      ...(captureId && { captureId }),
      data: {
        order: {
          currency: ctCart.totalPrice.currencyCode,
          amountIncVat: amount.centAmount,
          amountExVat:
            ctCart.taxedPrice?.totalNet?.centAmount ??
            (ctCart.lineItems.reduce(
              (acc, item) =>
                // totalNet is already the LINE total; only the unit price needs * quantity
                acc + Number(item.taxedPrice?.totalNet?.centAmount ?? item.price.value.centAmount * item.quantity),
              0,
            ) +
              ctCart.customLineItems.reduce(
                (acc, item) => acc + Number(item.taxedPrice?.totalNet?.centAmount ?? item.totalPrice.centAmount),
                0,
              ) ||
              amount.centAmount),
          cart: cartItems,
        },
      },
    }
    return fetch(`${this.baseUrl}/session/${sessionId}/order/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
        'content-type': 'application/json',
        'User-Agent': BRIQPAY_USER_AGENT,
      },
      body: JSON.stringify(briqpayRefundRequest),
    }).then(async (res) => {
      if (!res.ok) {
        const errorText = await res.text()
        appLogger.error(
          {
            status: res.status,
            data: errorText,
          },
          'Briqpay refund error details:',
        )
        throw new Error(`Briqpay refund error: ${errorText}`)
      }
      return res.json()
    })
  }

  makeDecision(sessionId: string, decisionRequest: BriqpayDecisionRequest) {
    return fetch(`${this.baseUrl}/session/${sessionId}/decision`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
        'content-type': 'application/json',
        'User-Agent': BRIQPAY_USER_AGENT,
      },
      body: JSON.stringify(decisionRequest),
    })
  }

  /**
   * Fetches the full session from Briqpay API including moduleStatus, captures, and refunds.
   * This is used to get the actual status from Briqpay's source of truth rather than
   * trusting webhook payloads (which are unauthenticated until HMAC is enabled).
   *
   * @param sessionId - The Briqpay session ID
   * @returns The session data including moduleStatus for status verification
   */
  getSession(sessionId: string): Promise<MediumBriqpayResponse> {
    // Fetch moduleStatus, captures, and refunds to get actual status from Briqpay
    // This is critical for security until HMAC webhook validation is implemented
    // Request both 'snippet' and 'htmlSnippet' field names to handle API naming inconsistency
    return fetch(
      `${this.baseUrl}/session/${sessionId}?fields=data,snippet,htmlSnippet,sessionId,moduleStatus,captures,refunds`,
      {
        method: 'GET',
        headers: {
          Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
          'content-type': 'application/json',
          'User-Agent': BRIQPAY_USER_AGENT,
        },
      },
    ).then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text()
        appLogger.error(
          {
            status: response.status,
            data: errorText,
          },
          'Briqpay API error details:',
        )
        throw mapBriqpaySessionError(errorText, sessionId)
      }
      const json = await response.json()

      return normalizeSessionResponse(json, sessionId)
    })
  }

  async cancel(sessionId: string): Promise<{ status: PaymentOutcome }> {
    const response = await fetch(`${this.baseUrl}/session/${sessionId}/order/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
        'content-type': 'application/json',
        'User-Agent': BRIQPAY_USER_AGENT,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      appLogger.error(
        {
          status: response.status,
          data: errorText,
        },
        'Briqpay cancel error details:',
      )
      throw new Error(`Briqpay cancel error: ${errorText}`)
    }

    // 204 No Content is returned on success
    return { status: PaymentOutcome.APPROVED }
  }

  /**
   * Sends a prebuilt update payload. `request.body` goes out verbatim so that
   * `request.hash` provably describes the bytes Briqpay accepted - see
   * buildSessionUpdateRequest.
   */
  public async updateSession(sessionId: string, request: BriqpaySessionUpdateRequest): Promise<MediumBriqpayResponse> {
    try {
      appLogger.info({ sessionId }, 'Updating Briqpay session')

      const response = await fetch(`${this.baseUrl}/session/${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
          'User-Agent': BRIQPAY_USER_AGENT,
        },
        body: request.body,
      })

      if (!response.ok) {
        // Read the body exactly once: consuming it twice (json() then text()) throws
        // and loses the upstream text, which is the only way to identify some errors.
        const errorText = await response.text()
        appLogger.error({ status: response.status, data: errorText }, 'Briqpay API error details:')

        throw mapBriqpaySessionError(errorText, sessionId)
      }

      // No `fields` is sent, so Briqpay answers 200 with the full session. A 204 means
      // someone added `fields=none` - fail legibly rather than on a JSON parse error.
      if (response.status === 204) {
        throw new Error(`Briqpay returned 204 for session ${sessionId}: update requested no response body`)
      }

      const responseData = await response.json()
      appLogger.info({ sessionId }, 'Briqpay update session response:')

      return normalizeSessionResponse(responseData, sessionId)
    } catch (error) {
      appLogger.error({ error }, 'Error updating Briqpay session:')
      throw error
    }
  }
}

// Lazy singleton — defers construction until first method call (after env validation in main.ts).
// Uses a subclass so the exported object is a real BriqpayService instance (compatible with jest.spyOn).
class LazyBriqpayService extends BriqpayService {
  private _initialised = false

  constructor() {
    // Pass empty strings; they will be overwritten on first use.
    super('', '', '')
  }

  private ensureInitialised(): void {
    if (this._initialised) return

    const username = process.env.BRIQPAY_USERNAME
    const secret = process.env.BRIQPAY_SECRET
    const baseUrl = process.env.BRIQPAY_BASE_URL

    if (!username || !secret || !baseUrl) {
      throw new Error(
        'BriqpayService cannot be initialised: BRIQPAY_USERNAME, BRIQPAY_SECRET, and BRIQPAY_BASE_URL must be set',
      )
    }

    // Overwrite the fields inherited from BriqpayService
    ;(this as any).username = username
    ;(this as any).secret = secret
    ;(this as any).baseUrl = baseUrl
    this._initialised = true
  }

  // Override every public method to ensure lazy init runs first.
  // The compiler enforces we don't miss any because the base class is concrete.
  override async createSession(...args: Parameters<BriqpayService['createSession']>) {
    this.ensureInitialised()
    return super.createSession(...args)
  }
  override async getSession(...args: Parameters<BriqpayService['getSession']>) {
    this.ensureInitialised()
    return super.getSession(...args)
  }
  override async updateSession(...args: Parameters<BriqpayService['updateSession']>) {
    this.ensureInitialised()
    return super.updateSession(...args)
  }
  override async capture(...args: Parameters<BriqpayService['capture']>) {
    this.ensureInitialised()
    return super.capture(...args)
  }
  override async refund(...args: Parameters<BriqpayService['refund']>) {
    this.ensureInitialised()
    return super.refund(...args)
  }
  override makeDecision(...args: Parameters<BriqpayService['makeDecision']>) {
    this.ensureInitialised()
    return super.makeDecision(...args)
  }
  override async cancel(...args: Parameters<BriqpayService['cancel']>) {
    this.ensureInitialised()
    return super.cancel(...args)
  }
  override async healthCheck() {
    this.ensureInitialised()
    return super.healthCheck()
  }
}

const Briqpay = new LazyBriqpayService()

export default Briqpay
