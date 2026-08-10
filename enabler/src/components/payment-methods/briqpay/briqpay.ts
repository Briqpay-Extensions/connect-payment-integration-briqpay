import {
  ComponentOptions,
  PaymentComponent,
  PaymentComponentBuilder,
  PaymentMethod,
} from "../../../payment-enabler/payment-enabler.ts";
import { BaseComponent } from "../../base.ts";
import {
  PaymentOutcome,
  PaymentRequestSchemaDTO,
} from "../../../dtos/mock-payment.dto.ts";
import { BaseOptions } from "../../../payment-enabler/payment-enabler-briqpay.ts";
import {
  BRIQPAY_DECISION,
  DECISION_TIMEOUT_MS,
  DecisionAnswer,
  getRegisteredOnDecision,
} from "../../../briqpay-sdk.ts";

declare global {
  interface Window {
    _briqpay: {
      subscribe: (
        _event: string,
        _callback: (_data: Record<string, unknown>) => void,
      ) => void;
      v3: {
        suspend: () => void;
        resume: () => void;
        resumeDecision: () => void;
      };
    };
  }
}

export class Briqpay extends BaseComponent {
  private snippet: string;
  private briqpaySessionId: string;

  constructor(baseOptions: BaseOptions) {
    super(PaymentMethod._briqpay, baseOptions);
    this.snippet = baseOptions.snippet;
    this.briqpaySessionId = baseOptions.briqpaySessionId;
  }

  mount(_selector: string) {
    this.loadBriqpayScript();
    this.addToDocument(_selector);
  }

  private loadBriqpayScript() {
    const briqpayScript = document.createElement("script");
    briqpayScript.type = "text/javascript";
    briqpayScript.src = "https://api.briqpay.com/briq.min.js";
    briqpayScript.onload = this.onBriqpayScriptLoad.bind(this);
    document.head.appendChild(briqpayScript);
  }

  private onBriqpayScriptLoad() {
    this.subscribeToEvents();
  }

  private subscribeToEvents() {
    window._briqpay.subscribe("session_complete", () => {
      this.submit().catch(() => {});
    });

    window._briqpay.subscribe("make_decision", (data) =>
      this.handleDecision(data),
    );
  }

  public async handleDecision(data: unknown) {
    // Briqpay blocks its own pay-button flow while awaiting the decision, so
    // nothing needs suspending here. resumeDecision() releases that block.
    // suspend()/resume() are a separate mechanism for cart updates and are not
    // cleared by resumeDecision().
    const decisionAnswer = await this.resolveDecisionAnswer(data);

    // Nothing usable. Briqpay gates on the decision it recorded, so unlocking
    // without one fails the purchase and shows the buyer an error.
    if (!this.isValidDecisionAnswer(decisionAnswer)) {
      window._briqpay.v3.resumeDecision();
      return;
    }

    try {
      await this.sendDecision(decisionAnswer);
    } finally {
      window._briqpay.v3.resumeDecision();
    }
  }

  private async resolveDecisionAnswer(
    data: unknown,
  ): Promise<DecisionAnswer | undefined> {
    const onDecision = getRegisteredOnDecision();
    if (!onDecision) {
      // Nobody opted into registerBriqpayDecision(), so there is no merchant
      // check to run - let the purchase proceed. This is different from a
      // registered handler that times out or throws below: that merchant
      // asked for validation, so a broken/slow check must not silently turn
      // into an approval it never made.
      return { decision: BRIQPAY_DECISION.ALLOW };
    }

    // A late answer loses the race and is never sent, so a verdict Briqpay has
    // already timed out on cannot land. A throw is not an answer either.
    return Promise.race([
      onDecision(this.sdk, data),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), DECISION_TIMEOUT_MS),
      ),
    ]).catch(() => undefined);
  }

  private isValidDecisionAnswer(
    decisionAnswer: unknown,
  ): decisionAnswer is DecisionAnswer {
    return (
      typeof decisionAnswer === "object" &&
      decisionAnswer !== null &&
      "decision" in decisionAnswer &&
      ((decisionAnswer as { decision: unknown }).decision ===
        BRIQPAY_DECISION.ALLOW ||
        (decisionAnswer as { decision: unknown }).decision ===
          BRIQPAY_DECISION.REJECT)
    );
  }

  private async sendDecision(decisionAnswer: DecisionAnswer) {
    await fetch(this.processorUrl + "/decision", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": this.sessionId,
      },
      body: JSON.stringify({
        sessionId: this.briqpaySessionId,
        ...decisionAnswer,
      }),
    });
  }

  private addToDocument(_selector: string) {
    const container = document.querySelector(_selector);
    if (!container) {
      throw new Error(`Container with selector '${_selector}' not found`);
    }
    container.insertAdjacentHTML("afterbegin", this._getTemplate());
  }

  async submit() {
    try {
      const request: PaymentRequestSchemaDTO = {
        paymentMethod: {
          type: this.paymentMethod,
        },
        paymentOutcome: PaymentOutcome._PENDING,
      };
      const response = await fetch(this.processorUrl + "/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": this.sessionId,
        },
        body: JSON.stringify(request),
      });
      const data = await response.json();
      // If we get to this point without any exceptions, it is a success
      const isSuccess = true;

      if (this.onComplete) {
        await this.onComplete({
          isSuccess,
          paymentReference: data.paymentReference,
        });
      }
    } catch (e) {
      try {
        await this.onError(e);
      } catch {
        // Prevent async onError rejection from masking the original error
      }
    }
  }

  private _getTemplate() {
    return this.snippet;
  }

  getState() {
    return {};
  }

  isAvailable() {
    return Promise.resolve(false);
  }
}

export class BriqpayBuilder implements PaymentComponentBuilder {
  public componentHasSubmit = true;

  constructor(private _baseOptions: BaseOptions) {}

  build(_config: ComponentOptions): PaymentComponent {
    return new Briqpay(this._baseOptions);
  }
}
