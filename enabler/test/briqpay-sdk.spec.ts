import { beforeEach, describe, expect, jest, test } from "@jest/globals";

import { BriqpaySdk } from "../src/briqpay-sdk";

describe("BriqpaySdk", () => {
  let sdk: BriqpaySdk;
  let mockResume: jest.Mock;

  beforeEach(() => {
    sdk = new BriqpaySdk();

    // Set up global mocks
    mockResume = jest.fn();
    (global.window as Window)._briqpay = {
      v3: {
        suspend: jest.fn(),
        resume: mockResume,
        resumeDecision: jest.fn(),
      },
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
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

});
