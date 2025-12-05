/**
 * Represents a Briqpay SDK.
 */
export class BriqpaySdk {
  private params;
  /**
   * Creates an instance of BriqpaySdk.
   */
  constructor(params: Record<string, unknown>) {
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
   * After receiving a briqpayDecision event, call this method with the outcome
   *
   * @example
   * document.addEventListener("briqpayDecision", function (event) {
   *   // Access the data using event.detail
   *   const data = event.detail.data;
   *
   *   // Do something with the data
   *   component.sdk.makeDecision(true);
   * });
   *
   * @param decision true|false
   */
  makeDecision(decision: boolean) {
    const responseEvent = new CustomEvent("briqpayDecisionResponse", {
      detail: { decision: Boolean(decision) },
    });
    document.dispatchEvent(responseEvent);
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
