import { type AuthMiddlewareOptions, ClientBuilder, type HttpMiddlewareOptions } from '@commercetools/ts-client'

/**
 * Standalone commercetools API client for post-deploy scripts.
 *
 * This client is separate from the main payment-sdk to avoid initialization
 * issues during connector deployment. The payment-sdk requires Fastify
 * request context which isn't available during post-deploy execution.
 */
export function createPostDeployClient() {
  const projectKey = process.env.CTP_PROJECT_KEY
  const clientId = process.env.CTP_CLIENT_ID
  const clientSecret = process.env.CTP_CLIENT_SECRET
  const authUrl = process.env.CTP_AUTH_URL || 'https://auth.europe-west1.gcp.commercetools.com'
  const apiUrl = process.env.CTP_API_URL || 'https://api.europe-west1.gcp.commercetools.com'

  // Validate required environment variables
  const missingVars: string[] = []
  if (!projectKey) missingVars.push('CTP_PROJECT_KEY')
  if (!clientId) missingVars.push('CTP_CLIENT_ID')
  if (!clientSecret) missingVars.push('CTP_CLIENT_SECRET')

  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables for post-deploy: ${missingVars.join(', ')}`)
  }

  const authMiddlewareOptions: AuthMiddlewareOptions = {
    host: authUrl,
    projectKey: projectKey!,
    credentials: {
      clientId: clientId!,
      clientSecret: clientSecret!,
    },
    scopes: [`manage_types:${projectKey}`, `view_types:${projectKey}`],
    httpClient: fetch,
  }

  const httpMiddlewareOptions: HttpMiddlewareOptions = {
    host: apiUrl,
    includeRequestInErrorResponse: true,
    includeOriginalRequest: true,
    httpClient: fetch,
  }

  return new ClientBuilder()
    .withProjectKey(projectKey!)
    .withClientCredentialsFlow(authMiddlewareOptions)
    .withHttpMiddleware(httpMiddlewareOptions)
    .build()
}

export function getProjectKey(): string {
  const projectKey = process.env.CTP_PROJECT_KEY
  if (!projectKey) {
    throw new Error('CTP_PROJECT_KEY environment variable is required')
  }
  return projectKey
}
