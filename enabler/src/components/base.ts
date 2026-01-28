import { BriqpaySdk } from "../briqpay-sdk";
import {
  PaymentComponent,
  PaymentMethod,
  PaymentResult,
} from "../payment-enabler/payment-enabler";
import { BaseOptions } from "../payment-enabler/payment-enabler-briqpay";

export type ElementOptions = {
  paymentMethod: PaymentMethod;
};

/**
 * Base Web Component
 */
export abstract class BaseComponent implements PaymentComponent {
  protected paymentMethod: ElementOptions["paymentMethod"];
  protected sdk: BriqpaySdk;
  protected processorUrl: BaseOptions["processorUrl"];
  protected sessionId: BaseOptions["sessionId"];
  protected environment: BaseOptions["environment"];
  protected onComplete: (_result: PaymentResult) => void;
  protected onError: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _error: any,
    _context?: { paymentReference?: string },
  ) => void;

  constructor(paymentMethod: PaymentMethod, baseOptions: BaseOptions) {
    this.paymentMethod = paymentMethod;
    this.sdk = baseOptions.sdk;
    this.processorUrl = baseOptions.processorUrl;
    this.sessionId = baseOptions.sessionId;
    this.environment = baseOptions.environment;
    this.onComplete = baseOptions.onComplete;
    this.onError = baseOptions.onError;
  }

  abstract submit(): Promise<void>;

  abstract mount(_selector: string): void;

  showValidation?(): void;
  isValid?(): boolean;
  getState?(): {
    card?: {
      endDigits?: string;
      brand?: string;
      expiryDate?: string;
    };
  };
  isAvailable?(): Promise<boolean>;
}
