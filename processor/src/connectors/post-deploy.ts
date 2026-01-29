import 'dotenv/config'

import { type AuthMiddlewareOptions, ClientBuilder, type HttpMiddlewareOptions } from '@commercetools/ts-client'
import {
  createApiBuilderFromCtpClient,
  type FieldDefinition,
  type Type,
  type TypeAddFieldDefinitionAction,
} from '@commercetools/platform-sdk'

// ============================================================================
// Configuration - read directly from environment variables
// ============================================================================
const projectKey = process.env.CTP_PROJECT_KEY || ''
const clientId = process.env.CTP_CLIENT_ID || ''
const clientSecret = process.env.CTP_CLIENT_SECRET || ''
const authUrl = process.env.CTP_AUTH_URL || 'https://auth.europe-west1.gcp.commercetools.com'
const apiUrl = process.env.CTP_API_URL || 'https://api.europe-west1.gcp.commercetools.com'
const customTypeKey = process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY || 'briqpay-session-id'

// ============================================================================
// Field Definitions - duplicated here to avoid importing from custom-types.ts
// which might have transitive dependencies that cause issues
// ============================================================================
interface BriqpayFieldDef {
  name: string
  label: string
  required: boolean
}

const briqpayFields: BriqpayFieldDef[] = [
  {
    name: process.env.BRIQPAY_SESSION_CUSTOM_TYPE_KEY || 'briqpay-session-id',
    label: 'Briqpay Session ID',
    required: false,
  },
  {
    name:
      process.env.BRIQPAY_PSP_META_DATA_CUSTOMER_FACING_REFERENCE_KEY ||
      'briqpay-psp-meta-data-customer-facing-reference',
    label: 'Briqpay PSP Customer Facing Reference',
    required: false,
  },
  {
    name: process.env.BRIQPAY_PSP_META_DATA_DESCRIPTION_KEY || 'briqpay-psp-meta-data-description',
    label: 'Briqpay PSP Description',
    required: false,
  },
  {
    name: process.env.BRIQPAY_PSP_META_DATA_TYPE_KEY || 'briqpay-psp-meta-data-type',
    label: 'Briqpay PSP Type',
    required: false,
  },
  {
    name: process.env.BRIQPAY_PSP_META_DATA_PAYER_EMAIL_KEY || 'briqpay-psp-meta-data-payer-email',
    label: 'Briqpay PSP Payer Email',
    required: false,
  },
  {
    name: process.env.BRIQPAY_PSP_META_DATA_PAYER_FIRST_NAME_KEY || 'briqpay-psp-meta-data-payer-first-name',
    label: 'Briqpay PSP Payer First Name',
    required: false,
  },
  {
    name: process.env.BRIQPAY_PSP_META_DATA_PAYER_LAST_NAME_KEY || 'briqpay-psp-meta-data-payer-last-name',
    label: 'Briqpay PSP Payer Last Name',
    required: false,
  },
  {
    name: process.env.BRIQPAY_TRANSACTION_DATA_RESERVATION_ID_KEY || 'briqpay-transaction-data-reservation-id',
    label: 'Briqpay Transaction Reservation ID',
    required: false,
  },
  {
    name:
      process.env.BRIQPAY_TRANSACTION_DATA_SECONDARY_RESERVATION_ID_KEY ||
      'briqpay-transaction-data-secondary-reservation-id',
    label: 'Briqpay Transaction Secondary Reservation ID',
    required: false,
  },
  {
    name: process.env.BRIQPAY_TRANSACTION_DATA_PSP_ID_KEY || 'briqpay-transaction-data-psp-id',
    label: 'Briqpay Transaction PSP ID',
    required: false,
  },
  {
    name: process.env.BRIQPAY_TRANSACTION_DATA_PSP_DISPLAY_NAME_KEY || 'briqpay-transaction-data-psp-display-name',
    label: 'Briqpay Transaction PSP Display Name',
    required: false,
  },
  {
    name:
      process.env.BRIQPAY_TRANSACTION_DATA_PSP_INTEGRATION_NAME_KEY || 'briqpay-transaction-data-psp-integration-name',
    label: 'Briqpay Transaction PSP Integration Name',
    required: false,
  },
]

// ============================================================================
// Helper Functions
// ============================================================================
function toFieldDefinition(field: BriqpayFieldDef): FieldDefinition {
  return {
    name: field.name,
    label: { en: field.label },
    type: { name: 'String' },
    required: field.required,
    inputHint: 'SingleLine',
  }
}

function createClient() {
  const authMiddlewareOptions: AuthMiddlewareOptions = {
    host: authUrl,
    projectKey,
    credentials: { clientId, clientSecret },
    scopes: [`manage_types:${projectKey}`, `view_types:${projectKey}`],
    httpClient: fetch,
  }

  const httpMiddlewareOptions: HttpMiddlewareOptions = {
    host: apiUrl,
    httpClient: fetch,
  }

  return new ClientBuilder()
    .withProjectKey(projectKey)
    .withClientCredentialsFlow(authMiddlewareOptions)
    .withHttpMiddleware(httpMiddlewareOptions)
    .build()
}

// ============================================================================
// Main Post-Deploy Logic
// ============================================================================
async function createOrUpdateCustomType(): Promise<void> {
  // Validate required env vars
  if (!projectKey || !clientId || !clientSecret) {
    throw new Error(
      `Missing required environment variables: ${[
        !projectKey && 'CTP_PROJECT_KEY',
        !clientId && 'CTP_CLIENT_ID',
        !clientSecret && 'CTP_CLIENT_SECRET',
      ]
        .filter(Boolean)
        .join(', ')}`,
    )
  }

  const client = createClient()
  const apiRoot = createApiBuilderFromCtpClient(client).withProjectKey({ projectKey })

  // Check if type already exists with resourceTypeId 'order'
  const existingResponse = await apiRoot
    .types()
    .get({
      queryArgs: {
        where: `key="${customTypeKey}" and resourceTypeIds contains "order"`,
        limit: 1,
      },
    })
    .execute()

  const existingType = existingResponse.body.results[0] as Type | undefined

  if (existingType) {
    // Type exists - check for missing fields and add them
    const existingFieldNames = new Set(existingType.fieldDefinitions.map((f) => f.name))
    const missingFields = briqpayFields.filter((f) => !existingFieldNames.has(f.name))

    if (missingFields.length > 0) {
      const actions: TypeAddFieldDefinitionAction[] = missingFields.map((field) => ({
        action: 'addFieldDefinition',
        fieldDefinition: toFieldDefinition(field),
      }))

      await apiRoot
        .types()
        .withId({ ID: existingType.id })
        .post({
          body: {
            version: existingType.version,
            actions,
          },
        })
        .execute()
    }
  } else {
    // Type doesn't exist - create it with all fields
    const fieldDefinitions = briqpayFields.map(toFieldDefinition)

    await apiRoot
      .types()
      .post({
        body: {
          key: customTypeKey,
          name: { en: 'Briqpay Data' },
          resourceTypeIds: ['order'],
          fieldDefinitions,
        },
      })
      .execute()
  }
}

// ============================================================================
// Entry Point
// ============================================================================
async function runPostDeploy() {
  try {
    await createOrUpdateCustomType()
    process.exit(0)
  } catch (error) {
    process.stderr.write(`Post-deploy failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}

void runPostDeploy()
