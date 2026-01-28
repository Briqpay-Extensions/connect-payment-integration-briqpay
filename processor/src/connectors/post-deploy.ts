import 'dotenv/config'

import { createBriqpayCustomType } from './actions'
import { appLogger } from '../payment-sdk'

async function postDeploy() {
  const customTypeKey = process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY || 'briqpay-session-id'

  appLogger.info(
    { customTypeKey, envVarSet: !!process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY },
    `Starting post-deploy: creating/updating custom type with key "${customTypeKey}"`,
  )

  await createBriqpayCustomType(customTypeKey)

  appLogger.info({ customTypeKey }, `Post-deploy completed successfully`)
}

async function runPostDeployScripts() {
  try {
    await postDeploy()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : undefined

    // Log to appLogger so it appears in CT dashboard
    appLogger.error(
      {
        error: errorMessage,
        stack: errorStack,
        phase: 'post-deploy',
      },
      `Post-deploy failed: ${errorMessage}`,
    )

    // Also write to stderr for CI/CD logs
    process.stderr.write(`Post-deploy failed: ${errorMessage}\n`)
    if (errorStack) {
      process.stderr.write(`Stack: ${errorStack}\n`)
    }

    process.exitCode = 1
  }
}

void runPostDeployScripts()
