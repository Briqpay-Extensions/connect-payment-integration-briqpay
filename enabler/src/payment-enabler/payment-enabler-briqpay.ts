import { BriqpaySdk } from "../briqpay-sdk";
import {
  DropinType,
  EnablerOptions,
  PaymentComponentBuilder,
  PaymentDropinBuilder,
  PaymentEnabler,
  PaymentResult,
} from "./payment-enabler";
import { DropinEmbeddedBuilder } from "../dropin/dropin-embedded";

declare global {
  interface ImportMeta {
    env: unknown;
  }
}

export type BaseOptions = {
  sdk: BriqpaySdk;
  processorUrl: string;
  sessionId: string;
  environment: string;
  locale?: string;
  snippet: string;
  briqpaySessionId: string;
  onComplete: (_result: PaymentResult) => void;
  onError: (_error: unknown, _context?: { paymentReference?: string }) => void;
};

export class BriqpayPaymentEnabler implements PaymentEnabler {
  setupData: Promise<{ baseOptions: BaseOptions }>;

  protected constructor(setupData: Promise<{ baseOptions: BaseOptions }>) {
    this.setupData = setupData;
  }

  static create(options: EnablerOptions): Promise<BriqpayPaymentEnabler> {
    const setupData = BriqpayPaymentEnabler._Setup(options);
    return Promise.resolve(new BriqpayPaymentEnabler(setupData));
  }

  static createSync(options: EnablerOptions): BriqpayPaymentEnabler {
    const setupData = BriqpayPaymentEnabler._Setup(options);
    return new BriqpayPaymentEnabler(setupData);
  }

  protected static _Setup = async (
    options: EnablerOptions
  ): Promise<{ baseOptions: BaseOptions }> => {
    const configResponse = await fetch(options.processorUrl + "/config", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": options.sessionId,
      },
    });

    const configJson = await configResponse.json();

    const sdkOptions = {
      // environment: configJson.environment,
      ...configJson,
      processorUrl: options.processorUrl,
      sessionId: options.sessionId,
    };

    return Promise.resolve({
      baseOptions: {
        snippet: configJson.snippet,
        briqpaySessionId: configJson.briqpaySessionId,
        sdk: new BriqpaySdk(sdkOptions),
        processorUrl: options.processorUrl,
        sessionId: options.sessionId,
        environment: sdkOptions.environment,
        onComplete: options.onComplete || (() => {}),
        onError: options.onError || (() => {}),
      },
    });
  };

  async createComponentBuilder(
    type: string
  ): Promise<PaymentComponentBuilder | never> {
    const { baseOptions } = await this.setupData;

    const supportedMethods: Record<
      string,
      new (baseOptions: BaseOptions) => PaymentComponentBuilder
    > = {};

    const Builder = supportedMethods[type as keyof typeof supportedMethods];

    if (!Builder) {
      throw new Error(
        `Component type not supported: ${type}. Supported types: ${Object.keys(
          supportedMethods
        ).join(", ")}`
      );
    }

    return new Builder(baseOptions);
  }

  async createDropinBuilder(
    type: DropinType
  ): Promise<PaymentDropinBuilder | never> {
    const { baseOptions } = await this.setupData;

    const supportedMethods: Partial<
      Record<DropinType, new (baseOptions: BaseOptions) => PaymentDropinBuilder>
    > = {
      [DropinType.embedded]: DropinEmbeddedBuilder,
    };

    const Builder = supportedMethods[type as keyof typeof supportedMethods];

    if (!Builder) {
      throw new Error(
        `Component type not supported: ${type}. Supported types: ${Object.keys(
          supportedMethods
        ).join(", ")}`
      );
    }

    return new Builder(baseOptions);
  }
}

export type {
  DropinType,
  EnablerOptions,
  PaymentComponentBuilder,
  PaymentDropinBuilder,
};
