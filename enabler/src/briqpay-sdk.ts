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

export type OnDecision = (
  _sdk: BriqpaySdk,
  _data: unknown,
) => Promise<DecisionAnswer>;

declare global {
  interface Window {
    /**
     * This connector's own merchant-config namespace — distinct from
     * `window._briqpay`, which is Briqpay's core widget script's global
     * (briq.min.js, shared across every Briqpay integration, exposing
     * subscribe()/v3.suspend()/v3.resume()/v3.resumeDecision()). Merchants
     * never assign onto `_briqpay`, only call into it; `briqpayConnector`
     * is the opposite direction — a namespace the merchant writes into
     * and this connector's enabler reads. Kept as one shared root object,
     * the same shape commercetools' own SDK uses for window.
     * commercetoolsCheckout, so future connector-level config can live
     * here as sibling keys instead of minting a new global each time.
     */
    briqpayConnector?: {
      /**
       * The merchant's purchase-decision handler. Optional — the
       * connector requests the decision step on every session it creates,
       * so Briqpay will ask for a decision, but if nothing is registered
       * here the enabler answers ALLOW automatically and the purchase
       * proceeds as normal. Register a handler only if you want to run
       * your own validation first. Briqpay decides when a decision is
       * needed, so do not assume it fires on every submission.
       *
       * Validate here, then return the answer. Returning it is what
       * sends it. Once registered, not answering within 20 seconds
       * abandons the decision and nothing is sent; Briqpay blocks the
       * purchase and asks the buyer to retry. A slow or throwing handler
       * is NOT treated as an allow — only the absence of any registered
       * handler is.
       *
       * This is only ever read, never called, by the enabler — so it can
       * be set at any time before the buyer reaches the payment step,
       * with no dependency on the enabler having loaded yet. That matters
       * because under commercetools' hosted paymentFlow/checkoutFlow, the
       * enabler bundle is injected by commercetools' own checkout
       * application at a time the merchant does not control; requiring a
       * function call into enabler code would race against that. Assign
       * the object directly:
       *
       *   window.briqpayConnector = window.briqpayConnector || {};
       *   window.briqpayConnector.onDecision = async (sdk, data) => {...};
       *
       * registerBriqpayDecision() below is equivalent sugar for merchants
       * who import this package directly (e.g. building a custom UI with
       * createDropinBuilder/createComponentBuilder) and don't have that
       * load-order problem in the first place.
       */
      onDecision?: OnDecision;
    };
  }
}

/**
 * Convenience wrapper around assigning `window.briqpayConnector.onDecision`
 * directly (see the type doc above) — identical effect, just callable if
 * you already import this package. Prefer the direct assignment instead
 * when your page can't guarantee this module has loaded before you need
 * to register (e.g. under commercetools' hosted paymentFlow, where the
 * enabler bundle's load timing is out of your control).
 */
export function registerBriqpayDecision(onDecision: OnDecision): void {
  window.briqpayConnector = window.briqpayConnector || {};
  window.briqpayConnector.onDecision = onDecision;
}

/**
 * Reads the handler registered via registerBriqpayDecision(). Used
 * internally by the dropin/component; not something merchants call.
 */
export function getRegisteredOnDecision(): OnDecision | undefined {
  return typeof window !== "undefined"
    ? window.briqpayConnector?.onDecision
    : undefined;
}
