import {
  ComponentOptions,
  PaymentComponent,
  PaymentComponentBuilder,
  PaymentMethod,
} from "../../../payment-enabler/payment-enabler.ts";
import { BaseComponent } from "../../base.ts";
import { BaseOptions } from "../../../payment-enabler/payment-enabler-briqpay.ts";
import {
  handleBriqpayDecision,
  submitBriqpayPayment,
} from "../../../briqpay-sdk.ts";

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
    // Briqpay fires this, so there is no caller to reject to: the failure can
    // only be reported through onError.
    window._briqpay.subscribe("session_complete", () => {
      void this.submit().catch((error) => this.onError(error));
    });

    window._briqpay.subscribe("make_decision", (data) =>
      this.handleDecision(data),
    );
  }

  public async handleDecision(data: unknown) {
    await handleBriqpayDecision(
      {
        sdk: this.sdk,
        processorUrl: this.processorUrl,
        sessionId: this.sessionId,
        briqpaySessionId: this.briqpaySessionId,
        onError: this.onError,
      },
      data,
    );
  }

  private addToDocument(_selector: string) {
    const container = document.querySelector(_selector);
    if (!container) {
      throw new Error(`Container with selector '${_selector}' not found`);
    }
    container.insertAdjacentHTML("afterbegin", this._getTemplate());
  }

  async submit() {
    await submitBriqpayPayment({
      processorUrl: this.processorUrl,
      sessionId: this.sessionId,
      paymentMethodType: this.paymentMethod,
      onComplete: this.onComplete,
    });
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
