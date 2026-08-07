/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, jest, test } from "@jest/globals";
import {
  DropinComponents,
  DropinEmbeddedBuilder,
} from "../../src/dropin/dropin-embedded";
import { DropinOptions } from "../../src/payment-enabler/payment-enabler";
import { BRIQPAY_DECISION, BriqpaySdk } from "../../src/briqpay-sdk";

describe("DropinEmbeddedBuilder", () => {
  // Mock fetch
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => ({ paymentReference: "ref-123" }),
    } as unknown as Response),
  ) as unknown as typeof fetch;

  test("should create DropinComponents with correct config", () => {
    const baseOptions = { sdk: {} } as any;
    const builder = new DropinEmbeddedBuilder(baseOptions);

    const config: DropinOptions = {
      onDropinReady: jest.fn<any>().mockResolvedValue(undefined), // Mock it to return a Promise
      onDecision: jest
        .fn<any>()
        .mockResolvedValue({ decision: BRIQPAY_DECISION.ALLOW }),
    };

    const dropin = builder.build(config);

    expect(dropin).toBeInstanceOf(DropinComponents);
    expect((dropin as any)["dropinOptions"].onDropinReady).toBe(
      config.onDropinReady,
    );
  });

  test("should set dropinHasSubmit to false since Briqpay iframe handles its own submit", () => {
    const builder = new DropinEmbeddedBuilder({} as any);
    expect(builder.dropinHasSubmit).toBe(false);
  });
});

