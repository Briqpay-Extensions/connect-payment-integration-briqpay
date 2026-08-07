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
