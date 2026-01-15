/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, jest, test } from "@jest/globals";
import {
  BRIQPAY_DECISION,
  DropinComponents,
  DropinEmbeddedBuilder,
} from "../../src/dropin/dropin-embedded";
import { DropinOptions } from "../../src/payment-enabler/payment-enabler";
import { BriqpaySdk } from "../../src/briqpay-sdk";

describe("DropinEmbeddedBuilder", () => {
  // Mock fetch
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => ({ paymentReference: "ref-123" }),
    } as unknown as Response)
  ) as unknown as typeof fetch;

  test("should create DropinComponents with correct config", () => {
    const baseOptions = { sdk: {} } as any;
    const builder = new DropinEmbeddedBuilder(baseOptions);

    const config: DropinOptions = {
      onDropinReady: jest.fn<any>().mockResolvedValue(undefined), // Mock it to return a Promise
    };

    const dropin = builder.build(config);

    expect(dropin).toBeInstanceOf(DropinComponents);
    expect((dropin as any)["dropinOptions"].onDropinReady).toBe(
      config.onDropinReady
    );
  });

  test("should set dropinHasSubmit to true by default", () => {
    const builder = new DropinEmbeddedBuilder({} as any);
    expect(builder.dropinHasSubmit).toBe(true);
  });
});

describe("DropinComponents", () => {
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
      }
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
      }
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
      }
    );

    await expect(dropin.submit()).resolves.not.toThrow();
  });

  test("submit() should throw an error", async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("Fetch failed"))
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
      }
    );

    await expect(dropin.submit()).rejects.toThrow();
  });

  test("handleDecision should work", async () => {
    // Mock document.addEventListener to capture the callback
    const addEventListenerSpy = jest.spyOn(document, "addEventListener");
    let _eventCallback: ((event: Event) => void) | null = null;

    addEventListenerSpy.mockImplementation((_event: string, callback: any) => {
      if (_event === "briqpayDecisionResponse") {
        _eventCallback = callback;
      }
    });

    window._briqpay = {
      subscribe: jest.fn(),
      v3: {
        suspend: jest.fn().mockReturnValueOnce({}),
        resume: jest.fn().mockReturnValueOnce({}),
        resumeDecision: jest.fn().mockReturnValueOnce({}),
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
      }
    );

    const decisionPromise = dropin.handleDecision(BRIQPAY_DECISION.ALLOW);

    // Simulate the response event
    if (_eventCallback) {
      const event = new CustomEvent("briqpayDecisionResponse", {
        detail: {
          decision: "allow",
          softErrors: [],
          hardError: null,
          rejectionType: null,
        },
      });
      (_eventCallback as (event: Event) => void)(event);
    }

    await expect(decisionPromise).resolves.not.toThrow();

    addEventListenerSpy.mockRestore();
  });

  test("handleDecision should work with invalid decision", async () => {
    // Mock document.addEventListener to capture the callback
    const addEventListenerSpy = jest.spyOn(document, "addEventListener");
    let _eventCallback: ((event: Event) => void) | null = null;

    addEventListenerSpy.mockImplementation(
      (_event: string, callback: any, _options?: any) => {
        if (_event === "briqpayDecisionResponse") {
          _eventCallback = callback;
        }
      }
    );

    window._briqpay = {
      subscribe: jest.fn(),
      v3: {
        suspend: jest.fn().mockReturnValueOnce({}),
        resume: jest.fn().mockReturnValueOnce({}),
        resumeDecision: jest.fn().mockReturnValueOnce({}),
      },
    };

    const dropin = new DropinComponents(
      {
        dropinOptions: {
          onDropinReady: jest.fn<any>().mockResolvedValue(undefined),
          onPayButtonClick: jest.fn<any>().mockResolvedValue(undefined),
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
      }
    );

    const decisionPromise = dropin.handleDecision("invalid");

    // Wait a bit for the event listener to be set up
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate the response event
    if (_eventCallback) {
      const event = new CustomEvent("briqpayDecisionResponse", {
        detail: {
          decision: "allow",
          softErrors: ["softErrors"],
          hardError: "hardError",
          rejectionType: "rejected",
        },
      });
      (_eventCallback as (event: Event) => void)(event);
    }

    await expect(decisionPromise).resolves.not.toThrow();

    addEventListenerSpy.mockRestore();
  });
});
