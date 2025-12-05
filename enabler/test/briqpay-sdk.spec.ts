import { beforeEach, describe, expect, jest, test } from "@jest/globals";

import { BriqpaySdk } from "../src/briqpay-sdk";

describe("BriqpaySdk", () => {
  let sdk: BriqpaySdk;
  let mockResume: jest.Mock;
  const mockParams = {
    processorUrl: "https://mock-processor.com",
    sessionId: "sess-123",
  };

  beforeEach(() => {
    sdk = new BriqpaySdk(mockParams);

    // Set up global mocks
    mockResume = jest.fn();
    (global.window as Window)._briqpay = {
      v3: {
        suspend: jest.fn(),
        resume: mockResume,
        resumeDecision: jest.fn(),
      },
      subscribe: jest.fn(),
    };

    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        json: () => ({ status: "ok" }),
      } as unknown as Response)
    ) as typeof fetch;
  });

  test("suspend() should call window._briqpay.v3.suspend", () => {
    sdk.suspend();
    expect(window._briqpay.v3.suspend).toHaveBeenCalled();
  });

  test("resume() should call window._briqpay.v3.resume", () => {
    sdk.resume();
    expect(window._briqpay.v3.resume).toHaveBeenCalled();
  });

  test("makeDecision(true) should dispatch correct event", () => {
    const listener = jest.fn();
    document.addEventListener("briqpayDecisionResponse", listener);

    sdk.makeDecision(true);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { decision: true },
      })
    );
  });

  test("rehydrate() should call fetch and resume if autoRehydrate = true", async () => {
    await sdk.rehydrate(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://mock-processor.com/config",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Session-ID": "sess-123",
        }),
      })
    );
    expect(mockResume).toHaveBeenCalled();
  });

  test("rehydrate() should NOT call resume if autoRehydrate = false", async () => {
    await sdk.rehydrate(false);
    expect(mockResume).not.toHaveBeenCalled();
  });
});
