import 'dotenv/config'
import { setupFastify } from './server/server'
import { createBriqpayCustomType } from './connectors/actions'
;(async () => {
  // Initialize Briqpay custom type
  await createBriqpayCustomType()

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
