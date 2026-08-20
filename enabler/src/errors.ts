// Mirrors processor/src/libs/fastify/dtos/error.dto.ts ErrorResponse - not shared.
type BriqpayProcessorErrorResponse = {
  message: string;
  statusCode: number;
  errors: { code: string; message: string }[];
};

// Thrown when a processor request fails. Carries the HTTP status, error code and
// which request failed, so integrators can distinguish an expired CT session
// (401 invalid_token) from other failures and recover per endpoint.
export class BriqpayProcessorError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly request: string;

  constructor(
    message: string,
    statusCode: number,
    request: string,
    code?: string,
  ) {
    super(message);
    this.name = "BriqpayProcessorError";
    this.statusCode = statusCode;
    this.request = request;
    this.code = code;
  }
}

// The processor answers errors in its ErrorResponse JSON shape, but infra
// between the merchant page and the processor (e.g. a proxy 502) answers with
// HTML. Use the processor shape when present, fall back to the raw body.
export const toBriqpayProcessorError = (
  requestLabel: string,
  status: number,
  body: string,
): BriqpayProcessorError => {
  try {
    const parsed = JSON.parse(body) as Partial<BriqpayProcessorErrorResponse>;

    if (
      typeof parsed.message === "string" &&
      typeof parsed.statusCode === "number"
    ) {
      return new BriqpayProcessorError(
        parsed.message,
        parsed.statusCode,
        requestLabel,
        parsed.errors?.[0]?.code,
      );
    }
  } catch {
    // Not JSON - fall through to the raw-body error.
  }

  return new BriqpayProcessorError(
    `Briqpay ${requestLabel} request failed with status ${status}: ${body.slice(0, 200)}`,
    status,
    requestLabel,
  );
};
