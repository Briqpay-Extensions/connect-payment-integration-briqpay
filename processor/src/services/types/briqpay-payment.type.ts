import { PaymentRequestSchemaDTO } from '../../dtos/briqpay-payment.dto'
import { CommercetoolsCartService, CommercetoolsPaymentService } from '@commercetools/connect-payments-sdk'

export type BriqpayPaymentServiceOptions = {
  ctCartService: CommercetoolsCartService
  ctPaymentService: CommercetoolsPaymentService
}

export type CreatePaymentRequest = {
  data: PaymentRequestSchemaDTO
}

export enum PAYMENT_TOOLS_PRODUCT {
  PAYMENT = 'payment',
  SIGNUP = 'signup',
}

export enum SESSION_INTENT {
  PAYMENT_ONE_TIME = 'payment_one_time',
  PAYMENT_TOKENIZE = 'payment_tokenize',
  PAYMENT_TOKENIZE_AND_CHARGE = 'payment_tokenize_and_charge',
  PAYMENT_CHARGE_TOKEN = 'payment_charge_token',
  SIGNUP = 'signup',
}

export enum CUSTOMER_TYPE {
  BUSINESS = 'business',
  CONSUMER = 'consumer',
}

export enum EVENT_HOOK {
  SESSION_STATUS = 'session_status',
  ORDER_STATUS = 'order_status',
  CAPTURE_STATUS = 'capture_status',
  REFUND_STATUS = 'refund_status',
  MODULE_UI_STATUS = 'module_ui_status',
}

export enum SESSION_STATUS {
  STARTED = 'started',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  REJECTED = 'rejected',
}

export enum ORDER_STATUS {
  ORDER_PENDING = 'order_pending',
  ORDER_REJECTED = 'order_rejected',
  ORDER_CANCELLED = 'order_cancelled',
  ORDER_APPROVED_NOT_CAPTURED = 'order_approved_not_captured',
}

