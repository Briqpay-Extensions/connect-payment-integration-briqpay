import { beforeEach, describe, expect, jest, test } from "@jest/globals";

import { BriqpayPaymentEnabler } from "../../src/payment-enabler/payment-enabler-briqpay";
import { DropinType } from "../../src/payment-enabler/payment-enabler";

describe("BriqpayPaymentEnabler", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        // eslint-disable-next-line @typescript-eslint/require-await
        text: async () =>
          JSON.stringify({
            snippet: "<div></div>",
            briqpaySessionId: "abc123",
          }),
      } as Response),
    ) as typeof fetch;
  });

  test('should create a BriqpayBuilder for type "briqpay"', async () => {
    const enabler = await BriqpayPaymentEnabler.create({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
      onComplete: jest.fn() as jest.MockedFunction<
        import("../../src/payment-enabler/payment-enabler").PaymentResult extends infer T
          ? (_result: T) => void | Promise<void>
          : never
      >,
      onError: jest.fn() as jest.MockedFunction<
        (
          _error: unknown,
          _context?: { paymentReference?: string },
        ) => void | Promise<void>
      >,
    });

    const builder = await enabler.createComponentBuilder("briqpay");
    expect(builder).toBeDefined();
    expect(builder.constructor.name).toBe("BriqpayBuilder");

    await expect(enabler.createComponentBuilder("unsupported")).rejects.toThrow(
      /Component type not supported/,
    );
  });

  test("should throw for unsupported component type", async () => {
    const enabler = await BriqpayPaymentEnabler.create({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
      onComplete: jest.fn() as jest.MockedFunction<
        import("../../src/payment-enabler/payment-enabler").PaymentResult extends infer T
          ? (_result: T) => void | Promise<void>
          : never
      >,
      onError: jest.fn() as jest.MockedFunction<
        (
          _error: unknown,
          _context?: { paymentReference?: string },
        ) => void | Promise<void>
      >,
    });

    await expect(enabler.createComponentBuilder("unsupported")).rejects.toThrow(
      /Component type not supported/,
    );
  });

  test('should create a DropinEmbeddedBuilder for type "embedded"', async () => {
    const enabler = await BriqpayPaymentEnabler.create({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
      onComplete: jest.fn() as jest.MockedFunction<
        import("../../src/payment-enabler/payment-enabler").PaymentResult extends infer T
          ? (_result: T) => void | Promise<void>
          : never
      >,
      onError: jest.fn() as jest.MockedFunction<
        (
          _error: unknown,
          _context?: { paymentReference?: string },
        ) => void | Promise<void>
      >,
    });

    const builder = await enabler.createDropinBuilder(DropinType._embedded);
    expect(builder).toBeDefined();
    expect(builder.constructor.name).toBe("DropinEmbeddedBuilder");
  });

  test("should throw for unsupported dropin type", async () => {
    const enabler = await BriqpayPaymentEnabler.create({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
      onComplete: jest.fn() as jest.MockedFunction<
        import("../../src/payment-enabler/payment-enabler").PaymentResult extends infer T
          ? (_result: T) => void | Promise<void>
          : never
      >,
      onError: jest.fn() as jest.MockedFunction<
        (
          _error: unknown,
          _context?: { paymentReference?: string },
        ) => void | Promise<void>
      >,
    });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      enabler.createDropinBuilder("_unsupported" as any),
    ).rejects.toThrow(/Component type not supported/);
  });

  test('should create a DropinEmbeddedBuilder for type "briqpay"', async () => {
    const enabler = await BriqpayPaymentEnabler.create({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
      onComplete: jest.fn() as jest.MockedFunction<
        import("../../src/payment-enabler/payment-enabler").PaymentResult extends infer T
          ? (_result: T) => void | Promise<void>
          : never
      >,
      onError: jest.fn() as jest.MockedFunction<
        (
          _error: unknown,
          _context?: { paymentReference?: string },
        ) => void | Promise<void>
      >,
    });

    const builder = await enabler.createDropinBuilder(DropinType._briqpay);
    expect(builder).toBeDefined();
    expect(builder.constructor.name).toBe("DropinEmbeddedBuilder");
  });

  test("should propagate error if fetch fails", async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("Fetch failed")),
    );

    const enabler = await BriqpayPaymentEnabler.create({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
      onComplete: jest.fn() as jest.MockedFunction<
        import("../../src/payment-enabler/payment-enabler").PaymentResult extends infer T
          ? (_result: T) => void | Promise<void>
          : never
      >,
      onError: jest.fn() as jest.MockedFunction<
        (
          _error: unknown,
          _context?: { paymentReference?: string },
        ) => void | Promise<void>
      >,
    });

    await expect(enabler.createComponentBuilder("briqpay")).rejects.toThrow(
      "Fetch failed",
    );
  });

  test("should throw the real error when /config responds with a non-ok status", async () => {
    // Mirrors the processor's actual error-handler wire shape (error-handler.ts
    // handleAuthError) for an expired CT session: resolves fine, ok: false.
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 401,
        // eslint-disable-next-line @typescript-eslint/require-await
        text: async () =>
          JSON.stringify({
            message: "Session is not active",
            statusCode: 401,
            errors: [
              { code: "invalid_token", message: "Session is not active" },
            ],
            error: "invalid_token",
            error_description: "Session is not active",
          }),
      } as Response),
    ) as typeof fetch;

    // create() resolves synchronously (it wraps the setup promise, it doesn't await
    // it) - the rejection only surfaces once something actually consumes setupData,
    // same as the "fetch fails" case above.
    const enabler = await BriqpayPaymentEnabler.create({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
    });

    // The thrown error must stay structurally identifiable (statusCode/code), not
    // a bare message string - integrators key session-recovery on the 401.
    await expect(
      enabler.createComponentBuilder("briqpay"),
    ).rejects.toMatchObject({
      name: "BriqpayProcessorError",
      message: "Session is not active",
      statusCode: 401,
      code: "invalid_token",
    });
  });

  test("should throw a structured error when /config responds with a non-JSON body", async () => {
    // An infra-level failure (proxy/ingress 502) serves HTML, not the processor's
    // JSON error shape. That must still surface as a BriqpayConfigError with the
    // HTTP status, not as a bare JSON.parse SyntaxError.
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 502,
        // eslint-disable-next-line @typescript-eslint/require-await
        text: async () => "<html><body>502 Bad Gateway</body></html>",
      } as Response),
    ) as typeof fetch;

    const enabler = await BriqpayPaymentEnabler.create({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
    });

    await expect(
      enabler.createComponentBuilder("briqpay"),
    ).rejects.toMatchObject({
      name: "BriqpayProcessorError",
      statusCode: 502,
    });
  });

  test("should use default onComplete/onError when not provided", async () => {
    const enabler = await BriqpayPaymentEnabler.create({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
    });

    const builder = await enabler.createDropinBuilder(DropinType._embedded);
    expect(builder).toBeDefined();
  });
});
