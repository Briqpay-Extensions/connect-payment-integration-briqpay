import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { BaseComponent, ElementOptions } from "../../src/components/base";
import { BriqpaySdk } from "../../src/briqpay-sdk";
import {
  ComponentOptions,
  PaymentMethod,
} from "../../src/payment-enabler/payment-enabler";
import { BaseOptions } from "../../src/payment-enabler/payment-enabler-briqpay";

class MockComponent extends BaseComponent {
  paymentMethod: ElementOptions["paymentMethod"];

  constructor(
    paymentMethod: PaymentMethod,
    baseOptions: BaseOptions,
    _componentOptions: ComponentOptions
  ) {
    super(paymentMethod, baseOptions, _componentOptions);
    this.paymentMethod = paymentMethod;
  }

  submit() {}

  mount() {}
}

describe("BaseComponent", () => {
  let component: MockComponent;

  const baseOptions: BaseOptions = {
    sdk: new BriqpaySdk({
      processorUrl: "https://mock-processor.com",
      sessionId: "sess-123",
    }),
    processorUrl: "https://mock-processor.com",
    sessionId: "sess-123",
    environment: "test",
    snippet: '<div id="briqpay"></div>',
    briqpaySessionId: "sess-123",
    onComplete: jest.fn(),
    onError: jest.fn(),
  };

  beforeEach(() => {
    component = new MockComponent(PaymentMethod.briqpay, baseOptions, {});
  });

  test("should initialize with provided options", () => {
    expect(component.paymentMethod).toEqual(PaymentMethod.briqpay);
  });

  // Additional tests here
});
