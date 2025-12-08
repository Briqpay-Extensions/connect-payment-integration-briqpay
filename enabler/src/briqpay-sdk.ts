export type BriqpaySdkParams = {
  processorUrl: string;
  sessionId: string;
};

export type DecisionResponse = {
  success: boolean;
  decision: 'allow' | 'reject';
};

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
   * After receiving a briqpayDecision event, call this method with the outcome.
   * This method securely calls the backend processor which validates the session
   * and makes the decision through Briqpay's API with proper authentication.
   *
   * @example
   * document.addEventListener("briqpayDecision", function (event) {
   *   // Access the data using event.detail
   *   const data = event.detail.data;
   *
   *   // Make the decision through the secure backend
   *   await component.sdk.makeDecision(true);
   * });
   *
   * @param decision true = allow, false = reject
   * @returns Promise<DecisionResponse> - The result from the backend
   * @throws Error if the backend call fails
   */
  async makeDecision(decision: boolean): Promise<DecisionResponse> {
    const briqpayDecision = decision ? 'allow' : 'reject';

    const response = await fetch(`${this.params.processorUrl}/decision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': this.params.sessionId,
      },
      body: JSON.stringify({
        sessionId: this.params.sessionId,
        decision: briqpayDecision,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Decision request failed: ${response.status} - ${errorText}`);
    }

    const result: DecisionResponse = await response.json();

    // Dispatch the response event for Briqpay iframe to handle
    const responseEvent = new CustomEvent('briqpayDecisionResponse', {
      detail: { decision: result.success && result.decision === 'allow' },
    });
    document.dispatchEvent(responseEvent);

    return result;
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
