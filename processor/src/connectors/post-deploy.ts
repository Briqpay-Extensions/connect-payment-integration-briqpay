import 'dotenv/config'

import { createBriqpayCustomType } from './actions'

async function postDeploy() {
  const customTypeKey = process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY || 'briqpay-session-id'
  await createBriqpayCustomType(customTypeKey)
}

async function runPostDeployScripts() {
  try {
    await postDeploy()
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`Post-deploy failed: ${error.message}\n`)
    }
    process.exitCode = 1
  }
}

void runPostDeployScripts()
