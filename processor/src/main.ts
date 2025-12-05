import 'dotenv/config'
import { setupFastify } from './server/server'

void (async () => {
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
