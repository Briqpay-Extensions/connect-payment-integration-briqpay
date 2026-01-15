import 'dotenv/config'
import { validateEnvironment } from './config/env-validation'
import { appLogger } from './payment-sdk'
import { setupFastify } from './server/server'

void (async () => {
  // SECURITY: Validate environment variables before starting
  // This ensures the application doesn't run with missing or invalid configuration
  try {
    validateEnvironment()
  } catch (error) {
    appLogger.error({ error: error instanceof Error ? error.message : error }, 'Environment validation failed')
    process.exit(1)
  }

  // // This may be needed to uncomment for local development in case the type does not exist on your account,
  // // will be taken care of by postDeploy if deployed to Commerce Tools
  // // Initialize Briqpay custom type
  // await createBriqpayCustomType(process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY as string)
  // await updateType(process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY as string)

  const server = await setupFastify()

  const HOST = '0.0.0.0'
  try {
    await server.listen({
      port: Number(process.env.PORT || 8080),
      host: HOST,
    })
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
})()
