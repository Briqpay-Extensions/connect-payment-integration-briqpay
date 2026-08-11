/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
  DropinComponents,
  DropinEmbeddedBuilder,
} from "../../src/dropin/dropin-embedded";
import { DropinOptions } from "../../src/payment-enabler/payment-enabler";
import {
  BRIQPAY_DECISION,
  BRIQPAY_REJECT_TYPE,
  BriqpaySdk,
  registerBriqpayDecision,
} from "../../src/briqpay-sdk";

describe("DropinEmbeddedBuilder", () => {
  // Mock fetch
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => ({ paymentReference: "ref-123" }),
    } as unknown as Response),
  ) as unknown as typeof fetch;

  beforeEach(() => {
    delete (window as any).briqpayConnector;
  });

  test("should create DropinComponents with correct config", () => {
    const baseOptions = { sdk: {} } as any;
    const builder = new DropinEmbeddedBuilder(baseOptions);

    const config: DropinOptions = {
      onDropinReady: jest.fn<any>().mockResolvedValue(undefined), // Mock it to return a Promise
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
  beforeEach(() => {
    delete (window as any).briqpayConnector;
  });

  test("should initialize with given options", () => {
    const config: DropinOptions = {
      onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
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
  test("handleDecision sends an allow decision when no decision handler is registered", async () => {
    (global.fetch as jest.Mock).mockClear();
    window._briqpay = {
      subscribe: jest.fn(),
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
    };

    // Deliberately does not call registerBriqpayDecision(), to exercise the
    // default-allow fallback for a merchant who never registered a handler.
    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
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

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:8080/decision",
      expect.objectContaining({
        body: JSON.stringify({
          sessionId: "abc123",
          decision: BRIQPAY_DECISION.ALLOW,
        }),
      }),
    );
    // suspend() is intentionally NOT called here - Briqpay auto-suspends the
    // widget itself for make_decision; only resumeDecision() is our job.
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
  });

  test("handleDecision calls the registered decision handler and sends its returned answer", async () => {
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
    registerBriqpayDecision(onDecision);

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
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

  test("handleDecision resumes without sending when the registered handler returns an invalid answer", async () => {
    window._briqpay = {
      subscribe: jest.fn(),
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
    };

    const onDecision = jest.fn<any>().mockResolvedValue({ decision: "maybe" });
    registerBriqpayDecision(onDecision);
    (global.fetch as jest.Mock).mockClear();

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
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
  test("handleDecision abandons the decision when the registered handler never resolves", async () => {
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
    registerBriqpayDecision(onDecision);

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
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
  test("handleDecision abandons the decision when the registered handler throws", async () => {
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
    registerBriqpayDecision(onDecision);
    (global.fetch as jest.Mock).mockClear();

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
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

  // resumeDecision() unblocks Briqpay's own pay-button flow, so it must run
  // even when the /decision POST itself fails - a merchant's network blip
  // must not leave the widget stuck forever.
  test("handleDecision still resumes when sendDecision's fetch itself rejects", async () => {
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
      .mockResolvedValue({ decision: BRIQPAY_DECISION.ALLOW });
    registerBriqpayDecision(onDecision);
    (global.fetch as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("network down")),
    );

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
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

    // handleDecision has no catch of its own around sendDecision, so the
    // fetch failure propagates - the finally must still have run first.
    await expect(dropin.handleDecision({})).rejects.toThrow("network down");
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
  });

  test("handleDecision sends a notify_user rejection with its softErrors and rejectionType", async () => {
    window._briqpay = {
      subscribe: jest.fn(),
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
    };

    const onDecision = jest.fn<any>().mockResolvedValue({
      decision: BRIQPAY_DECISION.REJECT,
      rejectionType: BRIQPAY_REJECT_TYPE.NOTIFY_USER,
      softErrors: [{ message: "Please update your billing address" }],
    });
    registerBriqpayDecision(onDecision);
    (global.fetch as jest.Mock).mockClear();

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
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

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:8080/decision",
      expect.objectContaining({
        body: JSON.stringify({
          sessionId: "abc123",
          decision: BRIQPAY_DECISION.REJECT,
          rejectionType: BRIQPAY_REJECT_TYPE.NOTIFY_USER,
          softErrors: [{ message: "Please update your billing address" }],
        }),
      }),
    );
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
  });

  test("handleDecision sends a reject_session_with_error rejection with its hardError", async () => {
    window._briqpay = {
      subscribe: jest.fn(),
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
    };

    const onDecision = jest.fn<any>().mockResolvedValue({
      decision: BRIQPAY_DECISION.REJECT,
      rejectionType: BRIQPAY_REJECT_TYPE.REJECT_WITH_ERROR,
      hardError: { message: "This purchase cannot be completed." },
    });
    registerBriqpayDecision(onDecision);
    (global.fetch as jest.Mock).mockClear();

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
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

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:8080/decision",
      expect.objectContaining({
        body: JSON.stringify({
          sessionId: "abc123",
          decision: BRIQPAY_DECISION.REJECT,
          rejectionType: BRIQPAY_REJECT_TYPE.REJECT_WITH_ERROR,
          hardError: { message: "This purchase cannot be completed." },
        }),
      }),
    );
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
  });

  // Documents a real gap: submit() has no re-entrancy guard, so if Briqpay
  // (or a flaky network layer) redelivers session_complete, the enabler
  // will POST /payments a second time instead of no-op'ing.
  test("session_complete firing twice invokes submit() twice (no idempotency guard)", () => {
    window._briqpay = {
      subscribe: jest.fn(),
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
    };

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
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

    const submitSpy = jest.spyOn(dropin, "submit").mockResolvedValue(undefined);

    (dropin as any).subscribeToEvents();
    const sessionCompleteHandler = (
      window._briqpay.subscribe as jest.Mock
    ).mock.calls.find((call: any) => call[0] === "session_complete")?.[1] as (
      data: Record<string, unknown>,
    ) => void;

    sessionCompleteHandler({});
    sessionCompleteHandler({});

    expect(submitSpy).toHaveBeenCalledTimes(2);
  });
});
