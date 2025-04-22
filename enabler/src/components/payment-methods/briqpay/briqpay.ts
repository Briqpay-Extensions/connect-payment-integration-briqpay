import {
  ComponentOptions,
  PaymentComponent,
  PaymentComponentBuilder,
  PaymentMethod,
} from "../../../payment-enabler/payment-enabler.ts";
import { BaseComponent } from "../../base.ts";
import { addFormFieldsEventListeners, validateAllFields } from "./utils.ts";
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
        resumeDecision: () => void;
      };
    };
  }
}

export class Briqpay extends BaseComponent {
  private showPayButton: boolean;
  private snippet: string;
  private briqpaySessionId: string;

  constructor(baseOptions: BaseOptions, componentOptions: ComponentOptions) {
    super(PaymentMethod.briqpay, baseOptions, componentOptions);
    this.showPayButton = false; //componentOptions?.showPayButton ?? false;
    this.snippet = baseOptions.snippet;
    this.briqpaySessionId = baseOptions.briqpaySessionId;
  }

  mount(selector: string) {
    const briqpayScript = document.createElement("script");
    briqpayScript.type = "text/javascript";
    briqpayScript.src = "https://dev-api.briqpay.com/briq.min.js";
    briqpayScript.onload = () => {
      window._briqpay.subscribe("session_complete", (data) => {
        console.log("Payment complete", data);
        this.submit();
      });

      window._briqpay.subscribe("make_decision", async (data) => {
        console.log("Purchase decision activated", data);

        window._briqpay.v3.suspend();

        const promiseForResponse = new Promise((resolve) => {
          document.addEventListener(
            "briqpayDecisionResponse",
            function (e: CustomEvent) {
              resolve(e.detail); // Resolve with the event detail
            },
            { once: true }
          );
        });

        const event = new CustomEvent("briqpayDecision", {
          detail: { data },
        });
        document.dispatchEvent(event);

        const customDecisionResponse: unknown = await Promise.race([
          promiseForResponse,
          new Promise(
            (resolve) =>
              setTimeout(async () => {
                resolve({ decision: true });
              }, 3000)
            // }, 10000)
          ),
        ]);

        // Check if response is an object that doesn't have the decision prop
        if (
          !customDecisionResponse ||
          (typeof customDecisionResponse === "object" &&
            customDecisionResponse !== null &&
            !("decision" in customDecisionResponse))
        ) {
          window._briqpay.v3.resumeDecision();
          return; // Exit early
        }

        const { decision, softErrors, hardError, rejectionType } =
          customDecisionResponse as BriqpayDecisionRequest;

        // Somehow tell the merchant frontend to give a thumbs up or thumbs down
        // for the order to continue, they may check stock balance of the cart items
        // The merchant frontend should probably call this endpoint instead of us?
        const request: BriqpayDecisionRequest = {
          decision:
            (decision?.toLowerCase?.() as BRIQPAY_DECISION | undefined) ||
            BRIQPAY_DECISION.ALLOW,
          ...(softErrors && {
            softErrors,
          }),
          ...(hardError && {
            hardError,
          }),
          ...(rejectionType && {
            rejectionType,
          }),
        };
        console.log("making decision");
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
        }).catch((error) => {
          console.error("CATCH BLOCK");
          console.error(error);
          throw error;
        });
        console.log("resuming");
        window._briqpay.v3.resumeDecision();
      });
    };

    document.querySelector("head").appendChild(briqpayScript);

    document
      .querySelector(selector)
      .insertAdjacentHTML("afterbegin", this._getTemplate());

    if (this.showPayButton) {
      document
        .querySelector("#creditCardForm-paymentButton")
        .addEventListener("click", (e) => {
          e.preventDefault();
          this.submit();
        });
    }

    addFormFieldsEventListeners();
  }

  async submit() {
    this.sdk.init({ environment: this.environment });

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
      const isSuccess = PaymentOutcome.PENDING === PaymentOutcome.PENDING;

      this.onComplete &&
        this.onComplete({ isSuccess, paymentReference: data.paymentReference });
    } catch (e) {
      this.onError("Some error occurred. Please try again.");
    }
  }

  private _getTemplate() {
    return this.snippet;
  }

  showValidation() {
    validateAllFields();
  }

  isValid() {
    return validateAllFields();
  }

  getState() {
    return {
      // card: {
      //   endDigits: getInput(fieldIds.cardNumber).value.slice(-4),
      //   brand: getCardBrand(getInput(fieldIds.cardNumber).value),
      //   expiryDate: getInput(fieldIds.expiryDate).value,
      // },
    };
  }

  isAvailable() {
    return Promise.resolve(true);
  }

  // private isCreditCardAllowed(cardNumber: string) {
  //   const allowedCreditCards = ["4111111111111111", "5555555555554444", "341925950237632"];
  //   return allowedCreditCards.includes(cardNumber);
  // }
}
