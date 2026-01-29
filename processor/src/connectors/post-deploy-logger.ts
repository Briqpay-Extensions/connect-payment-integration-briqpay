import { createApplicationLogger } from '@commercetools-backend/loggers'
import { defaultFieldsFormatter } from '@commercetools/connect-payments-sdk'
import packageJSON from '../../package.json'

/**
 * Standalone logger for post-deploy scripts.
 *
 * This logger doesn't depend on Fastify request context, making it safe
 * to use during connector deployment when no HTTP server is running.
 *
 * Uses static values instead of context-dependent functions.
 */
const log = createApplicationLogger({
  formatters: [
    defaultFieldsFormatter({
      projectKey: process.env.CTP_PROJECT_KEY || 'unknown',
      version: packageJSON.version,
      name: packageJSON.name,
      correlationId: () => 'post-deploy',
      pathTemplate: () => '/post-deploy',
      path: () => '/post-deploy',
    }),
  ],
})

/**
 * Logger interface matching the AppLogger pattern used elsewhere in the codebase.
 */
export const postDeployLogger = {
  debug: (obj: object, message: string) => {
    log.debug(message, obj || undefined)
  },
  info: (obj: object, message: string) => {
    log.info(message, obj || undefined)
  },
  warn: (obj: object, message: string) => {
    log.warn(message, obj || undefined)
  },
  error: (obj: object, message: string) => {
    log.error(message, obj || undefined)
  },
}
