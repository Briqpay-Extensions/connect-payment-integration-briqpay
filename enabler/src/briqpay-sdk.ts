export type BriqpaySdkParams = {
  processorUrl: string;
  sessionId: string;
};

export enum BRIQPAY_DECISION {
  ALLOW = "allow",
  REJECT = "reject",
}

export enum BRIQPAY_REJECT_TYPE {
  REJECT_WITH_ERROR = "reject_session_with_error",
  NOTIFY_USER = "notify_user",
}

export type BriqpayDecisionOptions = {
  rejectionType?: BRIQPAY_REJECT_TYPE;
  hardError?: {
    message: string;
  };
  softErrors?: {
    message: string;
  }[];
};

export type DecisionAnswer = {
  decision: BRIQPAY_DECISION;
} & BriqpayDecisionOptions;

/**
 * Matches Briqpay's default wait, so the decision is abandoned as Briqpay gives
 * up on it rather than after. Merchants granted a longer window wait 40s there.
 */
export const DECISION_TIMEOUT_MS = 20000;

/**
 * Represents a Briqpay SDK.
 */
export class BriqpaySdk {
  private params: BriqpaySdkParams;

  /**
   * Creates an instance of BriqpaySdk.
   */
  constructor(params: BriqpaySdkParams) {
    this.params = params;
  }

  /**
   * Initializes the SDK.
   */
  init() {}

  /**
   * Adds and overlay over the payment methods during cart updates for example
   */
  suspend() {
    window._briqpay.v3.suspend();
  }

  /**
   * Remove the suspend overlay and rehydrate the iframe with the latest data
   */
  resume() {
    window._briqpay.v3.resume();
  }

  /**
   * Disable automatic rehydration to control the flow separately
   * @param autoRehydrate
   */
  async rehydrate(autoRehydrate = true) {
    await fetch(this.params.processorUrl + "/config", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Session-ID": this.params.sessionId as string,
      },
    }).finally(() => autoRehydrate && this.resume());
  }
}
