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

export enum BRIQPAY_DECISION {
  ALLOW = "allow",
  REJECT = "reject",
}

enum BRIQPAY_REJECT_TYPE {
  REJECT_WITH_ERROR = "reject_session_with_error",
  NOTIFY_USER = "notify_user",
}

type BriqpayDecisionRequest = {
  decision: BRIQPAY_DECISION;
  rejectionType?: BRIQPAY_REJECT_TYPE;
  hardError?: {
    message: string;
  };
  softErrors?: {
    message: string;
  }[];
};

declare global {
  interface Window {
    _briqpay: {
      subscribe: (
        _event: string,
        _callback: (_data: Record<string, unknown>) => void
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
  private paymentMethod = PaymentMethod.briqpay;

  constructor(
    opts: { dropinOptions: DropinOptions },
    _baseOptions: BaseOptions
  ) {
    this.dropinOptions = opts.dropinOptions;
    this.baseOptions = _baseOptions;
  }

  init(): void {
    this.dropinOptions.onDropinReady?.().catch(() => {});
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
    window._briqpay.v3.suspend();

    if (this.dropinOptions.onPayButtonClick) {
      await this.dropinOptions.onPayButtonClick(this.baseOptions.sdk);
    }

    const customDecisionResponse = await this.getCustomDecisionResponse(data);

    if (!this.isValidDecision(customDecisionResponse)) {
      window._briqpay.v3.resumeDecision();
      return;
    }

    await this.sendDecision(customDecisionResponse as BriqpayDecisionRequest);
    window._briqpay.v3.resumeDecision();
  }

  private async getCustomDecisionResponse(data: unknown) {
    const promiseForResponse = new Promise((resolve) => {
      document.addEventListener(
        "briqpayDecisionResponse",
        function (e: Event) {
          resolve((e as CustomEvent).detail);
        },
        { once: true }
      );
    });

    const event = new CustomEvent("briqpayDecision", {
      detail: { data },
    });
    document.dispatchEvent(event);

    return Promise.race([
      promiseForResponse,
      new Promise((resolve) =>
        setTimeout(() => {
          resolve({ decision: true });
        }, 10000)
      ),
    ]);
  }

  private isValidDecision(customDecisionResponse: unknown) {
    return (
      customDecisionResponse &&
      typeof customDecisionResponse === "object" &&
      "decision" in customDecisionResponse
    );
  }

  private async sendDecision(customDecisionResponse: BriqpayDecisionRequest) {
    const { decision, softErrors, hardError, rejectionType } =
      customDecisionResponse;

    const request: BriqpayDecisionRequest = {
      decision:
        (decision?.toLowerCase() as BRIQPAY_DECISION) || BRIQPAY_DECISION.ALLOW,
      ...(softErrors && { softErrors }),
      ...(hardError && { hardError }),
      ...(rejectionType && { rejectionType }),
    };

    await fetch(this.baseOptions.processorUrl + "/decision", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": this.baseOptions.sessionId,
      },
      body: JSON.stringify({
        sessionId: this.baseOptions.briqpaySessionId,
        ...request,
      }),
    });
  }

  private addToDocument(selector: string) {
    const container = document.querySelector(selector);
    if (!container) {
      throw new Error(`Container with selector '${selector}' not found`);
    }
    container.insertAdjacentHTML("afterbegin", this.baseOptions.snippet);
  }

  async submit(): Promise<void> {
    try {
      const request: PaymentRequestSchemaDTO = {
        paymentMethod: {
          type: this.paymentMethod,
        },
        paymentOutcome: PaymentOutcome.PENDING,
      };
      await fetch(this.baseOptions.processorUrl + "/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": this.baseOptions.sessionId,
        },
        body: JSON.stringify(request),
      });
    } catch (e) {
      this.baseOptions.onError?.(e);
      throw new Error("An error occurred. Please try again.");
    }
  }
}

export class DropinEmbeddedBuilder implements PaymentDropinBuilder {
  public dropinHasSubmit = true;
  private baseOptions: BaseOptions;

  constructor(_baseOptions: BaseOptions) {
    this.baseOptions = _baseOptions;
  }

  build(config: DropinOptions): DropinComponent {
    const dropin = new DropinComponents(
      {
        dropinOptions: config,
      },
      this.baseOptions
    );

    dropin.init();
    return dropin;
  }
}
