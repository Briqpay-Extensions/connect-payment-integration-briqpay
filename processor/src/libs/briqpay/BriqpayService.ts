import { Address, Cart, LineItem } from '@commercetools/platform-sdk'
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
import { appLogger, paymentSDK } from '../../payment-sdk'

const mapBriqpayProductType = (item: LineItem) => {
  // Check if it's a gift card
  if (item.lineItemMode === 'GiftCard') return ITEM_PRODUCT_TYPE.GIFT_CARD

  // Check if it's a discount
  if (item.priceMode === 'Discounted') return ITEM_PRODUCT_TYPE.DISCOUNT

  // Check if the product has a digital-related attribute
  if (item.variant.attributes) {
    const isDigitalAttr = item.variant.attributes.find((attr) => attr.name === 'isDigital')
    if (isDigitalAttr?.value === 'true') return ITEM_PRODUCT_TYPE.DIGITAL
  }

  // Check product type (if your setup has a digital category)
  if (item.productType.id.toLowerCase().includes('digital')) return ITEM_PRODUCT_TYPE.DIGITAL

  // Default to physical
  return ITEM_PRODUCT_TYPE.PHYSICAL
}

const mapBriqpayCartItem = (lineItems: LineItem[], locale: string | undefined): CartItem[] => {
  appLogger.info(
    {
      inputItems: lineItems.map((item) => ({
        id: item.id,
        name: item.name[locale || 'en-GB'],
        quantity: item.quantity,
        originalPrice: item.price.value.centAmount,
        discountedPrice: item.price.discounted?.value.centAmount,
        lineItemMode: item.lineItemMode,
        priceMode: item.priceMode,
        price: item.price,
        taxedPrice: item.taxedPrice,
        discountedPricePerQuantity: item.discountedPricePerQuantity,
        // Add detailed logging for discounts
        hasDiscountedPrice: !!item.price.discounted,
        hasDiscountedPricePerQuantity: item.discountedPricePerQuantity?.length > 0,
        hasTaxedPrice: !!item.taxedPrice,
        taxedPriceDetails: item.taxedPrice
          ? {
              totalNet: item.taxedPrice.totalNet?.centAmount,
              totalGross: item.taxedPrice.totalGross?.centAmount,
              taxPortions: item.taxedPrice.taxPortions,
            }
          : undefined,
      })),
    },
    'Mapping cart items to Briqpay format:',
  )

  const mappedItems = lineItems.flatMap((item) => {
    // Handle discount line items and gift cards
    if (item.lineItemMode === 'GiftCard' || item.priceMode === 'Discounted') {
      const discountItem: RegularCartItem = {
        productType: ITEM_PRODUCT_TYPE.DISCOUNT,
        reference: item.key ?? item.name[locale || 'en-GB'],
        name: item.name[locale || 'en-GB'],
        quantity: item.quantity,
        quantityUnit: 'pc',
        unitPrice: item.price.value.centAmount,
        taxRate: (item.taxRate?.amount ?? 0) * 10000,
        discountPercentage: 0,
      }
      appLogger.info(discountItem, 'Created discount line item:')
      return [discountItem]
    }

    // Handle regular items
    const regularItem: RegularCartItem = {
      productType: mapBriqpayProductType(item),
      reference: item.key ?? item.name[locale || 'en-GB'],
      name: item.name[locale || 'en-GB'],
      quantity: item.quantity,
      quantityUnit: 'pc',
      unitPrice: item.taxedPrice?.totalNet?.centAmount
        ? Math.round(item.taxedPrice.totalNet.centAmount / item.quantity)
        : Math.round(item.price.value.centAmount / 1.19), // Fallback to calculating net from gross if taxedPrice is not available
      taxRate: (item.taxRate?.amount ?? 0) * 10000,
      discountPercentage: 0,
    }

    appLogger.info(
      {
        ...regularItem,
        originalPrice: item.price.value.centAmount,
        taxedPrice: item.taxedPrice,
        hasDiscountedPrice: !!item.price.discounted,
        hasDiscountedPricePerQuantity: item.discountedPricePerQuantity?.length > 0,
        hasTaxedPrice: !!item.taxedPrice,
      },
      'Created regular line item:',
    )
    return [regularItem]
  })

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

  async createSession(ctCart: Cart, amountPlanned: PaymentAmount) {
    const res = await paymentSDK.ctAPI.client
      .customObjects()
      .withContainerAndKey({ container: 'briqpay-config', key: 'processor-url' })
      .get()
      .execute()

    const connectorUrl = res.body.value.url
    const hookUrl = connectorUrl.endsWith('/') ? connectorUrl + 'notifications' : connectorUrl + '/notifications'

    const briqpayCreateSession: CreateSessionRequestBody = {
      product: {
        type: PAYMENT_TOOLS_PRODUCT.PAYMENT,
        intent: SESSION_INTENT.PAYMENT_ONE_TIME,
      },
      customerType: CUSTOMER_TYPE.CONSUMER,
      country: ctCart.country,
      locale: ctCart.locale || 'en-GB',
      urls: {
        terms: process.env.BRIQPAY_TERMS_URL as string,
        redirect: process.env.BRIQPAY_CONFIRMATION_URL as string,
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
      },
      data: {
        ...(ctCart.billingAddress && { billing: mapBriqpayAddress(ctCart.billingAddress) }),
        ...((ctCart.billingAddress || ctCart.shippingAddress) && {
          shipping: mapBriqpayAddress(ctCart.shippingAddress! || ctCart.billingAddress!),
        }),
        order: {
          currency: ctCart.totalPrice.currencyCode,
          amountIncVat: amountPlanned.centAmount,
          amountExVat: ctCart.taxedPrice?.totalNet?.centAmount ?? Math.round(amountPlanned.centAmount / 1.19),
          cart: mapBriqpayCartItem(ctCart.lineItems, ctCart.locale),
        },
      },
      modules: {
        loadModules: [MODULE_TYPE.PAYMENT],
      },
    }

    // Add discount from discountOnTotalPrice if it exists
    if (ctCart.discountOnTotalPrice?.discountedNetAmount && briqpayCreateSession.data?.order?.cart) {
      const discountItem: RegularCartItem = {
        productType: ITEM_PRODUCT_TYPE.DISCOUNT,
        reference: 'Discount',
        name: 'Discount',
        quantity: 1,
        quantityUnit: 'pc',
        unitPrice: -ctCart.discountOnTotalPrice.discountedNetAmount.centAmount, // Negative amount for discount, using net amount
        taxRate: 1900, // 19% VAT
        discountPercentage: 0,
      }
      appLogger.info(
        {
          ...discountItem,
          grossAmount: ctCart.discountOnTotalPrice.discountedGrossAmount?.centAmount,
          netAmount: ctCart.discountOnTotalPrice.discountedNetAmount.centAmount,
        },
        'Adding total discount line item:',
      )
      briqpayCreateSession.data.order.cart.push(discountItem)
    }

    // Log the final amounts for verification
    if (briqpayCreateSession.data?.order?.cart) {
      const regularItems = briqpayCreateSession.data.order.cart.filter(
        (item): item is RegularCartItem => 'unitPrice' in item && item.productType !== ITEM_PRODUCT_TYPE.DISCOUNT,
      )
      const discountItems = briqpayCreateSession.data.order.cart.filter(
        (item): item is RegularCartItem => 'unitPrice' in item && item.productType === ITEM_PRODUCT_TYPE.DISCOUNT,
      )

      const regularTotal = regularItems.reduce((sum, item) => {
        const itemTotal = item.unitPrice * (item.quantity || 1)
        return sum + itemTotal
      }, 0)

      const discountTotal = discountItems.reduce((sum, item) => {
        const itemTotal = item.unitPrice * (item.quantity || 1)
        return sum + itemTotal
      }, 0)

      appLogger.info(
        {
          amountIncVat: briqpayCreateSession.data.order.amountIncVat,
          amountExVat: briqpayCreateSession.data.order.amountExVat,
          regularTotal,
          discountTotal,
          cartTotal: regularTotal + discountTotal,
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
        },
        'Final order amounts:',
      )
    }

    return fetch(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(this.username + ':' + this.secret)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(briqpayCreateSession),
    }).then((res) => res.json())
  }

  capture(
    ctCart: Cart,
    amountPlanned: Omit<PaymentAmount, 'fractionDigits'>,
    sessionId: string,
  ): Promise<{ captureId: string; status: PaymentOutcome } & Record<string, unknown>> {
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
          cart: mapBriqpayCartItem(ctCart.lineItems, ctCart.locale),
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
    }).then((res) => res.json())
  }

  refund(
    ctCart: Cart,
    amountPlanned: Omit<PaymentAmount, 'fractionDigits'>,
    sessionId: string,
    captureId?: string,
  ): Promise<{ refundId: string; status: PaymentOutcome } & Record<string, unknown>> {
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
          cart: mapBriqpayCartItem(ctCart.lineItems, ctCart.locale),
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
    }).then((res) => res.json())
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

  getSession(sessionId: string): Promise<MediumBriqpayResponse> {
    return fetch(`${this.baseUrl}/session/${sessionId}?fields=data,snippet,sessionId`, {
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

  public async updateSession(cart: Cart, amount: Money, sessionId: string): Promise<CreateSessionRequestBody> {
    try {
      const data = {
        data: {
          order: {
            currency: amount.currencyCode,
            amountIncVat: amount.centAmount,
            amountExVat: Math.round(amount.centAmount / 1.19), // Assuming 19% VAT
            cart: mapBriqpayCartItem(cart.lineItems, cart.locale),
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
