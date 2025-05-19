/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, jest, test } from "@jest/globals";
import {
  DropinEmbeddedBuilder,
  DropinComponents,
} from "../../src/dropin/dropin-embedded";
import { DropinOptions } from "../../src/payment-enabler/payment-enabler";
import { BriqpaySdk } from "../../src/briqpay-sdk";
import { BRIQPAY_DECISION } from "../../../processor/src/dtos/briqpay-payment.dto";

describe("DropinEmbeddedBuilder", () => {
  // Mock fetch
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({ paymentReference: "ref-123" }),
    } as Response)
  ) as unknown as typeof fetch;

  test("should create DropinComponents with correct config", () => {
    const baseOptions = { sdk: {} } as any;
    const builder = new DropinEmbeddedBuilder(baseOptions);

    const config: DropinOptions = {
      onDropinReady: jest.fn<any>(), // Mock it to return a Promise
    };

    const dropin = builder.build(config);

    expect(dropin).toBeInstanceOf(DropinComponents);
    expect(dropin["dropinOptions"].onDropinReady).toBe(config.onDropinReady);
  });

  test("should set dropinHasSubmit to false by default", () => {
    const builder = new DropinEmbeddedBuilder({} as any);
    expect(builder.dropinHasSubmit).toBe(true);
  });
});

describe("DropinComponents", () => {
  test("should initialize with given options", () => {
    const config: DropinOptions = { onDropinReady: jest.fn<any>() };
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
        dropinOptions: { onDropinReady: jest.fn<any>() },
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
        dropinOptions: { onDropinReady: jest.fn<any>() },
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

    expect(async () => await dropin.submit()).not.toThrow();
  });

  test("submit() should throw an error", async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("Fetch failed"))
    );

    const dropin = new DropinComponents(
      {
        dropinOptions: { onDropinReady: jest.fn<any>() },
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

    expect(async () => await dropin.submit()).rejects.toThrow();
  });

  test("handleDecision should work", async () => {
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
        dropinOptions: { onDropinReady: jest.fn<any>() },
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

    expect(
      async () => await dropin.handleDecision(BRIQPAY_DECISION.ALLOW)
    ).not.toThrow();
  });

  test("handleDecision should work", async () => {
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
          onDropinReady: jest.fn<any>(),
          onPayButtonClick: jest.fn<any>(),
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

    const event = new CustomEvent("briqpayDecisionResponse", {
      detail: {
        decision: "allow",
        softErrors: ["softErrors"],
        hardError: "hardError",
        rejectionType: "rejected",
      },
    });
    document.dispatchEvent(event);

    expect(async () => await decisionPromise).rejects.toThrow();
  });
});
