import {
  ComponentOptions,
  PaymentComponent,
  PaymentComponentBuilder,
  PaymentMethod,
} from "../../../payment-enabler/payment-enabler.ts";
import buttonStyles from "../../../style/button.module.scss";
import inputFieldStyles from "../../../style/inputField.module.scss";
import styles from "../../../style/style.module.scss";
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
    // here we would call the SDK to submit the payment
    this.sdk.init({ environment: this.environment });
    // const isFormValid = validateAllFields();
    // if (!isFormValid) {
    //   return;
    // }
    try {
      // Below is a mock implementation but not recommend and PCI compliant approach,
      // please use respective PSP iframe capabilities to handle PAN data
      // const requestData = {
      //   paymentMethod: {
      //     type: this.paymentMethod,
      //     cardNumber: getInput(fieldIds.cardNumber).value.replace(/\s/g, ""),
      //     expiryMonth: getInput(fieldIds.expiryDate).value.split("/")[0],
      //     expiryYear: getInput(fieldIds.expiryDate).value.split("/")[1],
      //     cvc: getInput(fieldIds.cvv).value,
      //     holderName: getInput(fieldIds.holderName).value,
      //   },
      // };

      // Mock Validation
      // let isAuthorized = this.isCreditCardAllowed(requestData.paymentMethod.cardNumber);
      // const resultCode = isAuthorized ? PaymentOutcome.PENDING : PaymentOutcome.REJECTED;

      const request: PaymentRequestSchemaDTO = {
        paymentMethod: {
          type: this.paymentMethod,
        },
        paymentOutcome: PaymentOutcome.PENDING,
        briqpaySessionId: this.briqpaySessionId,
        // paymentOutcome: resultCode,
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
    const payButton = this.showPayButton
      ? `<button class="${buttonStyles.button} ${buttonStyles.fullWidth} ${styles.submitButton}" id="creditCardForm-paymentButton">Pay</button>`
      : "";
    return this.snippet;
    return `<iframe width="100%" height="600" border="0" src="https://msc-dev.briqpay.com/?sessionToken=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXNzaW9uSWQiOiJlZDcxMGZjMi05NjI3LTRiOTYtODQ2ZC1iZjIwMTc3Y2RlZTEiLCJtZXJjaGFudElkIjoiN2Y2Zjk3MjUtNTE0MC00Y2Y1LTgzNzItNDAxY2RiZTUyZjQ5IiwibmFtZSI6Ik1lcmNoYW50IChmcmVkcmlrQGJyaXFwYXkuY29tKSIsImlhdCI6MTc0MzQzMDcyMywidmVyc2lvbiI6InYyIiwidGVzdE1vZGUiOmZhbHNlLCJleHAiOjE3NDM2MDM1MjMsImF1ZCI6ImNsaWVudC1hcGkiLCJpc3MiOiJCcmlxUGF5TWVyY2hhbnQiLCJzdWIiOiIiLCJqdGkiOiIzNmUyNjlkMC1mOTgwLTRiNzQtODUwOS01ZTg2Y2I4OWI0NjIifQ.hHVewx8Rw1jtWSeDKFQyYZGFV0V8IPJupNqwb4f2RFQ"></iframe>`;
    return `
    <div class="${styles.wrapper}">
      <form class="${styles.paymentForm}">
        <div class="${inputFieldStyles.inputContainer}"> * Required fields for payment by credit card </div>
        <div class="${inputFieldStyles.inputContainer}">
          <label class="${inputFieldStyles.inputLabel}" for="creditCardForm.cardNumber">
            Card number <span aria-hidden="true"> *</span>
          </label>
          <input class="${inputFieldStyles.inputField}" type="text" id="creditCardForm-cardNumber" name="cardNumber" value="">
          <span class="${styles.hidden} ${inputFieldStyles.errorField}">Invalid card number</span>
          <div class="${styles.cardRow}" tabindex="-1">
            <img id="creditCardForm-visa" src="data:image/svg+xml,%3csvg width='70' height='48' viewBox='0 0 70 48' fill='none' xmlns='http://www.w3.org/2000/svg'%3e %3crect x='0.5' y='0.5' width='69' height='47' rx='5.5' fill='white' stroke='%23D9D9D9' /%3e %3cpath fill-rule='evenodd' clip-rule='evenodd' d='M21.2505 32.5165H17.0099L13.8299 20.3847C13.679 19.8267 13.3585 19.3333 12.8871 19.1008C11.7106 18.5165 10.4142 18.0514 9 17.8169V17.3498H15.8313C16.7742 17.3498 17.4813 18.0514 17.5991 18.8663L19.2491 27.6173L23.4877 17.3498H27.6104L21.2505 32.5165ZM29.9675 32.5165H25.9626L29.2604 17.3498H33.2653L29.9675 32.5165ZM38.4467 21.5514C38.5646 20.7346 39.2717 20.2675 40.0967 20.2675C41.3931 20.1502 42.8052 20.3848 43.9838 20.9671L44.6909 17.7016C43.5123 17.2345 42.216 17 41.0395 17C37.1524 17 34.3239 19.1008 34.3239 22.0165C34.3239 24.2346 36.3274 25.3992 37.7417 26.1008C39.2717 26.8004 39.861 27.2675 39.7431 27.9671C39.7431 29.0165 38.5646 29.4836 37.3881 29.4836C35.9739 29.4836 34.5596 29.1338 33.2653 28.5494L32.5582 31.8169C33.9724 32.3992 35.5025 32.6338 36.9167 32.6338C41.2752 32.749 43.9838 30.6502 43.9838 27.5C43.9838 23.5329 38.4467 23.3004 38.4467 21.5514ZM58 32.5165L54.82 17.3498H51.4044C50.6972 17.3498 49.9901 17.8169 49.7544 18.5165L43.8659 32.5165H47.9887L48.8116 30.3004H53.8772L54.3486 32.5165H58ZM51.9936 21.4342L53.1701 27.1502H49.8723L51.9936 21.4342Z' fill='%23172B85' /%3e %3c/svg%3e" class="${styles.cardIcon}" width="23" height="16" alt="">
            <img id="creditCardForm-amex" src="data:image/svg+xml,%3csvg width='70' height='48' viewBox='0 0 70 48' fill='none' xmlns='http://www.w3.org/2000/svg'%3e %3crect x='0.5' y='0.5' width='69' height='47' rx='5.5' fill='%231F72CD' stroke='%23D9D9D9' /%3e %3cpath fill-rule='evenodd' clip-rule='evenodd' d='M12.5493 17L6 31.4935H13.8405L14.8125 29.1826H17.0342L18.0062 31.4935H26.6364V29.7298L27.4054 31.4935H31.8696L32.6386 29.6925V31.4935H50.587L52.7695 29.2426L54.813 31.4935L64.0317 31.5121L57.4617 24.2872L64.0317 17H54.956L52.8315 19.2093L50.8523 17H31.3268L29.6501 20.7409L27.9341 17H20.11V18.7037L19.2396 17H12.5493ZM39.3516 19.0581H49.6584L52.8108 22.4633L56.0648 19.0581H59.2172L54.4275 24.2852L59.2172 29.452H55.9218L52.7695 26.0073L49.4989 29.452H39.3516V19.0581ZM41.8968 23.1099V21.2114V21.2096H48.328L51.1342 24.2458L48.2036 27.2986H41.8968V25.226H47.5197V23.1099H41.8968ZM14.0664 19.0581H17.8883L22.2324 28.8862V19.0581H26.4191L29.7745 26.1048L32.8668 19.0581H37.0326V29.4581H34.4978L34.4771 21.3087L30.7817 29.4581H28.5142L24.7981 21.3087V29.4581H19.5836L18.595 27.1266H13.254L12.2675 29.4561H9.47358L14.0664 19.0581ZM14.166 24.9712L15.9256 20.8177L17.6832 24.9712H14.166Z' fill='white' /%3e %3c/svg%3e" class="${styles.cardIcon}" width="23" height="16" alt="">
            <img id="creditCardForm-maestro" src="data:image/svg+xml,%3csvg width='70' height='48' viewBox='0 0 70 48' fill='none' xmlns='http://www.w3.org/2000/svg'%3e %3crect x='0.5' y='0.5' width='69' height='47' rx='5.5' fill='white' stroke='%23D9D9D9' /%3e %3cpath d='M40.1899 24.2539C40.1899 31.8787 34.0796 38.0599 26.5423 38.0599C19.005 38.0599 12.8948 31.8787 12.8948 24.2539C12.8948 16.6291 19.005 10.4479 26.5423 10.4479C34.0796 10.4479 40.1899 16.6291 40.1899 24.2539Z' fill='%23ED0006' /%3e %3cpath d='M57.8948 24.2539C57.8948 31.8787 51.7846 38.0599 44.2472 38.0599C36.7099 38.0599 30.5997 31.8787 30.5997 24.2539C30.5997 16.6291 36.7099 10.4479 44.2472 10.4479C51.7846 10.4479 57.8948 16.6291 57.8948 24.2539Z' fill='%230099DF' /%3e %3cpath fill-rule='evenodd' clip-rule='evenodd' d='M35.3948 13.7461C38.3292 16.2783 40.1898 20.0463 40.1898 24.2539C40.1898 28.4615 38.3292 32.2295 35.3948 34.7618C32.4605 32.2295 30.5998 28.4615 30.5998 24.2539C30.5998 20.0463 32.4605 16.2783 35.3948 13.7461Z' fill='%236C6BBD' /%3e %3c/svg%3e" class="${styles.cardIcon}" width="23" height="16" alt="">
            <img id="creditCardForm-mastercard" src="data:image/svg+xml,%3csvg width='70' height='48' viewBox='0 0 70 48' fill='none' xmlns='http://www.w3.org/2000/svg'%3e %3crect x='0.5' y='0.5' width='69' height='47' rx='5.5' fill='white' stroke='%23D9D9D9' /%3e %3cpath fill-rule='evenodd' clip-rule='evenodd' d='M35.5 34.3139C33.1169 36.3704 30.0255 37.6119 26.6475 37.6119C19.1102 37.6119 13 31.4308 13 23.806C13 16.1811 19.1102 10 26.6475 10C30.0255 10 33.1169 11.2415 35.5 13.2981C37.8831 11.2415 40.9745 10 44.3525 10C51.8898 10 58 16.1811 58 23.806C58 31.4308 51.8898 37.6119 44.3525 37.6119C40.9745 37.6119 37.8831 36.3704 35.5 34.3139Z' fill='%23ED0006' /%3e %3cpath fill-rule='evenodd' clip-rule='evenodd' d='M35.5 34.3139C38.4344 31.7816 40.2951 28.0136 40.2951 23.806C40.2951 19.5983 38.4344 15.8303 35.5 13.2981C37.8831 11.2415 40.9745 10 44.3524 10C51.8898 10 58 16.1811 58 23.806C58 31.4308 51.8898 37.6119 44.3524 37.6119C40.9745 37.6119 37.8831 36.3704 35.5 34.3139Z' fill='%23F9A000' /%3e %3cpath fill-rule='evenodd' clip-rule='evenodd' d='M35.5 13.2981C38.4344 15.8304 40.2951 19.5984 40.2951 23.806C40.2951 28.0136 38.4344 31.7816 35.5 34.3138C32.5657 31.7816 30.705 28.0136 30.705 23.806C30.705 19.5984 32.5657 15.8304 35.5 13.2981Z' fill='%23FF5E00' /%3e %3c/svg%3e" class="${styles.cardIcon}" width="23" height="16" alt="">
          </div>
        </div>
        <div class="${styles.row}">
          <div class="${inputFieldStyles.inputContainer}">
            <label class="${inputFieldStyles.inputLabel}" for="creditCardForm-expiryDate">
              Expiry date 
              <span aria-hidden="true"> *</span>
            </label>
          <input class="${inputFieldStyles.inputField}" type="text" id="creditCardForm-expiryDate" name="expiryDate" inputmode="numeric" value="">
          <span class="${styles.hidden} ${inputFieldStyles.errorField}">Invalid expiry date</span>
        </div>
        <div class="${inputFieldStyles.inputContainer}">
          <label class="${inputFieldStyles.inputLabel}" for="creditCardForm-cvv">
            CVC/CVV <span aria-hidden="true"> *</span>
          </label>
          <input class="${inputFieldStyles.inputField}" type="text" id="creditCardForm-cvv" name="cvv" value="">
          <span class="${styles.hidden} ${inputFieldStyles.errorField}">Invalid CVV</span>
        </div>
        </div>
        <div class="${inputFieldStyles.inputContainer}">
          <label class="${inputFieldStyles.inputLabel}" for="creditCardForm-holderNameLabel">
            Name on card <span aria-hidden="true"> *</span>
          </label>
          <input class="${inputFieldStyles.inputField}" type="text" id="creditCardForm-holderNameLabel" name="cardHolderName" value="">
          <span class="${styles.hidden} ${inputFieldStyles.errorField}">This field is required</span>
        </div>
        ${payButton}
      </form>
      </div>
    `;
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
