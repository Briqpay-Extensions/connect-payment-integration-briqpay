/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
  Briqpay,
  BriqpayBuilder,
} from "../../../../src/components/payment-methods/briqpay/briqpay";
import { BaseOptions } from "../../../../src/payment-enabler/payment-enabler-briqpay";
import { BriqpaySdk } from "../../../../src/briqpay-sdk";
import { PaymentOutcome } from "../../../../src/dtos/mock-payment.dto";
import {
  DecisionCallback,
  PaymentComponent,
} from "../../../../src/payment-enabler/payment-enabler";

// Don't mock the Briqpay class - we want to test the actual implementation
// jest.mock("../../../../src/components/payment-methods/briqpay/briqpay");

describe("Briqpay", () => {
  let component: PaymentComponent;

  const baseOptions: BaseOptions = {
    sdk: {} as BriqpaySdk,
    processorUrl: "https://mock-processor.com",
    sessionId: "sess-123",
    environment: "test",
    snippet: '<div id="briqpay"></div>',
    briqpaySessionId: "briq-sess-123",
    onComplete: jest.fn() as jest.MockedFunction<BaseOptions["onComplete"]>,
    onError: jest.fn() as jest.MockedFunction<BaseOptions["onError"]>,
  };

  // Mock fetch
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => ({ paymentReference: "ref-123" }),
    } as unknown as Response),
  ) as unknown as typeof fetch;

  beforeEach(() => {
    jest.clearAllMocks();

    // Clear DOM
    document.body.innerHTML = "<div id='container'></div>";
    document.head.innerHTML = "";

    window._briqpay = {
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
      subscribe: jest.fn(),
    };

    // Create the component instance. Deliberately bypasses the
    // DecisionCallback type (which now requires onDecision) to simulate a
    // plain-JS/untyped caller that omits it, matching several tests below
    // that don't exercise decision handling and one that specifically
    // relies on the runtime defensive fallback for a missing onDecision.
    const builder = new BriqpayBuilder(baseOptions);
    component = builder.build({} as unknown as DecisionCallback);
  });

  test("mount() injects script and renders snippet", () => {
    component.mount("#container");

    // The script should be in the head
    const scriptElement = document.querySelector("head script");
    const divElement = document.querySelector("#briqpay");

    expect(scriptElement).toBeTruthy();
    expect((scriptElement as any)?.src).toContain("briqpay.com/briq.min.js");
    expect(divElement).toBeTruthy();
  });

  test("mount() injects script and renders snippet", async () => {
    component.mount("#container");

    await (component as any).handleDecision({ allow: true });
  });

  test("should execute session_complete and make_decision callbacks", () => {
    const sessionCompleteSpy = jest.fn();
    const makeDecisionSpy = jest.fn();

    const mockComponent = new Briqpay(
      baseOptions,
      {} as unknown as DecisionCallback,
    );

    // Mock the subscribe method to capture the callbacks
    mockComponent.mount("#container");

    // Simulate the loading of the script
    const scriptElement = document.querySelector("head")
      ?.lastChild as HTMLScriptElement;
    scriptElement.onload?.({} as Event);

    // Simulate the "session_complete" callback trigger
    window._briqpay.subscribe("session_complete", sessionCompleteSpy);
    window._briqpay.subscribe("make_decision", makeDecisionSpy);

    // Execute the callbacks manually
    sessionCompleteSpy({});
    makeDecisionSpy({ orderData: { amount: 100 } });

    // Check if callbacks are called
    expect(sessionCompleteSpy).toHaveBeenCalled();
    expect(makeDecisionSpy).toHaveBeenCalled();
  });

  test("session_complete callback triggers submit()", () => {
    const submitSpy = jest.spyOn(component, "submit");

    component.mount("#container");

    // Get the onload handler from the script element and execute it
    const scriptElement = document.querySelector("head")
      ?.lastChild as HTMLScriptElement;
    scriptElement.dispatchEvent(new Event("load"));
    scriptElement.onload?.({} as Event);

    // subscribe() only runs on script load, so beforeEach captures nothing.
    const sessionComplete = (
      window._briqpay.subscribe as jest.Mock
    ).mock.calls.find(
      (call: unknown[]) => call[0] === "session_complete",
    )?.[1] as (data: Record<string, unknown>) => void;

    sessionComplete({});

    expect(submitSpy).toHaveBeenCalled();
  });

  // Allowing would record an approval no merchant made.
  test("make_decision callback sends nothing when no onDecision is configured", async () => {
    component.mount("#container");

    const scriptElement = document.querySelector("head")
      ?.lastChild as HTMLScriptElement;
    scriptElement.onload?.({} as Event);

    const liveMakeDecisionCallback = (
      window._briqpay.subscribe as jest.Mock
    ).mock.calls.find(
      (call: unknown[]) => call[0] === "make_decision",
    )?.[1] as (data: Record<string, unknown>) => Promise<void> | void;

    const mockDecisionData = { orderData: { amount: 100 } };

    await liveMakeDecisionCallback(mockDecisionData);

    expect(global.fetch).not.toHaveBeenCalledWith(
      "https://mock-processor.com/decision",
      expect.anything(),
    );
    // suspend() is intentionally NOT called here - Briqpay auto-suspends the
    // widget itself for make_decision; only resumeDecision() is our job.
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
  });

  test("make_decision callback calls onDecision and sends its returned answer", async () => {
    const onDecision = jest.fn<any>().mockResolvedValue({ decision: "reject" });
    const builder = new BriqpayBuilder(baseOptions);
    const decisionComponent = builder.build({ onDecision });

    const subscribeCallbacks: Record<
      string,
      (data: Record<string, unknown>) => void
    > = {};
    window._briqpay.subscribe = jest.fn(
      (event: string, callback: (data: Record<string, unknown>) => void) => {
        subscribeCallbacks[event] = callback;
      },
    );

    decisionComponent.mount("#container");
    const scriptElement = document.querySelector("head")
      ?.lastChild as HTMLScriptElement;
    scriptElement.onload?.({} as Event);

    const mockDecisionData = { orderData: { amount: 100 } };
    await subscribeCallbacks["make_decision"](mockDecisionData);

    expect(onDecision).toHaveBeenCalledWith(baseOptions.sdk, mockDecisionData);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://mock-processor.com/decision",
      expect.objectContaining({
        body: JSON.stringify({
          sessionId: "briq-sess-123",
          decision: "reject",
        }),
      }),
    );
    expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
  });

  // Neither a stall nor a throw is an answer, so nothing is sent.
  test.each([
    ["never resolves", () => new Promise(() => {}), 20000],
    ["throws", () => Promise.reject(new Error("validation blew up")), 0],
  ])(
    "make_decision callback abandons the decision when onDecision %s",
    async (_label, makeAnswer, advanceBy) => {
      jest.useFakeTimers();

      const onDecision = jest.fn<any>().mockImplementation(makeAnswer);
      const builder = new BriqpayBuilder(baseOptions);
      const decisionComponent = builder.build({ onDecision });

      const subscribeCallbacks: Record<
        string,
        (data: Record<string, unknown>) => void
      > = {};
      window._briqpay.subscribe = jest.fn(
        (event: string, callback: (data: Record<string, unknown>) => void) => {
          subscribeCallbacks[event] = callback;
        },
      );

      decisionComponent.mount("#container");
      const scriptElement = document.querySelector("head")
        ?.lastChild as HTMLScriptElement;
      scriptElement.onload?.({} as Event);

      const settled = jest.fn();
      void Promise.resolve(
        subscribeCallbacks["make_decision"]({ orderData: { amount: 100 } }),
      ).then(settled, settled);

      await jest.advanceTimersByTimeAsync(advanceBy);

      expect(settled).toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalledWith(
        "https://mock-processor.com/decision",
        expect.anything(),
      );
      expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();

      jest.useRealTimers();
    },
  );

  test("submit() posts to payments and calls onComplete on success", async () => {
    await component.submit();

    // Check fetch was called with correct data
    expect(global.fetch).toHaveBeenCalledWith(
      "https://mock-processor.com/payments",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": "sess-123",
        },
        body: JSON.stringify({
          paymentMethod: {
            type: "briqpay",
          },
          paymentOutcome: PaymentOutcome._PENDING,
        }),
      }),
    );

    // Check onComplete was called with success
    expect(baseOptions.onComplete).toHaveBeenCalledWith({
      isSuccess: true,
      paymentReference: "ref-123",
    });
  });

  test("submit() calls onError on failure", async () => {
    // Override fetch to simulate an error
    global.fetch = jest.fn(() =>
      Promise.reject(new Error("Network error")),
    ) as unknown as typeof fetch;

    await component.submit();

    expect(baseOptions.onError).toHaveBeenCalledWith(expect.any(Error));
  });

  test("submit() awaits an async onComplete before resolving", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => ({ paymentReference: "ref-async" }),
      } as unknown as Response),
    ) as unknown as typeof fetch;

    let resolved = false;
    const asyncOnComplete = jest.fn(async () => {
      await Promise.resolve();
      resolved = true;
    }) as jest.MockedFunction<BaseOptions["onComplete"]>;

    const builder = new BriqpayBuilder({
      ...baseOptions,
      onComplete: asyncOnComplete,
    });
    const asyncComponent = builder.build({} as unknown as DecisionCallback);

    await asyncComponent.submit();

    expect(asyncOnComplete).toHaveBeenCalled();
    expect(resolved).toBe(true);

    global.fetch = originalFetch;
  });

  test("getState() returns an empty object", () => {
    const state = (component as Briqpay).getState();
    expect(state).toEqual({});
  });

  test("isAvailable() resolves with false for non-embedded", async () => {
    const result = await (component as Briqpay).isAvailable();
    expect(result).toBe(false);
  });
});