describe("DropinComponents", () => {
  test("should initialize with given options", () => {
    const config: DropinOptions = {
      onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
      onDecision: jest
        .fn<any>()
        .mockResolvedValue({ decision: BRIQPAY_DECISION.ALLOW }),
    };
    const dropin = new DropinComponents(
      { dropinOptions: config },
      {
        processorUrl: "http://localhost:8080",
        sessionId: "123",
        briqpaySessionId: "abc123",
        snippet: "Dropin Embedded",
        sdk: {} as BriqpaySdk,
        environment: "test",
        onComplete: () => {},
        onError: () => {},
      },
    );

    dropin.init();

    expect(config.onDropinReady).toHaveBeenCalled();
  });

  test("should mount content in the specified selector", () => {
    const div = document.createElement("div");
    div.id = "test-div";
    document.body.appendChild(div);

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
          onDecision: jest
            .fn<any>()
            .mockResolvedValue({ decision: BRIQPAY_DECISION.ALLOW }),
        },
      },
      {
        processorUrl: "http://localhost:8080",
        sessionId: "123",
        briqpaySessionId: "abc123",
        snippet: "Dropin Embedded",
        sdk: {} as BriqpaySdk,
        environment: "test",
        onComplete: () => {},
        onError: () => {},
      },
    );

    dropin.mount("#" + div.id);

    expect(div.innerHTML).toBe("Dropin Embedded");
  });

  test("submit() should not throw an error", async () => {
    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
          onDecision: jest
            .fn<any>()
            .mockResolvedValue({ decision: BRIQPAY_DECISION.ALLOW }),
        },
      },
      {
        processorUrl: "http://localhost:8080",
        sessionId: "123",
        briqpaySessionId: "abc123",
        snippet: "Dropin Embedded",
        sdk: {} as BriqpaySdk,
        environment: "test",
        onComplete: () => {},
        onError: () => {},
      },
    );

    await expect(dropin.submit()).resolves.not.toThrow();
  });

  test("submit() should throw an error", async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("Fetch failed")),
    );

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
          onDecision: jest
            .fn<any>()
            .mockResolvedValue({ decision: BRIQPAY_DECISION.ALLOW }),
        },
      },
      {
        processorUrl: "http://localhost:8080",
        sessionId: "123",
        briqpaySessionId: "abc123",
        snippet: "Dropin Embedded",
        sdk: {} as BriqpaySdk,
        environment: "test",
        onComplete: () => {},
        onError: () => {},
      },
    );

    await expect(dropin.submit()).rejects.toThrow();
  });

  // Allowing would record an approval no merchant made.
  test("handleDecision sends nothing when no onDecision is configured", async () => {
    (global.fetch as jest.Mock).mockClear();
    window._briqpay = {
      subscribe: jest.fn(),
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
    };

    // Deliberately bypasses the DropinOptions type (which now requires
    // onDecision) to simulate a plain-JS/untyped caller that omits it, and
    // exercise the runtime defensive fallback rather than the type check.
    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
        } as unknown as DropinOptions,
      },
      {
        processorUrl: "http://localhost:8080",
        sessionId: "123",
        briqpaySessionId: "abc123",
        snippet: "Dropin Embedded",
        sdk: {} as BriqpaySdk,
        environment: "test",
        onComplete: () => {},
        onError: () => {},
      },
    );

    await expect(dropin.handleDecision({})).resolves.not.toThrow();

    expect(global.fetch).not.toHaveBeenCalledWith(
      "http://localhost:8080/decision",
      expect.anything(),
    );
    // suspend() is intentionally NOT called here - Briqpay auto-suspends the
    // widget itself for make_decision; only resumeDecision() is our job.
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
  });

  test("handleDecision calls onDecision and sends its returned answer", async () => {
    window._briqpay = {
      subscribe: jest.fn(),
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
    };

    const sdk = {} as BriqpaySdk;
    const onDecision = jest.fn<any>().mockResolvedValue({
      decision: BRIQPAY_DECISION.REJECT,
      softErrors: [{ message: "please retry" }],
    });

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
          onDecision,
        },
      },
      {
        processorUrl: "http://localhost:8080",
        sessionId: "123",
        briqpaySessionId: "abc123",
        snippet: "Dropin Embedded",
        sdk,
        environment: "test",
        onComplete: () => {},
        onError: () => {},
      },
    );

    await dropin.handleDecision({ orderData: {} });

    expect(onDecision).toHaveBeenCalledWith(sdk, { orderData: {} });
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:8080/decision",
      expect.objectContaining({
        body: JSON.stringify({
          sessionId: "abc123",
          decision: BRIQPAY_DECISION.REJECT,
          softErrors: [{ message: "please retry" }],
        }),
      }),
    );
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
  });

  test("handleDecision resumes without sending when onDecision returns an invalid answer", async () => {
    window._briqpay = {
      subscribe: jest.fn(),
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
    };

    const onDecision = jest.fn<any>().mockResolvedValue({ decision: "maybe" });
    (global.fetch as jest.Mock).mockClear();

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
          onDecision,
        },
      },
      {
        processorUrl: "http://localhost:8080",
        sessionId: "123",
        briqpaySessionId: "abc123",
        snippet: "Dropin Embedded",
        sdk: {} as BriqpaySdk,
        environment: "test",
        onComplete: () => {},
        onError: () => {},
      },
    );

    await dropin.handleDecision({});

    expect(global.fetch).not.toHaveBeenCalledWith(
      "http://localhost:8080/decision",
      expect.anything(),
    );
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
  });

  // Must settle rather than stay pending forever, and send nothing once it does.
  test("handleDecision abandons the decision when onDecision never resolves", async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockClear();

    window._briqpay = {
      subscribe: jest.fn(),
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
    };

    const onDecision = jest.fn<any>().mockReturnValue(new Promise(() => {}));

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
          onDecision,
        },
      },
      {
        processorUrl: "http://localhost:8080",
        sessionId: "123",
        briqpaySessionId: "abc123",
        snippet: "Dropin Embedded",
        sdk: {} as BriqpaySdk,
        environment: "test",
        onComplete: () => {},
        onError: () => {},
      },
    );

    const settled = jest.fn();
    void dropin.handleDecision({}).then(settled, settled);

    await jest.advanceTimersByTimeAsync(20000);

    expect(settled).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalledWith(
      "http://localhost:8080/decision",
      expect.anything(),
    );
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();

    jest.useRealTimers();
  });

  // A throw is not an answer, and must not reject out of the subscriber.
  test("handleDecision abandons the decision when onDecision throws", async () => {
    window._briqpay = {
      subscribe: jest.fn(),
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
    };

    const onDecision = jest
      .fn<any>()
      .mockRejectedValue(new Error("validation blew up"));
    (global.fetch as jest.Mock).mockClear();

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
          onDecision,
        },
      },
      {
        processorUrl: "http://localhost:8080",
        sessionId: "123",
        briqpaySessionId: "abc123",
        snippet: "Dropin Embedded",
        sdk: {} as BriqpaySdk,
        environment: "test",
        onComplete: () => {},
        onError: () => {},
      },
    );

    await expect(dropin.handleDecision({})).resolves.not.toThrow();

    expect(global.fetch).not.toHaveBeenCalledWith(
      "http://localhost:8080/decision",
      expect.anything(),
    );
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
  });
});
