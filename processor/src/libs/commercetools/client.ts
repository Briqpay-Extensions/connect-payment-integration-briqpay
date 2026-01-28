import {
  type AuthMiddlewareOptions,
  ClientBuilder,
  type HttpMiddlewareOptions,
  type HttpUserAgentOptions,
} from '@commercetools/ts-client'
import { config } from '../../config/config'
import packageJSON from '../../../package.json'

const connectScopes = [
  'manage_orders:briqpay-plugin',
  'view_key_value_documents:briqpay-plugin',
  'view_states:briqpay-plugin',
  'view_product_selections:briqpay-plugin',
  'view_attribute_groups:briqpay-plugin',
  'view_shopping_lists:briqpay-plugin',
  'view_shipping_methods:briqpay-plugin',
  'manage_sessions:briqpay-plugin',
  'manage_types:briqpay-plugin',
  'manage_checkout_payment_intents:briqpay-plugin',
  'view_categories:briqpay-plugin',
  'manage_key_value_documents:briqpay-plugin',
  'view_discount_codes:briqpay-plugin',
  'view_products:briqpay-plugin',
  'view_cart_discounts:briqpay-plugin',
  'manage_payments:briqpay-plugin',
  'view_stores:briqpay-plugin',
  'manage_checkout_transactions:briqpay-plugin',
  'view_tax_categories:briqpay-plugin',
  'view_order_edits:briqpay-plugin',
]

const authMiddlewareOptions: AuthMiddlewareOptions = {
  host: config.authUrl,
  projectKey: config.projectKey,
  credentials: {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  },
  scopes: connectScopes.map((scope) => `${scope}:${config.projectKey}`),
  httpClient: fetch,
}

const httpMiddlewareOptions: HttpMiddlewareOptions = {
  host: config.apiUrl,
  includeRequestInErrorResponse: true,
  includeOriginalRequest: true,
  httpClient: fetch,
}

const userAgentOptions: HttpUserAgentOptions = {
  libraryName: packageJSON.name,
  libraryVersion: packageJSON.version,
}

export const ctpClient = new ClientBuilder()
  .withProjectKey(config.projectKey)
  .withClientCredentialsFlow(authMiddlewareOptions)
  .withHttpMiddleware(httpMiddlewareOptions)
  .withUserAgentMiddleware(userAgentOptions)
  .withLoggerMiddleware()
  .build()
