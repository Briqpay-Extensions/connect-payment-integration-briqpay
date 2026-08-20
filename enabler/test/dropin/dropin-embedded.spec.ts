/* eslint-disable @typescript-eslint/no-explicit-any */
import { get } from "https";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
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
      unsubscribe: jest.fn(),
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
      unsubscribe: jest.fn(),
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
      unsubscribe: jest.fn(),
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
      unsubscribe: jest.fn(),
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
      unsubscribe: jest.fn(),
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
      unsubscribe: jest.fn(),
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

    const onError = jest.fn<(_error: unknown) => void>();
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
        onComplete: () => {},
        onError,
      },
    );

    // The failure goes to onError, never an unhandled rejection - and the
    // resume must still have run so the widget is not stuck.
    await expect(dropin.handleDecision({})).resolves.not.toThrow();
    expect(onError).toHaveBeenCalledWith(new Error("network down"));
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
  });

  // Same expiry contract as /decision: a /payments 401 must reach onError as a
  // structured error (statusCode/code/request) so the integrator can recover -
  // and onComplete must not fire, since the payment record was never created.
  test("submit() routes a /payments 401 to onError as a structured error", async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({
            message: "Session is not active",
            statusCode: 401,
            errors: [
              { code: "invalid_token", message: "Session is not active" },
            ],
          }),
        text: () =>
          Promise.resolve(
            JSON.stringify({
              message: "Session is not active",
              statusCode: 401,
              errors: [
                { code: "invalid_token", message: "Session is not active" },
              ],
            }),
          ),
      } as unknown as Response),
    );

    const onComplete = jest.fn<() => void>();
    const onError = jest.fn<(_error: unknown) => void>();
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
        onComplete,
        onError,
      },
    );

    // The caller awaited submit(), so the failure belongs to that promise -
    // onError is for failures nobody is waiting on (see session_complete below).
    await expect(dropin.submit()).rejects.toMatchObject({
      name: "BriqpayProcessorError",
      statusCode: 401,
      code: "invalid_token",
      request: "/payments",
    });

    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  // session_complete fires from Briqpay's widget: no caller to reject to, so
  // this is exactly when the global onError callback is the right surface.
  test("a session_complete-triggered submit routes a /payments 401 to onError", async () => {
    window._briqpay = {
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
    };

    (global.fetch as jest.Mock).mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              message: "Session is not active",
              statusCode: 401,
              errors: [
                { code: "invalid_token", message: "Session is not active" },
              ],
            }),
          ),
      } as unknown as Response),
    );

    const onError = jest.fn<(_error: unknown) => void>();
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
        onComplete: () => {},
        onError,
      },
    );

    (dropin as any).subscribeToEvents();
    const sessionCompleteHandler = (
      window._briqpay.subscribe as jest.Mock
    ).mock.calls.find((call: any) => call[0] === "session_complete")?.[1] as (
      data: Record<string, unknown>,
    ) => void;

    sessionCompleteHandler({});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "BriqpayProcessorError",
        statusCode: 401,
        code: "invalid_token",
        request: "/payments",
      }),
    );
  });

  // An expired CT session (fixed ~1h TTL) makes the processor 401 the decision.
  // Swallowing that leaves the buyer permanently stuck: every retry reuses the
  // dead session, and only a full page reload recovers. The integrator's onError
  // must receive the structured error so it can mint a fresh session and remount.
  test("handleDecision routes a /decision 401 to onError as a structured error", async () => {
    window._briqpay = {
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
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
    );

    const onError = jest.fn<(_error: unknown) => void>();
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
        onComplete: () => {},
        onError,
      },
    );

    await dropin.handleDecision({});

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "BriqpayProcessorError",
        statusCode: 401,
        code: "invalid_token",
      }),
    );
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
  });

  test("handleDecision sends a notify_user rejection with its softErrors and rejectionType", async () => {
    window._briqpay = {
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
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
      unsubscribe: jest.fn(),
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
      unsubscribe: jest.fn(),
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

// Runs against the deployed briq SDK (downloaded from playground), not a mock:
// the subscribe/publish/unsubscribe semantics under test are Briqpay's own.
describe("DropinComponents remounting against the real briq SDK", () => {
  const BRIQ_SDK_URL = "https://playground-api.briqpay.com/briq.min.js";

  let briqSdkSource: string;

  beforeAll(async () => {
    briqSdkSource = await new Promise<string>(
      (resolvePromise, rejectPromise) => {
        get(BRIQ_SDK_URL, (res) => {
          if (res.statusCode !== 200) {
            rejectPromise(
              new Error(
                `Failed to download the briq SDK from ${BRIQ_SDK_URL}: HTTP ${res.statusCode}`,
              ),
            );
            return;
          }

          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolvePromise(body));
        }).on("error", rejectPromise);
      },
    );
  }, 15000);

  beforeEach(() => {
    // The SDK's own double-load guard would skip re-init, so clear it first.
    delete (window as any)._briqpay;
    // eslint-disable-next-line sonarjs/code-eval
    new Function(briqSdkSource)();

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => ({ paymentReference: "ref-123" }),
      } as unknown as Response),
    ) as unknown as typeof fetch;

    delete (window as any).briqpayConnector;
    document.body.innerHTML = "";
    document.head
      .querySelectorAll("script")
      .forEach((script) => script.remove());
  });

  const makeDropin = () =>
    new DropinComponents(
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
        onComplete: () => {},
        onError: () => {},
      },
    );

  test("a remount does not stack session_complete handlers - one completion, one submit", () => {
    // Remount = a new component subscribing on the already-loaded SDK. The old
    // handlers must not survive, or one completion POSTs /payments per remount.
    const first = makeDropin();
    const second = makeDropin();

    const firstSubmit = jest
      .spyOn(first, "submit")
      .mockResolvedValue(undefined);
    const secondSubmit = jest
      .spyOn(second, "submit")
      .mockResolvedValue(undefined);

    (first as any).subscribeToEvents();
    (second as any).subscribeToEvents();

    (window as any)._briqpay.publish("session_complete", {});

    expect(firstSubmit.mock.calls.length + secondSubmit.mock.calls.length).toBe(
      1,
    );
  });

  test("a remount does not stack make_decision handlers - one decision, one POST /decision", async () => {
    const first = makeDropin();
    const second = makeDropin();

    (first as any).subscribeToEvents();
    (second as any).subscribeToEvents();

    (window as any)._briqpay.publish("make_decision", {});
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    const decisionCalls = (global.fetch as jest.Mock).mock.calls.filter(
      (call: any[]) => String(call[0]).includes("/decision"),
    );
    expect(decisionCalls).toHaveLength(1);
  });

  test("a remount does not add a second briq script tag", () => {
    const div = document.createElement("div");
    div.id = "remount-target";
    document.body.appendChild(div);

    const first = makeDropin();
    first.mount("#remount-target");
    const second = makeDropin();
    second.mount("#remount-target");

    const scriptTags = document.querySelectorAll(
      'script[src="https://api.briqpay.com/briq.min.js"]',
    );
    expect(scriptTags).toHaveLength(1);
  });

  test("a remount replaces the snippet instead of appending a second copy", () => {
    const div = document.createElement("div");
    div.id = "remount-target";
    document.body.appendChild(div);

    const first = makeDropin();
    first.mount("#remount-target");
    const second = makeDropin();
    second.mount("#remount-target");

    expect(div.innerHTML).toBe("Dropin Embedded");
  });
});
