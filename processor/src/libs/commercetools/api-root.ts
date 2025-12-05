import { createApiBuilderFromCtpClient } from '@commercetools/platform-sdk'
import { ctpClient } from './client'
import { config } from '../../config/config'

export const apiRoot = createApiBuilderFromCtpClient(ctpClient).withProjectKey({ projectKey: config.projectKey })
