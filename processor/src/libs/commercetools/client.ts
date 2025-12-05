import {
  type AuthMiddlewareOptions,
  ClientBuilder,
  type HttpMiddlewareOptions,
  type HttpUserAgentOptions,
} from '@commercetools/ts-client'
import { config } from '../../config/config'
import packageJSON from '../../../package.json'

const authMiddlewareOptions: AuthMiddlewareOptions = {
  host: config.authUrl,
  projectKey: config.projectKey,
  credentials: {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  },
  scopes: [`manage_project:${config.projectKey}`],
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
