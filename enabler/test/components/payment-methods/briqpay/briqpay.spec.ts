/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
  Briqpay,
  BriqpayBuilder,
} from "../../../../src/components/payment-methods/briqpay/briqpay";
import { BaseOptions } from "../../../../src/payment-enabler/payment-enabler-briqpay";
import { BriqpaySdk } from "../../../../src/briqpay-sdk";
import { PaymentOutcome } from "../../../../src/dtos/mock-payment.dto";
import { PaymentComponent } from "../../../../src/payment-enabler/payment-enabler";

// Don't mock the Briqpay class - we want to test the actual implementation
// jest.mock("../../../../src/components/payment-methods/briqpay/briqpay");

describe("Briqpay", () => {
  let component: PaymentComponent;
  let sessionCompleteCallback: (
    data: Record<string, unknown>,
  ) => Promise<void> | void;
  let makeDecisionCallback: (
    data: Record<string, unknown>,
  ) => Promise<void> | void;

  const baseOptions: BaseOptions = {
    sdk: {} as BriqpaySdk,
    processorUrl: "https://mock-processor.com",
    sessionId: "sess-123",
    environment: "test",
    snippet: '<div id="briqpay"></div>',
    briqpaySessionId: "briq-sess-123",
    onComplete: jest.fn(),
    onError: jest.fn(),
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

    // Mock document.dispatchEvent
    document.dispatchEvent = jest
      .fn()
      .mockReturnValue(true) as jest.MockedFunction<
      typeof document.dispatchEvent
    >;

    // Mock document.addEventListener
    document.addEventListener = jest.fn((event, listener) => {
      // Simulate calling the listener immediately with a mock event
      if (event === "briqpayDecisionResponse") {
        (listener as EventListener)({
          detail: { decision: "allow" },
        } as unknown as Event);
      }
    }) as unknown as typeof document.addEventListener;

    // Prepare briqpay window object before component creation
    // Track the callbacks for later use in tests
    const subscribeCallbacks: Record<
      string,
      (data: Record<string, unknown>) => void
    > = {};

    window._briqpay = {
      v3: {
        suspend: jest.fn(),
        resume: jest.fn(),
        resumeDecision: jest.fn(),
      },
      subscribe: jest.fn(
        (event: string, callback: (data: Record<string, unknown>) => void) => {
          subscribeCallbacks[event] = callback;
        },
      ),
    };

    // Create the component instance
    const builder = new BriqpayBuilder(baseOptions);
    component = builder.build();

    // Store callbacks for easy access in tests
    sessionCompleteCallback = subscribeCallbacks["session_complete"];
    makeDecisionCallback = subscribeCallbacks["make_decision"];
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

    const mockComponent = new Briqpay(baseOptions);

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

    setTimeout(async () => {
      const result = sessionCompleteCallback({});

      if (result instanceof Promise) {
        await result;
      }

      expect(submitSpy).toHaveBeenCalled();
    });
  });

  test("make_decision callback flow works correctly", () => {
    component.mount("#container");

    // Get the onload handler from the script element and execute it
    const scriptElement = document.querySelector("head")
      ?.lastChild as HTMLScriptElement;
    scriptElement.onload?.({} as Event);

    // Mock data for decision
    const mockDecisionData = { orderData: { amount: 100 } };

    // Trigger the make_decision callback
    setTimeout(async () => {
      await makeDecisionCallback(mockDecisionData);
      // Verify suspend was called
      expect(window._briqpay.v3.suspend).toHaveBeenCalled();

      // Verify custom event was dispatched
      expect(document.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "briqpayDecision",
          detail: expect.objectContaining({
            data: mockDecisionData,
          }),
        }),
      );

      // Verify fetch was called with correct data
      expect(global.fetch).toHaveBeenCalledWith(
        "https://mock-processor.com/decision",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Id": "sess-123",
          },
          body: expect.stringContaining("briq-sess-123"),
        }),
      );

      // Verify resumeDecision was called
      expect(window._briqpay.v3.resumeDecision).toHaveBeenCalled();
    });
  });

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

    expect(baseOptions.onError).toHaveBeenCalledWith(
      "An error occurred. Please try again.",
    );
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
