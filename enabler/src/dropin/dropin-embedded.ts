import {
  DropinComponent,
  DropinOptions,
  PaymentDropinBuilder,
  PaymentMethod,
} from "../payment-enabler/payment-enabler";
import { BaseOptions } from "../payment-enabler/payment-enabler-briqpay";
import { handleBriqpayDecision, submitBriqpayPayment } from "../briqpay-sdk";

const BRIQPAY_SCRIPT_SRC = "https://api.briqpay.com/briq.min.js";

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
    // Reuse the script on remount; a second copy is inert (the SDK self-guards).
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${BRIQPAY_SCRIPT_SRC}"]`,
    );

    if (existing) {
      if (window._briqpay) {
        this.subscribeToEvents();
      } else {
        existing.addEventListener("load", this.onBriqpayScriptLoad.bind(this));
      }

      return;
    }

    const briqpayScript = document.createElement("script");
    briqpayScript.type = "text/javascript";
    briqpayScript.src = BRIQPAY_SCRIPT_SRC;
    briqpayScript.onload = this.onBriqpayScriptLoad.bind(this);
    document.head.appendChild(briqpayScript);
  }
  private onBriqpayScriptLoad() {
    this.subscribeToEvents();
  }

  private subscribeToEvents() {
    // subscribe appends, so without clearing first every remount leaves the old
    // instance's handlers live and one session_complete POSTs /payments per remount.
    // The dropin owns these two events; nothing else subscribes to them.
    window._briqpay.unsubscribe("session_complete");
    window._briqpay.unsubscribe("make_decision");

    // Briqpay fires this, so there is no caller to reject to: the failure can
    // only be reported through onError.
    window._briqpay.subscribe("session_complete", () => {
      void this.submit().catch((error) => this.baseOptions.onError?.(error));
    });

    window._briqpay.subscribe("make_decision", this.handleDecision.bind(this));
  }

  public async handleDecision(data: unknown) {
    await handleBriqpayDecision(
      {
        sdk: this.baseOptions.sdk,
        processorUrl: this.baseOptions.processorUrl,
        sessionId: this.baseOptions.sessionId,
        briqpaySessionId: this.baseOptions.briqpaySessionId,
        onError: this.baseOptions.onError,
      },
      data,
    );
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

    // Replace, never append: mounting into a container that already holds a snippet would
    // leave the previous iframe alongside the new one.
    container.innerHTML = "";
    container.insertAdjacentHTML("afterbegin", this.baseOptions.snippet);
  }

  async submit(): Promise<void> {
    await submitBriqpayPayment({
      processorUrl: this.baseOptions.processorUrl,
      sessionId: this.baseOptions.sessionId,
      paymentMethodType: this.paymentMethod,
      onComplete: this.baseOptions.onComplete,
    });
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
