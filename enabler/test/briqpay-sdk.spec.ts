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

    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    } as Response);
  });

  test("suspend() should call window._briqpay.v3.suspend", () => {
    sdk.suspend();
    expect(window._briqpay.v3.suspend).toHaveBeenCalled();
  });

  test("resume() should call window._briqpay.v3.resume", () => {
    sdk.resume();
    expect(window._briqpay.v3.resume).toHaveBeenCalled();
  });

  test("makeDecision(true) should call backend and dispatch correct event", async () => {
    const mockResponse = { success: true, decision: "allow" };
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    const listener = jest.fn();
    document.addEventListener("briqpayDecisionResponse", listener);

    const result = await sdk.makeDecision(true);

    expect(fetch).toHaveBeenCalledWith(
      "https://mock-processor.com/decision",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Session-ID": "sess-123",
        }),
        body: JSON.stringify({
          sessionId: "sess-123",
          decision: "allow",
        }),
      })
    );

    expect(result).toEqual(mockResponse);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { decision: true },
      })
    );
  });

  test("makeDecision(false) should send reject decision", async () => {
    const mockResponse = { success: true, decision: "reject" };
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    const result = await sdk.makeDecision(false);

    expect(fetch).toHaveBeenCalledWith(
      "https://mock-processor.com/decision",
      expect.objectContaining({
        body: JSON.stringify({
          sessionId: "sess-123",
          decision: "reject",
        }),
      })
    );

    expect(result).toEqual(mockResponse);
  });

  test("makeDecision should throw on failed response", async () => {
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve("Session mismatch"),
    } as Response);

    await expect(sdk.makeDecision(true)).rejects.toThrow(
      "Decision request failed: 403 - Session mismatch"
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
