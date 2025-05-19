import 'dotenv/config'

import { createBriqpayCustomType } from './actions'

interface IPostDeploy {
  BRIQPAY_SESSION_CUSTOM_TYPE_KEY: string
}

async function postDeploy({ BRIQPAY_SESSION_CUSTOM_TYPE_KEY = 'briqpay-session-id' }: IPostDeploy) {
  await createBriqpayCustomType(BRIQPAY_SESSION_CUSTOM_TYPE_KEY || 'briqpay-session-id')
}

async function runPostDeployScripts() {
  try {
    const _properties = new Map(Object.entries(process.env))
    await postDeploy({
      BRIQPAY_SESSION_CUSTOM_TYPE_KEY: _properties.get('BRIQPAY_SESSION_CUSTOM_TYPE_KEY') as string,
    })
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`Post-deploy failed: ${error.message}\n`)
    }
    process.exitCode = 1
  }
}

void runPostDeployScripts()
