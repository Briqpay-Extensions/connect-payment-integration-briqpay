import { describe, expect, jest, test } from "@jest/globals";
import {
  DropinEmbeddedBuilder,
  DropinComponents,
} from "../../src/dropin/dropin-embedded";
import { DropinOptions } from "../../src/payment-enabler/payment-enabler";

describe("DropinEmbeddedBuilder", () => {
  test("should create DropinComponents with correct config", () => {
    const baseOptions = { sdk: {} } as any;
    const builder = new DropinEmbeddedBuilder(baseOptions);

    const config: DropinOptions = {
      onDropinReady: jest.fn<any>(), // Mock it to return a Promise
    };

    const dropin = builder.build(config);

    expect(dropin).toBeInstanceOf(DropinComponents);
    expect(dropin["dropinOptions"].onDropinReady).toBe(config.onDropinReady);
  });

  test("should set dropinHasSubmit to false by default", () => {
    const builder = new DropinEmbeddedBuilder({} as any);
    expect(builder.dropinHasSubmit).toBe(false);
  });
});

describe("DropinComponents", () => {
  test("should initialize with given options", () => {
    const config: DropinOptions = { onDropinReady: jest.fn<any>() };
    const dropin = new DropinComponents({ dropinOptions: config });

    dropin.init();

    expect(config.onDropinReady).toHaveBeenCalled();
  });

  test("should mount content in the specified selector", () => {
    const div = document.createElement("div");
    div.id = "test-div";
    document.body.appendChild(div);

    const dropin = new DropinComponents({
      dropinOptions: { onDropinReady: jest.fn<any>() },
    });

    dropin.mount("#" + div.id);

    expect(div.innerHTML).toBe("Dropin Embedded");
  });

  test("submit() should throw an error", () => {
    const dropin = new DropinComponents({
      dropinOptions: { onDropinReady: jest.fn<any>() },
    });

    expect(() => dropin.submit()).toThrowError("Implementation not provided");
  });
});
