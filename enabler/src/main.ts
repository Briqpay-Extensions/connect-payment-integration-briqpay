import {
  BriqpayPaymentEnabler,
  DropinType,
  EnablerOptions,
  PaymentComponentBuilder,
  PaymentDropinBuilder,
} from "./payment-enabler/payment-enabler-briqpay";

// Create a proxy class that maintains backward compatibility while avoiding async in constructor
export class Enabler {
  private instance: BriqpayPaymentEnabler;

  constructor(options: EnablerOptions) {
    // Use the factory method to create the instance
    this.instance = BriqpayPaymentEnabler.createSync(options);
  }

  // Proxy all methods to the internal instance
  async createComponentBuilder(type: string): Promise<PaymentComponentBuilder> {
    return this.instance.createComponentBuilder(type);
  }

  async createDropinBuilder(type: DropinType): Promise<PaymentDropinBuilder> {
    return this.instance.createDropinBuilder(type);
  }
}

export { BriqpayPaymentEnabler };
export type { EnablerOptions };

// Thrown to onError when a processor call fails. Exported so integrators can
// narrow with `instanceof` and read statusCode/code/request - notably to detect
// an expired commercetools session (401 invalid_token) and mint a new one.
export { BriqpayProcessorError } from "./errors";

export {
  BRIQPAY_DECISION,
  BRIQPAY_REJECT_TYPE,
  registerBriqpayDecision,
} from "./briqpay-sdk";
export type {
  BriqpayDecisionOptions,
  DecisionAnswer,
  OnDecision,
} from "./briqpay-sdk";
