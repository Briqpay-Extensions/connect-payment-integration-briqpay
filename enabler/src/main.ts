import { 
  BriqpayPaymentEnabler, 
  DropinType,
  EnablerOptions,
  PaymentComponentBuilder,
  PaymentDropinBuilder
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

// Also export the factory methods for new code
export const createEnabler = BriqpayPaymentEnabler.create;
export const createEnablerSync = BriqpayPaymentEnabler.createSync;
export { BriqpayPaymentEnabler };
export type { EnablerOptions };
