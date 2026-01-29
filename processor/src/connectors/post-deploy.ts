import 'dotenv/config'
import { createBriqpayCustomType } from './actions'
import { appLogger } from '../payment-sdk'

// ============================================================================
// Configuration - read directly from environment variables
// ============================================================================
const customTypeKey = process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY || 'briqpay-session-id'

// ============================================================================
// Main Post-Deploy Logic
// ============================================================================
async function createOrUpdateCustomType(): Promise<void> {
  appLogger.info({ customTypeKey }, 'Running post-deploy: Ensuring Briqpay custom type fields exist')

  // Use the extension logic from actions.ts which handles:
  // 1. Finding Briqpay's own type
  // 2. Extending any existing 'order' type if Briqpay type doesn't exist
  // 3. Resolving field conflicts via prefixing
  // 4. Creating a new type if none exist
  await createBriqpayCustomType(customTypeKey)
}

// ============================================================================
// Entry Point
// ============================================================================
async function runPostDeploy() {
  try {
    await createOrUpdateCustomType()
    appLogger.info({}, 'Post-deploy completed successfully')
    process.exit(0)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Post-deploy failed: ${errorMessage}\n`)
    process.exit(1)
  }
}

void runPostDeploy()
