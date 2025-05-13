import { beforeEach, describe, expect, jest, test } from "@jest/globals";

import { BriqpayPaymentEnabler } from "../../src/payment-enabler/payment-enabler-briqpay";
import { DropinType } from "../../src/payment-enabler/payment-enabler";

describe("BriqpayPaymentEnabler", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        json: async () => ({
          snippet: "<div></div>",
          briqpaySessionId: "abc123",
          environment: "test",
        }),
      } as Response)
    ) as typeof fetch;
  });

  test('should create a BriqpayBuilder for type "briqpay"', async () => {
    const enabler = new BriqpayPaymentEnabler({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
      onComplete: jest.fn(),
      onError: jest.fn(),
    });

    const builder = await enabler.createComponentBuilder("briqpay");
    expect(builder).toBeDefined();
    expect(builder.constructor.name).toBe("BriqpayBuilder");
  });

  test("should throw for unsupported component type", async () => {
    const enabler = new BriqpayPaymentEnabler({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
      onComplete: jest.fn(),
      onError: jest.fn(),
    });

    await expect(enabler.createComponentBuilder("unsupported")).rejects.toThrow(
      /Component type not supported/
    );
  });

  test('should create a DropinEmbeddedBuilder for type "embedded"', async () => {
    const enabler = new BriqpayPaymentEnabler({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
      onComplete: jest.fn(),
      onError: jest.fn(),
    });

    const builder = await enabler.createDropinBuilder(DropinType.embedded);
    expect(builder).toBeDefined();
    expect(builder.constructor.name).toBe("DropinEmbeddedBuilder");
  });

  test("should throw for unsupported dropin type", async () => {
    const enabler = new BriqpayPaymentEnabler({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
      onComplete: jest.fn(),
      onError: jest.fn(),
    });

    await expect(
      enabler.createDropinBuilder("unsupported" as any)
    ).rejects.toThrow(/Component type not supported/);
  });

  test("should propagate error if fetch fails", async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("Fetch failed"))
    );

    const enabler = new BriqpayPaymentEnabler({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
      onComplete: jest.fn(),
      onError: jest.fn(),
    });

    await expect(enabler.createComponentBuilder("briqpay")).rejects.toThrow(
      "Fetch failed"
    );
  });

  test("should use default onComplete/onError when not provided", async () => {
    const enabler = new BriqpayPaymentEnabler({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
    });

    const builder = await enabler.createComponentBuilder("briqpay");
    expect(builder).toBeDefined();
  });
});
