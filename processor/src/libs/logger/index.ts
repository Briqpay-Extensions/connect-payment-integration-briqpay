import { createApplicationLogger } from '@commercetools-backend/loggers'
import { defaultFieldsFormatter } from '@commercetools/connect-payments-sdk'
import { getRequestContext } from '../fastify/context/context'
import { config } from '../../config/config'
import packageJSON from '../../../package.json'

export const log = createApplicationLogger({
  formatters: [
    defaultFieldsFormatter({
      projectKey: config.projectKey,
      version: packageJSON.version,
      name: packageJSON.name,
      correlationId: () => getRequestContext().correlationId,
      pathTemplate: () => getRequestContext().pathTemplate,
      path: () => getRequestContext().path,
    }),
  ],
})
