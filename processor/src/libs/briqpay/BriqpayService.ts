import { Address, Cart, LineItem } from '@commercetools/platform-sdk'
import { apiRoot } from '../commercetools/api-root'
import { BriqpayDecisionRequest, PaymentOutcome } from '../../dtos/briqpay-payment.dto'
import {
  CartItem,
  CreateSessionRequestBody,
  CUSTOMER_TYPE,
  EVENT_HOOK,
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
import { matchOriginPattern } from '../utils/origin-matching'

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

const getLocalizedName = (item: LineItem, locale: string): string => {
  const nameRecord = item.name as Record<string, string> | undefined
  if (nameRecord) {
    const localizedName = nameRecord[locale] || nameRecord['en'] || Object.values(nameRecord)[0]
    if (localizedName) return localizedName
  }
  return item.productKey ?? item.productId ?? 'Item'
}

const createDiscountLineItem = (item: LineItem, localeName: string, taxRate: number): RegularCartItem => {
  const quantity = item.quantity
  const grossUnit = item.price.value.centAmount
  const netUnit = item.taxedPrice?.totalNet
    ? Math.round(item.taxedPrice.totalNet.centAmount / quantity)
    : Math.round(grossUnit / (1 + (item.taxRate?.amount ?? 0)))

  return {
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

  return {
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

  return {
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

const mapBriqpayCartItem = async (lineItems: LineItem[], locale: string | undefined): Promise<CartItem[]> => {
  const fallbackLocale = locale || 'en-GB'

  const allDiscountIds = collectDiscountIds(lineItems)
  const discountNameMap = await fetchCartDiscountNames(allDiscountIds, fallbackLocale)

  appLogger.info(
    { discountIds: allDiscountIds, discountNameMap: Object.fromEntries(discountNameMap) },
    'Fetched cart discount names:',
  )

  const mappedItems = lineItems.flatMap((item) => mapSingleLineItem(item, fallbackLocale, discountNameMap))

  appLogger.info(mappedItems, 'Final mapped items:')
  return mappedItems
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
    const response = await fetch(new URL(this.baseUrl).origin)
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

    const errorMessage = `Could not determine effective tax rate for cart ${ctCart.id}. Country: ${country}`
    appLogger.error({ cartId: ctCart.id, country }, errorMessage)
    throw new Error(errorMessage)
  }

  /**
   * Checks if the given origin is a local development URL (localhost or local IP).
   */
  private isLocalDevelopmentOrigin(origin: string): boolean {
    try {
      const url = new URL(origin)
      const hostname = url.hostname.toLowerCase()

      // Check for localhost
      if (hostname === 'localhost') {
        return true
      }

      // Check for IPv4 loopback (127.x.x.x)
      if (hostname.startsWith('127.')) {
        return true
      }

      // Check for IPv6 loopback
      if (hostname === '::1' || hostname === '[::1]') {
        return true
      }

      // Check for private IPv4 ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
      const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
      const match = hostname.match(ipv4Regex)
      if (match) {
        const [, a, b] = match.map(Number)
        if (a === 10) return true // 10.0.0.0/8
        if (a === 192 && b === 168) return true // 192.168.0.0/16
        if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
      }

      return false
    } catch {
      return false
    }
  }

  /**
   * Builds the confirmation redirect URL.
   * Uses clientOrigin for dynamic URL construction when the origin is either:
   * - A local development URL (localhost/local IPs)
   * - Listed in ALLOWED_ORIGINS (supports wildcard patterns, e.g. https://*.preview.example.com)
   * Otherwise, falls back to BRIQPAY_CONFIRMATION_URL from env.
   */
  private buildConfirmationUrl(clientOrigin?: string): string {
    const envConfirmationUrl = process.env.BRIQPAY_CONFIRMATION_URL as string

    if (!clientOrigin) {
      return envConfirmationUrl
    }

    // Allow dynamic redirect for local development or allowed origins
    if (!this.isLocalDevelopmentOrigin(clientOrigin) && !this.isAllowedOrigin(clientOrigin)) {
      return envConfirmationUrl
    }

    try {
      // Extract the path from the env URL (e.g., '/order-confirmation')
      const envUrl = new URL(envConfirmationUrl)
      const path = envUrl.pathname + envUrl.search + envUrl.hash

      // Clean up the client origin (remove trailing slash, handle referer with path)
      let origin = clientOrigin
      // If it's a referer URL (has path), extract just the origin
      if (origin.includes('/', 8)) {
        // 8 = length of 'https://'
        const url = new URL(origin)
        origin = url.origin
      }

      appLogger.info({ clientOrigin, origin, path }, 'Building dynamic confirmation URL for allowed origin')
      return origin + path
    } catch (error) {
      appLogger.warn(
        { clientOrigin, error: error instanceof Error ? error.message : error },
        'Failed to parse client origin, falling back to env URL',
      )
      return envConfirmationUrl
    }
  }

  /**
   * Checks if the given origin matches any entry in ALLOWED_ORIGINS.
   * Supports wildcard patterns (e.g. https://*.preview.example.com).
   */
  private isAllowedOrigin(origin: string): boolean {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()) || []
    return allowedOrigins.some((pattern) => matchOriginPattern(pattern, origin))
  }

  private async generateSessionRequestBody(
    ctCart: Cart,
    amountPlanned: PaymentAmount,
    hookUrl: string,
    futureOrderNumber?: string,
    clientOrigin?: string,
  ): Promise<CreateSessionRequestBody> {
    const effectiveTaxRate = await this.getEffectiveTaxRate(ctCart)
    const taxMultiplier = 1 + effectiveTaxRate
    const cartItems = await mapBriqpayCartItem(ctCart.lineItems, ctCart.locale)

    return {
      product: {
        type: PAYMENT_TOOLS_PRODUCT.PAYMENT,
        intent: SESSION_INTENT.PAYMENT_ONE_TIME,
      },
      customerType: CUSTOMER_TYPE.CONSUMER,
      country: ctCart.country,
      locale: ctCart.locale || 'en-GB',
      urls: {
        terms: process.env.BRIQPAY_TERMS_URL as string,
        redirect: this.buildConfirmationUrl(clientOrigin),
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
      ],
      references: {
        cartId: ctCart.id,
        ...(futureOrderNumber && { reference1: futureOrderNumber }),
      },
      data: {
        ...(ctCart.billingAddress && { billing: mapBriqpayAddress(ctCart.billingAddress) }),
        ...((ctCart.billingAddress || ctCart.shippingAddress) && {
          shipping: mapBriqpayAddress(ctCart.shippingAddress! || ctCart.billingAddress!),
        }),
        order: {
          currency: ctCart.totalPrice.currencyCode,
          amountIncVat: amountPlanned.centAmount,
          amountExVat: ctCart.taxedPrice?.totalNet?.centAmount ?? Math.round(amountPlanned.centAmount / taxMultiplier),
          cart: cartItems,
        },
      },
      modules: {
        loadModules: [MODULE_TYPE.PAYMENT],
      },
    }
  }

  private async addDiscountItem(briqpayCreateSession: CreateSessionRequestBody, ctCart: Cart): Promise<void> {
    if (!ctCart.discountOnTotalPrice?.discountedNetAmount || !briqpayCreateSession.data?.order?.cart) {
      return
    }

    // CT amounts are negative, we negate them to make Briqpay see a positive discount
    const net = -ctCart.discountOnTotalPrice.discountedNetAmount.centAmount
    const gross = -(
      ctCart.discountOnTotalPrice.discountedGrossAmount?.centAmount ??
      ctCart.discountOnTotalPrice.discountedNetAmount.centAmount
    )
    const vat = gross - net
    const taxRate = Math.round(((gross - net) / net) * 10000)

    // Get discount IDs from discountOnTotalPrice.includedDiscounts
    const discountIds =
      ctCart.discountOnTotalPrice.includedDiscounts?.map((d) => d.discount.id).filter((id) => !!id) ?? []

    // Fetch Cart Discount names
    const locale = ctCart.locale || 'en-GB'
    const discountNameMap = await fetchCartDiscountNames(discountIds, locale)

    // Build discount name and reference from Cart Discount names
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
      {
        ...discountItem,
        grossAmount: gross,
        netAmount: net,
        discountIds,
      },
      'Adding total discount line item:',
    )

    briqpayCreateSession.data.order.cart.push(discountItem)
  }

  private async addShippingItem(briqpayCreateSession: CreateSessionRequestBody, ctCart: Cart): Promise<void> {
    if (!ctCart.shippingInfo?.shippingMethod || !briqpayCreateSession.data?.order?.cart || !ctCart.shippingInfo.price) {
      return
    }

    const shippingPrice = ctCart.shippingInfo.price
    const effectiveTaxRate = await this.getEffectiveTaxRate(ctCart)
    const taxMultiplier = 1 + effectiveTaxRate
    const shippingTaxRate = Math.round((ctCart.shippingInfo.taxRate?.amount ?? effectiveTaxRate) * 10000)

    // Always use ORIGINAL shipping price (before discounts)
    const originalShippingGross = shippingPrice.centAmount
    const originalShippingNet = Math.round(originalShippingGross / taxMultiplier)

    // Add shipping item at original price
    const shippingItem: RegularCartItem = {
      productType: 'shipping_fee' as any,
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

    briqpayCreateSession.data.order.cart.push(shippingItem)
    appLogger.info({ shippingItem }, 'Added shipping fee item:')

    // If shipping has a discount, add a separate discount line item
    const discountedPrice = ctCart.shippingInfo.discountedPrice?.value.centAmount
    if (discountedPrice !== undefined && discountedPrice < originalShippingGross) {
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

      briqpayCreateSession.data.order.cart.push(shippingDiscountItem)
      appLogger.info(
        {
          shippingDiscountItem,
          originalShippingGross,
          discountedPrice,
          discountAmount: shippingDiscountGross,
        },
        'Added shipping discount line item:',
      )
    }
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

  async createSession(
    ctCart: Cart,
    amountPlanned: PaymentAmount,
    hostname: string,
    futureOrderNumber?: string,
    clientOrigin?: string,
  ) {
    // Always try https on the default port by default, can always fix the URL from Briqpay if necessary
    const connectorUrl = 'https://' + hostname
    const hookUrl = connectorUrl.endsWith('/') ? connectorUrl + 'notifications' : connectorUrl + '/notifications'

    const briqpayCreateSession = await this.generateSessionRequestBody(
      ctCart,
      amountPlanned,
      hookUrl,
      futureOrderNumber,
      clientOrigin,
    )

    appLogger.info(
      {
        futureOrderNumber,
        cartId: ctCart.id,
        hasReference1: !!futureOrderNumber,
      },
      'Creating Briqpay session with futureOrderNumber as reference1',
    )

    await this.addDiscountItem(briqpayCreateSession, ctCart)
    await this.addShippingItem(briqpayCreateSession, ctCart)
    this.logFinalAmounts(briqpayCreateSession)

    appLogger.info(
      {
        references: briqpayCreateSession.references,
        requestBody: JSON.stringify(briqpayCreateSession, null, 2),
      },
      'Final Briqpay session request body',
    )

    const response = await fetch(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
        'content-type': 'application/json',
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
    appLogger.info({ responseData: JSON.stringify(responseData, null, 2) }, 'Briqpay create session response:')

    // Ensure the response has the expected structure
    if (!responseData || !responseData.sessionId) {
      appLogger.error({ responseData }, 'Invalid Briqpay session response: missing sessionId')
      throw new Error('Invalid Briqpay session response: missing sessionId')
    }

    return responseData
  }

  async capture(
    ctCart: Cart,
    amountPlanned: Omit<PaymentAmount, 'fractionDigits'>,
    sessionId: string,
  ): Promise<{ captureId: string; status: PaymentOutcome } & Record<string, unknown>> {
    const cartItems = await mapBriqpayCartItem(ctCart.lineItems, ctCart.locale)
    const briqpayCaptureRequest: Pick<CreateSessionRequestBody, 'data'> = {
      data: {
        order: {
          currency: amountPlanned.currencyCode,
          amountIncVat: amountPlanned.centAmount,
          amountExVat:
            ctCart.taxedPrice?.totalNet?.centAmount ??
            (ctCart.lineItems.reduce(
              (acc, item) =>
                acc + Number(item.taxedPrice?.totalNet?.centAmount || item.price.value.centAmount) * item.quantity,
              0,
            ) ||
              amountPlanned.centAmount),
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
      },
      body: JSON.stringify(briqpayCaptureRequest),
    }).then((res) => {
      return res.json()
    })
  }

  async refund(
    ctCart: Cart,
    amountPlanned: Omit<PaymentAmount, 'fractionDigits'>,
    sessionId: string,
    captureId?: string,
  ): Promise<{ refundId: string; status: PaymentOutcome } & Record<string, unknown>> {
    const cartItems = await mapBriqpayCartItem(ctCart.lineItems, ctCart.locale)
    const briqpayRefundRequest: Pick<CreateSessionRequestBody, 'data'> & { captureId?: string } = {
      ...(captureId && { captureId }),
      data: {
        order: {
          currency: ctCart.totalPrice.currencyCode,
          amountIncVat: amountPlanned.centAmount,
          amountExVat:
            ctCart.taxedPrice?.totalNet?.centAmount ??
            (ctCart.lineItems.reduce(
              (acc, item) =>
                acc + Number(item.taxedPrice?.totalNet?.centAmount || item.price.value.centAmount) * item.quantity,
              0,
            ) ||
              amountPlanned.centAmount),
          cart: cartItems,
        },
      },
    }
    return fetch(`${this.baseUrl}/session/${sessionId}/order/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
        'content-type': 'application/json',
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
    return fetch(`${this.baseUrl}/session/${sessionId}?fields=data,snippet,sessionId,moduleStatus,captures,refunds`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
        'content-type': 'application/json',
      },
    }).then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text()
        appLogger.error(
          {
            status: response.status,
            data: errorText,
          },
          'Briqpay API error details:',
        )
        throw new Error(`Briqpay API error: ${errorText}`)
      }
      return response.json()
    })
  }

  async cancel(sessionId: string): Promise<{ status: PaymentOutcome }> {
    const response = await fetch(`${this.baseUrl}/session/${sessionId}/order/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
        'content-type': 'application/json',
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

  private async addShippingItemToCart(cartItems: CartItem[], cart: Cart): Promise<void> {
    if (!cart.shippingInfo || !cart.shippingInfo.price) {
      return
    }

    const shippingPrice = cart.shippingInfo.price
    const effectiveTaxRate = await this.getEffectiveTaxRate(cart)
    const taxMultiplier = 1 + effectiveTaxRate
    const shippingTaxRate = (cart.shippingInfo.taxRate?.amount ?? effectiveTaxRate) * 10000

    // Always use ORIGINAL shipping price (before discounts)
    const originalShippingGross = shippingPrice.centAmount
    const originalShippingNet = Math.round(originalShippingGross / taxMultiplier)

    // Add shipping item at original price
    const shippingItem: RegularCartItem = {
      productType: 'shipping_fee' as any,
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

    cartItems.push(shippingItem)
    appLogger.info({ shippingItem }, 'Added shipping fee item to update session:')

    // If shipping has a discount, add a separate discount line item
    const discountedPrice = cart.shippingInfo.discountedPrice?.value.centAmount
    if (discountedPrice !== undefined && discountedPrice < originalShippingGross) {
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

      cartItems.push(shippingDiscountItem)
      appLogger.info(
        {
          shippingDiscountItem,
          originalShippingGross,
          discountedPrice,
          discountAmount: shippingDiscountGross,
        },
        'Added shipping discount line item to update session:',
      )
    }
  }

  /**
   * Adds discount item to cart items array for session updates.
   * CT discount amounts are negative, we negate them to make Briqpay see a positive discount.
   */
  private async addDiscountItemToCart(cartItems: CartItem[], cart: Cart): Promise<void> {
    if (!cart.discountOnTotalPrice?.discountedNetAmount) {
      return
    }

    const net = -cart.discountOnTotalPrice.discountedNetAmount.centAmount
    const gross = -(
      cart.discountOnTotalPrice.discountedGrossAmount?.centAmount ??
      cart.discountOnTotalPrice.discountedNetAmount.centAmount
    )
    const vat = gross - net
    const taxRate = net !== 0 ? Math.round(((gross - net) / net) * 10000) : 0

    // Get discount IDs from discountOnTotalPrice.includedDiscounts
    const discountIds =
      cart.discountOnTotalPrice.includedDiscounts?.map((d) => d.discount.id).filter((id) => !!id) ?? []

    // Fetch Cart Discount names
    const locale = cart.locale || 'en-GB'
    const discountNameMap = await fetchCartDiscountNames(discountIds, locale)

    // Build discount name and reference from Cart Discount names
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
      {
        ...discountItem,
        grossAmount: gross,
        netAmount: net,
        discountIds,
      },
      'Adding total discount line item to update session:',
    )

    cartItems.push(discountItem)
  }

  public async updateSession(sessionId: string, cart: Cart, amount: Money): Promise<MediumBriqpayResponse> {
    try {
      const cartItems = await mapBriqpayCartItem(cart.lineItems, cart.locale)
      await this.addDiscountItemToCart(cartItems, cart)
      await this.addShippingItemToCart(cartItems, cart)

      const effectiveTaxRate = await this.getEffectiveTaxRate(cart)
      const taxMultiplier = 1 + effectiveTaxRate

      const data = {
        data: {
          order: {
            currency: amount.currencyCode,
            amountIncVat: amount.centAmount,
            amountExVat: Math.round(amount.centAmount / taxMultiplier),
            cart: cartItems,
          },
          ...(cart.billingAddress && { billing: mapBriqpayAddress(cart.billingAddress) }),
          ...((cart.billingAddress || cart.shippingAddress) && {
            shipping: mapBriqpayAddress(cart.shippingAddress! || cart.billingAddress!),
          }),
        },
      }

      appLogger.info({}, 'Updating Briqpay session')

      const response = await fetch(`${this.baseUrl}/session/${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
        },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        let errorMessage = 'Unknown error'
        try {
          const errorData = await response.json()
          appLogger.error(
            {
              status: response.status,
              data: errorData,
            },
            'Briqpay API error details:',
          )
          errorMessage = errorData?.error?.message || 'Unknown error'
        } catch {
          // If response is not JSON, try to get the text
          const text = await response.text()
          appLogger.error(
            {
              status: response.status,
              text,
            },
            'Briqpay API error details:',
          )
          errorMessage = text || 'Unknown error'
        }
        throw new Error(`Briqpay API error: ${errorMessage}`)
      }

      const responseData = await response.json()
      appLogger.info({}, 'Briqpay update session response:')

      if (!responseData || !responseData.sessionId) {
        throw new Error('Invalid session response: missing sessionId')
      }

      return responseData
    } catch (error) {
      appLogger.error({ error }, 'Error updating Briqpay session:')
      throw error
    }
  }
}

// Singleton
const Briqpay = new BriqpayService(
  process.env.BRIQPAY_USERNAME as string,
  process.env.BRIQPAY_SECRET as string,
  process.env.BRIQPAY_BASE_URL as string,
)

export default Briqpay
