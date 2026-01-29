import 'dotenv/config'

import { createBriqpayCustomTypeForPostDeploy } from './post-deploy-actions'
import { postDeployLogger } from './post-deploy-logger'

const logger = postDeployLogger

async function postDeploy() {
  const customTypeKey = process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY || 'briqpay-session-id'

  logger.info(
    { customTypeKey, envVarSet: !!process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY },
    `Starting post-deploy: creating/updating custom type with key "${customTypeKey}"`,
  )

  await createBriqpayCustomTypeForPostDeploy(customTypeKey)

  logger.info({ customTypeKey }, `Post-deploy completed successfully`)
}

async function runPostDeployScripts() {
  try {
    logger.info({}, 'Post-deploy script starting...')
    await postDeploy()
    logger.info({}, 'Post-deploy script completed successfully')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : undefined

    // Log to console so it appears in CT dashboard
    logger.error(
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
