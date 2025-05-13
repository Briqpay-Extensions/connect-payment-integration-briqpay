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

enum BRIQPAY_DECISION {
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

export class BriqpayBuilder implements PaymentComponentBuilder {
  public componentHasSubmit = true;

  constructor(private baseOptions: BaseOptions) {}

  build(config: ComponentOptions): PaymentComponent {
    return new Briqpay(this.baseOptions, config);
  }
}

declare global {
  interface Window {
    _briqpay: {
      subscribe: (
        event: string,
        callback: (data: Record<string, unknown>) => void
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

  constructor(baseOptions: BaseOptions, componentOptions: ComponentOptions) {
    super(PaymentMethod.briqpay, baseOptions, componentOptions);
    this.snippet = baseOptions.snippet;
    this.briqpaySessionId = baseOptions.briqpaySessionId;
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
    document.querySelector("head").appendChild(briqpayScript);
  }

  private onBriqpayScriptLoad() {
    this.subscribeToEvents();
  }

  private subscribeToEvents() {
    window._briqpay.subscribe("session_complete", () => {
      this.submit();
    });

    window._briqpay.subscribe("make_decision", this.handleDecision.bind(this));
  }

  public async handleDecision(data: any) {
    window._briqpay.v3.suspend();
    const customDecisionResponse = await this.getCustomDecisionResponse(data);

    if (!this.isValidDecision(customDecisionResponse)) {
      window._briqpay.v3.resumeDecision();
      return;
    }

    await this.sendDecision(customDecisionResponse as BriqpayDecisionRequest);
    window._briqpay.v3.resumeDecision();
  }

  private async getCustomDecisionResponse(data: any) {
    const promiseForResponse = new Promise((resolve) => {
      document.addEventListener(
        "briqpayDecisionResponse",
        function (e: CustomEvent) {
          resolve(e.detail);
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
        setTimeout(async () => {
          resolve({ decision: true });
        }, 10000)
      ),
    ]);
  }

  private isValidDecision(customDecisionResponse: any) {
    return (
      customDecisionResponse &&
      typeof customDecisionResponse === "object" &&
      customDecisionResponse !== null &&
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

    await fetch(this.processorUrl + "/decision", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": this.sessionId,
      },
      body: JSON.stringify({
        sessionId: this.briqpaySessionId,
        ...request,
      }),
    });
  }

  private addToDocument(selector: string) {
    document
      .querySelector(selector)
      .insertAdjacentHTML("afterbegin", this._getTemplate());
  }

  async submit() {
    try {
      const request: PaymentRequestSchemaDTO = {
        paymentMethod: {
          type: this.paymentMethod,
        },
        paymentOutcome: PaymentOutcome.PENDING,
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

      this.onComplete &&
        this.onComplete({ isSuccess, paymentReference: data.paymentReference });
    } catch (e) {
      this.onError("Some error occurred. Please try again.");
    }
  }

  private _getTemplate() {
    return this.snippet;
  }

  getState() {
    return {};
  }

  isAvailable() {
    return Promise.resolve(true);
  }
}
