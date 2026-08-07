import {
  PaymentOutcome,
  PaymentRequestSchemaDTO,
} from "../dtos/mock-payment.dto";
import {
  DropinComponent,
  DropinOptions,
  PaymentDropinBuilder,
  PaymentMethod,
} from "../payment-enabler/payment-enabler";
import { BaseOptions } from "../payment-enabler/payment-enabler-briqpay";
import {
  BRIQPAY_DECISION,
  DECISION_TIMEOUT_MS,
  DecisionAnswer,
} from "../briqpay-sdk";

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

export class DropinComponents implements DropinComponent {
  private dropinOptions: DropinOptions;
  private baseOptions: BaseOptions;
  private paymentMethod = PaymentMethod._briqpay;

  constructor(
    opts: { dropinOptions: DropinOptions },
    _baseOptions: BaseOptions,
  ) {
    this.dropinOptions = opts.dropinOptions;
    this.baseOptions = _baseOptions;
  }

  init(): void {
    try {
      // Handle undefined or non-Promise return from onDropinReady
      this.dropinOptions.onDropinReady?.()?.catch?.(() => {});
    } catch {
      // Silently ignore any errors from onDropinReady
    }
  }

  mount(selector: string) {
    this.loadBriqpayScript();
    this.addToDocument(selector);
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

    window._briqpay.subscribe("make_decision", this.handleDecision.bind(this));
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
    const onDecision = this.dropinOptions.onDecision;
    if (!onDecision) {
      // Required by DropinOptions, so an untyped caller omitted it. Allowing
      // would record an approval no merchant made.
      return undefined;
    }

    // A late answer loses the race and is never sent, so a verdict Briqpay has
    // already timed out on cannot land. A throw is not an answer either.
    return Promise.race([
      onDecision(this.baseOptions.sdk, data),
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
    await fetch(this.baseOptions.processorUrl + "/decision", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": this.baseOptions.sessionId,
      },
      body: JSON.stringify({
        sessionId: this.baseOptions.briqpaySessionId,
        ...decisionAnswer,
      }),
    });
  }

  private addToDocument(selector: string) {
    const container = document.querySelector(selector);
    if (!container) {
      throw new Error(`Container with selector '${selector}' not found`);
    }
    if (!this.baseOptions.snippet) {
      throw new Error(
        "Briqpay HTML snippet is missing from processor /config response. " +
          "This typically happens after an HPP redirect when the session is reused.",
      );
    }
    container.insertAdjacentHTML("afterbegin", this.baseOptions.snippet);
  }

  async submit(): Promise<void> {
    try {
      const request: PaymentRequestSchemaDTO = {
        paymentMethod: {
          type: this.paymentMethod,
        },
        paymentOutcome: PaymentOutcome._PENDING,
      };
      const response = await fetch(
        this.baseOptions.processorUrl + "/payments",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Id": this.baseOptions.sessionId,
          },
          body: JSON.stringify(request),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Payment request failed with status ${response.status}`,
        );
      }

      const data = await response.json();
      await this.baseOptions.onComplete?.({
        isSuccess: true,
        paymentReference: data.paymentReference,
      });
    } catch (e) {
      try {
        await this.baseOptions.onError?.(e);
      } catch {
        // Prevent async onError rejection from masking the original error
      }
      throw new Error("An error occurred. Please try again.");
    }
  }
}

export class DropinEmbeddedBuilder implements PaymentDropinBuilder {
  public dropinHasSubmit = false;
  private baseOptions: BaseOptions;

  constructor(_baseOptions: BaseOptions) {
    this.baseOptions = _baseOptions;
  }

  build(_config: DropinOptions): DropinComponent {
    const dropin = new DropinComponents(
      {
        dropinOptions: _config,
      },
      this.baseOptions,
    );

    dropin.init();
    return dropin;
  }
}
