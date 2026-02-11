import autoLoad from '@fastify/autoload'
import cors from '@fastify/cors'
import fastifyFormBody from '@fastify/formbody'
import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { join } from 'path'
import { config } from '../config/config'
import { requestContextPlugin } from '../libs/fastify/context/context'
import { errorHandler } from '../libs/fastify/error-handler'
import { matchOriginPattern } from '../libs/utils/origin-matching'

/**
 * Setup Fastify server instance
 * @returns
 */
export const setupFastify = async () => {
  // Create fastify server instance
  const server = Fastify({
    logger: {
      level: config.loggerLevel,
    },
    genReqId: () => randomUUID().toString(),
    requestIdLogLabel: 'requestId',
    requestIdHeader: 'x-request-id',
  })

  // Setup error handler
  server.setErrorHandler(errorHandler)

  // Enable CORS with secure configuration
  // SECURITY: Restrict origins in production, allow all only in development
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()) || []
  const hasAllowedOrigins = allowedOrigins.length > 0
  await server.register(cors, {
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID', 'X-Request-ID', 'X-Session-ID'],
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true)
        return
      }

      if (!hasAllowedOrigins) {
        callback(null, false)
        return
      }

      callback(
        null,
        allowedOrigins.some((pattern) => matchOriginPattern(pattern, origin)),
      )
    },
    credentials: true,
  })

  // SECURITY: Request logging for audit trails
  // eslint-disable-next-line @typescript-eslint/require-await
  server.addHook('onRequest', async (request) => {
    // Log security-relevant request information
    request.log.info(
      {
        audit: true,
        method: request.method,
        url: request.url,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        correlationId: request.headers['x-correlation-id'],
        sessionId: request.headers['x-session-id'] ? '[PRESENT]' : '[ABSENT]',
        origin: request.headers['origin'],
      },
      'Incoming request',
    )
  })

  // SECURITY: Response logging for audit trails
  server.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        audit: true,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
        ip: request.ip,
      },
      'Request completed',
    )
  })

  // SECURITY: Add security headers
  server.addHook('onSend', async (request, reply) => {
    // Prevent clickjacking
    reply.header('X-Frame-Options', 'DENY')
    // Prevent MIME type sniffing
    reply.header('X-Content-Type-Options', 'nosniff')
    // Enable XSS filter
    reply.header('X-XSS-Protection', '1; mode=block')
    // Strict transport security (HTTPS only)
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    // Referrer policy
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    // Content Security Policy
    reply.header('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'")
    // Permissions policy
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
  })

  // Add content type parser for the content type application/x-www-form-urlencoded
  await server.register(fastifyFormBody)

  // Add raw body support for webhook HMAC verification
  // This stores the raw request body for signature verification
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      // Store raw body on request for HMAC verification
      ;(req as unknown as { rawBody: string }).rawBody = body as string
      const json = JSON.parse(body as string)
      done(null, json)
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  // Register context plugin
  await server.register(requestContextPlugin)

  await server.register(autoLoad, {
    dir: join(__dirname, 'plugins'),
  })

  return server
}
