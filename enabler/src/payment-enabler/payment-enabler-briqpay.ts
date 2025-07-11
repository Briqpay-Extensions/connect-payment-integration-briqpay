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
  onComplete: (result: PaymentResult) => void;
  onError: (error: unknown, context?: { paymentReference?: string }) => void;
};

export class BriqpayPaymentEnabler implements PaymentEnabler {
  setupData: Promise<{ baseOptions: BaseOptions }>;

  constructor(options: EnablerOptions) {
    this.setupData = BriqpayPaymentEnabler._Setup(options);
  }

  private static _Setup = async (
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

    const supportedMethods = {};

    if (!Object.keys(supportedMethods).includes(type)) {
      throw new Error(
        `Component type not supported: ${type}. Supported types: ${Object.keys(
          supportedMethods
        ).join(", ")}`
      );
    }

    return new supportedMethods[type](baseOptions);
  }

  async createDropinBuilder(
    type: DropinType
  ): Promise<PaymentDropinBuilder | never> {
    const { baseOptions } = await this.setupData;

    const supportedMethods = {
      embedded: DropinEmbeddedBuilder,
    };

    if (!Object.keys(supportedMethods).includes(type)) {
      throw new Error(
        `Component type not supported: ${type}. Supported types: ${Object.keys(
          supportedMethods
        ).join(", ")}`
      );
    }

    return new supportedMethods[type](baseOptions);
  }
}