export enum TRANSACTION_STATUS {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

export enum MODULE_TYPE {
  COMPANY_LOOKUP = 'company_lookup',
  CONSUMER_STRONG_AUTH = 'consumer_strong_auth',
  BILLING = 'billing',
  SHIPPING = 'shipping',
  ORDER_NOTE = 'order_note',
  TERMS = 'terms',
  ORDER_INFO = 'order_info',
  CROSS_BORDER = 'cross_border',
  UPSELL = 'upsell',
  CUSTOM_FORM = 'custom_form',
  PAYMENT = 'payment',
  SIGNUP = 'signup',
}

export enum MODULE_UI_STATUS {
  LOCKED_BY_MERCHANT = 'locked_by_merchant',
  HIDDEN = 'hidden',
  NOT_YET_REACHED = 'not_yet_reached',
  NOT_YET_REACHED_LOCKED = 'not_yet_reached_locked',
  VISIBLE = 'visible',
  VISIBLE_OPTIONAL = 'visible_optional',
  VISIBLE_REQUIRED = 'visible_required',
  COMPLETED = 'completed',
}

export interface SessionStatusHook {
  eventType: EVENT_HOOK.SESSION_STATUS
  url: string
  method: 'GET' | 'POST'
  statuses: SESSION_STATUS.COMPLETED[]
}
export interface OrderStatusHook {
  eventType: EVENT_HOOK.ORDER_STATUS
  url: string
  method: 'GET' | 'POST'
  statuses: ORDER_STATUS[]
}
export interface CaptureStatusHook {
  eventType: EVENT_HOOK.CAPTURE_STATUS
  url: string
  method: 'GET' | 'POST'
  statuses: TRANSACTION_STATUS[]
}
export interface RefundStatusHook {
  eventType: EVENT_HOOK.REFUND_STATUS
  url: string
  method: 'GET' | 'POST'
  statuses: TRANSACTION_STATUS[]
}
export interface ModuleUiStatusHook {
  eventType: EVENT_HOOK.MODULE_UI_STATUS
  module: MODULE_TYPE.COMPANY_LOOKUP | MODULE_TYPE.BILLING | MODULE_TYPE.SHIPPING | MODULE_TYPE.PAYMENT
  url: string
  method: 'GET' | 'POST'
  statuses: MODULE_UI_STATUS[]
}
export type Hooks = (SessionStatusHook | OrderStatusHook | CaptureStatusHook | RefundStatusHook | ModuleUiStatusHook)[]

export enum ITEM_PRODUCT_TYPE {
  PHYSICAL = 'physical',
  DIGITAL = 'digital',
  VIRTUAL = 'virtual', // digital is preferred over virtual
  SHIPPING_FEE = 'shipping_fee',
  SHIPPING_LINE = 'shipping_line', // shipping_fee is preferred over shipping_line
  DISCOUNT = 'discount',
  DEPOSIT = 'deposit',
  SALES_TAX = 'sales_tax',
  SURCHARGE = 'surcharge',
  ADJUSTMENT = 'adjustment',
  GIFT_CARD = 'gift_card',
}

export interface RegularCartItem {
  productType:
    | ITEM_PRODUCT_TYPE.PHYSICAL
    | ITEM_PRODUCT_TYPE.DIGITAL
    | ITEM_PRODUCT_TYPE.VIRTUAL
    | ITEM_PRODUCT_TYPE.SHIPPING_FEE
    | ITEM_PRODUCT_TYPE.SHIPPING_LINE
    | ITEM_PRODUCT_TYPE.DISCOUNT
    | ITEM_PRODUCT_TYPE.DEPOSIT
    | ITEM_PRODUCT_TYPE.SURCHARGE
    | ITEM_PRODUCT_TYPE.ADJUSTMENT
    | ITEM_PRODUCT_TYPE.GIFT_CARD
  reference: string | number
  name: string
  quantity: number
  quantityUnit: string
  unitPrice: number
  taxRate: number
  discountPercentage?: number
}

export interface SalesTaxCartItem {
  productType: ITEM_PRODUCT_TYPE.SALES_TAX
  reference: string | number
  name: string
  totalTaxAmount: number
}

export type CartItem = RegularCartItem | SalesTaxCartItem

export interface DataCompany {
  cin?: string
  name?: string
}

export interface DataConsumer {
  identificationNumber?: string
  dateOfBirth?: string
  name?: string
}

export interface IAddressSchema {
  companyName?: string
  cin?: string
  streetAddress?: string
  streetAddress2?: string
  zip?: string
  city?: string
  region?: string
  firstName?: string
  lastName?: string
  email?: string
  phoneNumber?: string
  country?: string
}

export enum COMPANY_PREFILL_LOCK {
  NONE = 'none',
  LOCKED_WITH_MANUAL_FALLBACK = 'locked_with_manual_fallback',
}

export enum LOCK_STATES {
  HARD_LOCK = 'hard_lock',
  SOFT_LOCK = 'soft_lock',
  NONE = 'none',
}

export enum RULE_HANDLE {
  NONE = 'none',
  ENABLED = 'enabled',
  LOCKED = 'locked',
  FETCH_PDF_REPORT = 'fetch_pdf_report',
  MANUAL_REVIEW = 'manual_review',
  PREPAID_INVOICE = 'prepaid_invoice',
  BANKID = 'bankid',
  REQUIRES_CREDIT = 'requiresCredit',
}

export enum OVERRIDE_RULES_DEFAULT_HANDLING {
  DISABLE = 'disable',
  RUN_RULES = 'run_rules',
}

export interface RulesOverride {
  pspId: string
  handles: Partial<Record<Exclude<RULE_HANDLE, RULE_HANDLE.NONE | RULE_HANDLE.REQUIRES_CREDIT>, boolean>>
  config?: {
    lockedMessage?: string
    strongAuthMessage?: string
  }
  otherHandles: OVERRIDE_RULES_DEFAULT_HANDLING
}

export interface PSPRulesOverride {
  psp: RulesOverride[]
  otherPsps: OVERRIDE_RULES_DEFAULT_HANDLING
}

export enum FORM_UI_COMPONENT {
  TEXT_FIELD = 'textField',
  TEXT_AREA = 'textArea',
  RADIO = 'enumRadio',
  CHECKBOX = 'checkbox',
  DROPDOWN = 'enumDropdown',
  PHONE = 'phone',
  COUNTRY_DROPDOWN = 'countryDropdown',
  CURRENCY = 'currency',
}

export interface CustomInput {
  key: string
  type?: string
  minLength: number
  maxLength: number
  enum: number[] | string[] | { value: string | number; label: string; amount: number }[]
  required: boolean
  label: string
  span?: 1 | 2
  component?: FORM_UI_COMPONENT
}

export interface CustomInputCheckbox {
  key: string
  label: string
  required?: boolean
  default?: boolean
}

export interface MinimalBriqpayResponse {
  htmlSnippet: string
  sessionId: string
}

export type MediumBriqpayResponse = MinimalBriqpayResponse & {
  data: {
    order: {
      amountIncVat: number
      amountExVat?: number
      currency: string
      cart: CartItem[]
    }
  }
}

export interface CreateSessionRequestBody {
  product: {
    type: PAYMENT_TOOLS_PRODUCT
    intent?: SESSION_INTENT
    id?: string
    variantId?: string
  }
  customerType?: CUSTOMER_TYPE
  country?: string
  locale?: string
  urls?: {
    terms: string
    redirect: string
  }
  references?: Record<string, string>
  hooks?: (SessionStatusHook | OrderStatusHook | CaptureStatusHook | RefundStatusHook | ModuleUiStatusHook)[]
  config?: {
    disableInsightsTracking?: boolean
    disableSessionCompleteRedirect?: boolean
  }
  data?: {
    order?: {
      amountIncVat: number
      amountExVat?: number
      currency: string
      cart: CartItem[]
    }
    company?: DataCompany
    consumer?: DataConsumer
    billing?: IAddressSchema

    shipping?: IAddressSchema
    tokenization?: {
      tokenId: string
    }
    billingAddresses?: IAddressSchema[]
    shippingAddresses?: IAddressSchema[]
  }
  modules?: {
    loadModules?: MODULE_TYPE[]
    config?: {
      [MODULE_TYPE.COMPANY_LOOKUP]: {
        companyPrefillLock?: COMPANY_PREFILL_LOCK
      }
      [MODULE_TYPE.BILLING]?: {
        lockFields?: Record<string, LOCK_STATES>
      }
      [MODULE_TYPE.SHIPPING]?: {
        lockFields?: Record<string, LOCK_STATES>
      }
      [MODULE_TYPE.PAYMENT]?: {
        pspRulesOverride?: PSPRulesOverride
      }
      [MODULE_TYPE.ORDER_NOTE]?: {
        customInputs?: CustomInput[]
        hideModule?: boolean
      }
      [MODULE_TYPE.UPSELL]?: {
        customInputs?: CustomInput[]
        hideModule?: boolean
        header?: string
        subheader?: string
        footer?: string
      }
      [MODULE_TYPE.TERMS]?: {
        checkboxes?: CustomInputCheckbox[]
      }
    }
  }
}
