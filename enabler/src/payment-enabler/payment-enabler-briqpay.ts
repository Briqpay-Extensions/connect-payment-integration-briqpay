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
import { BriqpayBuilder } from "../components/payment-methods/briqpay/briqpay";

declare global {
  interface ImportMeta {
    env: unknown;
  }
}

// Mirrors processor/src/services/briqpay-payment.service.ts config()
type BriqpayConfigResponse = {
  snippet: string;
  briqpaySessionId: string;
};

import { toBriqpayProcessorError } from "../errors";

export type BaseOptions = {
  sdk: BriqpaySdk;
  processorUrl: string;
  sessionId: string;
  locale?: string;
  snippet: string;
  briqpaySessionId: string;
  onComplete: (_result: PaymentResult) => void | Promise<void>;
  onError: (_error: unknown) => void | Promise<void>;
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
    options: EnablerOptions,
  ): Promise<{ baseOptions: BaseOptions }> => {
    const configResponse = await fetch(options.processorUrl + "/config", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": options.sessionId,
      },
    });

    // A non-ok /config response must not be treated as a valid config: silently
    // proceeding sends a session-less/garbage config downstream, which surfaces
    // much later as a misleading "snippet is missing" error instead of the real one.
    const configBody = await configResponse.text();

    if (!configResponse.ok) {
      throw toBriqpayProcessorError("/config", configResponse.status, configBody);
    }

    // An ok response is guaranteed JSON of exactly this shape by the processor's
    // /config response schema.
    const configJson = JSON.parse(configBody) as BriqpayConfigResponse;

    const baseOptions: BaseOptions = {
      snippet: configJson.snippet,
      briqpaySessionId: configJson.briqpaySessionId,
      sdk: new BriqpaySdk(),
      processorUrl: options.processorUrl,
      sessionId: options.sessionId,
      onComplete: options.onComplete || (() => {}),
      onError: options.onError || (() => {}),
    };

    return {
      baseOptions,
    };
  };

  async createComponentBuilder(
    _type: string,
  ): Promise<PaymentComponentBuilder | never> {
    const { baseOptions } = await this.setupData;

    const supportedMethods: Record<
      string,
      new (_baseOptions: BaseOptions) => PaymentComponentBuilder
    > = {
      briqpay: BriqpayBuilder,
    };

    const Builder = supportedMethods[_type as keyof typeof supportedMethods];

    if (!Builder) {
      throw new Error(
        `Component type not supported: ${_type}. Supported types: ${Object.keys(
          supportedMethods,
        ).join(", ")}`,
      );
    }

    return new Builder(baseOptions);
  }

  async createDropinBuilder(
    _type: DropinType,
  ): Promise<PaymentDropinBuilder | never> {
    const { baseOptions } = await this.setupData;

    const supportedMethods: Partial<
      Record<
        DropinType,
        new (_baseOptions: BaseOptions) => PaymentDropinBuilder
      >
    > = {
      [DropinType._embedded]: DropinEmbeddedBuilder,
      [DropinType._briqpay]: DropinEmbeddedBuilder,
    };

    const Builder = supportedMethods[_type as keyof typeof supportedMethods];

    if (!Builder) {
      throw new Error(
        `Component type not supported: ${_type}. Supported types: ${Object.keys(
          supportedMethods,
        ).join(", ")}`,
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
