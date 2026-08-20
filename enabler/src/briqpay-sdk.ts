import { toBriqpayProcessorError } from "./errors";
import { PaymentRequestSchemaDTO } from "./dtos/mock-payment.dto";
import { PaymentResult } from "./payment-enabler/payment-enabler";

export enum BRIQPAY_DECISION {
  ALLOW = "allow",
  REJECT = "reject",
}

export enum BRIQPAY_REJECT_TYPE {
  REJECT_WITH_ERROR = "reject_session_with_error",
  NOTIFY_USER = "notify_user",
}

export type BriqpayDecisionOptions = {
  rejectionType?: BRIQPAY_REJECT_TYPE;
  hardError?: {
    message: string;
  };
  softErrors?: {
    message: string;
  }[];
};

export type DecisionAnswer = {
  decision: BRIQPAY_DECISION;
} & BriqpayDecisionOptions;

/**
 * Matches Briqpay's default wait, so the decision is abandoned as Briqpay gives
 * up on it rather than after. Merchants granted a longer window wait 40s there.
 */
export const DECISION_TIMEOUT_MS = 20000;

/**
 * Represents a Briqpay SDK.
 */
export class BriqpaySdk {
  /**
   * Adds and overlay over the payment methods during cart updates for example
   */
  suspend() {
    window._briqpay.v3.suspend();
  }

  /**
   * Remove the suspend overlay and rehydrate the iframe with the latest data
   */
  resume() {
    window._briqpay.v3.resume();
  }
}

export type OnDecision = (
  _sdk: BriqpaySdk,
  _data: unknown,
) => Promise<DecisionAnswer>;

declare global {
  interface Window {
    /**
     * This connector's own merchant-config namespace — distinct from
     * `window._briqpay`, which is Briqpay's core widget script's global
     * (briq.min.js, shared across every Briqpay integration, exposing
     * subscribe()/v3.suspend()/v3.resume()/v3.resumeDecision()). Merchants
     * never assign onto `_briqpay`, only call into it; `briqpayConnector`
     * is the opposite direction — a namespace the merchant writes into
     * and this connector's enabler reads. Kept as one shared root object,
     * the same shape commercetools' own SDK uses for window.
     * commercetoolsCheckout, so future connector-level config can live
     * here as sibling keys instead of minting a new global each time.
     */
    briqpayConnector?: {
      /**
       * The merchant's purchase-decision handler. Optional — the
       * connector requests the decision step on every session it creates,
       * so Briqpay will ask for a decision, but if nothing is registered
       * here the enabler answers ALLOW automatically and the purchase
       * proceeds as normal. Register a handler only if you want to run
       * your own validation first. Briqpay decides when a decision is
       * needed, so do not assume it fires on every submission.
       *
       * Validate here, then return the answer. Returning it is what
       * sends it. Once registered, not answering within 20 seconds
       * abandons the decision and nothing is sent; Briqpay blocks the
       * purchase and asks the buyer to retry. A slow or throwing handler
       * is NOT treated as an allow — only the absence of any registered
       * handler is.
       *
       * This is only ever read, never called, by the enabler — so it can
       * be set at any time before the buyer reaches the payment step,
       * with no dependency on the enabler having loaded yet. That matters
       * because under commercetools' hosted paymentFlow/checkoutFlow, the
       * enabler bundle is injected by commercetools' own checkout
       * application at a time the merchant does not control; requiring a
       * function call into enabler code would race against that. Assign
       * the object directly:
       *
       *   window.briqpayConnector = window.briqpayConnector || {};
       *   window.briqpayConnector.onDecision = async (sdk, data) => {...};
       *
       * registerBriqpayDecision() below is equivalent sugar for merchants
       * who import this package directly (e.g. building a custom UI with
       * createDropinBuilder/createComponentBuilder) and don't have that
       * load-order problem in the first place.
       */
      onDecision?: OnDecision;
    };

    /**
     * Briqpay's widget script global (briq.min.js), shared page-wide; call into
     * it, never assign onto it. subscribe appends; unsubscribe clears an event.
     */
    _briqpay: {
      subscribe: (
        _event: string,
        _callback: (_data: Record<string, unknown>) => void,
      ) => void;
      unsubscribe: (_event: string) => void;
      v3: {
        suspend: () => void;
        resume: () => void;
        resumeDecision: () => void;
      };
    };
  }
}

/**
 * Convenience wrapper around assigning `window.briqpayConnector.onDecision`
 * directly (see the type doc above) — identical effect, just callable if
 * you already import this package. Prefer the direct assignment instead
 * when your page can't guarantee this module has loaded before you need
 * to register (e.g. under commercetools' hosted paymentFlow, where the
 * enabler bundle's load timing is out of your control).
 */
export function registerBriqpayDecision(onDecision: OnDecision): void {
  window.briqpayConnector = window.briqpayConnector || {};
  window.briqpayConnector.onDecision = onDecision;
}

/**
 * Reads the handler registered via registerBriqpayDecision(). Used
 * internally by the dropin/component; not something merchants call.
 */
export function getRegisteredOnDecision(): OnDecision | undefined {
  return typeof window !== "undefined"
    ? window.briqpayConnector?.onDecision
    : undefined;
}

/** Everything the decision flow needs from whichever component mounted it. */
export type BriqpayDecisionContext = {
  sdk: BriqpaySdk;
  processorUrl: string;
  sessionId: string;
  briqpaySessionId: string;
  onError: (
    _error: unknown,
    _context?: { paymentReference?: string },
  ) => void | Promise<void>;
};

async function resolveDecisionAnswer(
  ctx: BriqpayDecisionContext,
  data: unknown,
): Promise<DecisionAnswer | undefined> {
  const onDecision = getRegisteredOnDecision();
  if (!onDecision) {
    // Nobody opted into registerBriqpayDecision(), so there is no merchant
    // check to run - let the purchase proceed. This is different from a
    // registered handler that times out or throws below: that merchant
    // asked for validation, so a broken/slow check must not silently turn
    // into an approval it never made.
    return { decision: BRIQPAY_DECISION.ALLOW };
  }

  // A late answer loses the race and is never sent, so a verdict Briqpay has
  // already timed out on cannot land. A throw is not an answer either.
  return Promise.race([
    onDecision(ctx.sdk, data),
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), DECISION_TIMEOUT_MS),
    ),
  ]).catch(() => undefined);
}

function isValidDecisionAnswer(
  decisionAnswer: unknown,
): decisionAnswer is DecisionAnswer {
  return (
    typeof decisionAnswer === "object" &&
    decisionAnswer !== null &&
    "decision" in decisionAnswer &&
    ((decisionAnswer as { decision: unknown }).decision ===
      BRIQPAY_DECISION.ALLOW ||
      (decisionAnswer as { decision: unknown }).decision ===
        BRIQPAY_DECISION.REJECT)
  );
}

async function sendDecision(
  ctx: BriqpayDecisionContext,
  decisionAnswer: DecisionAnswer,
): Promise<void> {
  const response = await fetch(ctx.processorUrl + "/decision", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": ctx.sessionId,
    },
    body: JSON.stringify({
      sessionId: ctx.briqpaySessionId,
      ...decisionAnswer,
    }),
  });

  if (!response.ok) {
    throw toBriqpayProcessorError(
      "/decision",
      response.status,
      await response.text(),
    );
  }
}

export async function handleBriqpayDecision(
  ctx: BriqpayDecisionContext,
  data: unknown,
): Promise<void> {
  // Briqpay blocks its own pay-button flow while awaiting the decision, so
  // nothing needs suspending here. resumeDecision() releases that block.
  // suspend()/resume() are a separate mechanism for cart updates and are not
  // cleared by resumeDecision().
  const decisionAnswer = await resolveDecisionAnswer(ctx, data);

  // Nothing usable. Briqpay gates on the decision it recorded, so unlocking
  // without one fails the purchase and shows the buyer an error.
  if (!isValidDecisionAnswer(decisionAnswer)) {
    window._briqpay.v3.resumeDecision();
    return;
  }

  try {
    await sendDecision(ctx, decisionAnswer);
  } catch (error) {
    // The decision never reached Briqpay. Surface it: on an expired CT session
    // (401 invalid_token) the integrator can mint a fresh session and remount,
    // instead of every retry failing until a full page reload.
    try {
      await ctx.onError(error);
    } catch {
      // onError must not prevent the resume below.
    }
  } finally {
    window._briqpay.v3.resumeDecision();
  }
}

/** Everything the payment submission needs from whichever component mounted it. */
export type BriqpaySubmitContext = {
  processorUrl: string;
  sessionId: string;
  paymentMethodType: string;
  onComplete: (_result: PaymentResult) => void | Promise<void>;
};

// Creates the commercetools-side payment record once the buyer has paid at
// Briqpay. onComplete fires only on a 2xx; failures reject, so whoever called
// submit() handles them where they have the context to react. Failures with no
// caller to reject to (the session_complete subscriber) go to onError instead.
export async function submitBriqpayPayment(
  ctx: BriqpaySubmitContext,
): Promise<void> {
  const request: PaymentRequestSchemaDTO = {
    paymentMethod: { type: ctx.paymentMethodType },
  };
  const response = await fetch(ctx.processorUrl + "/payments", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": ctx.sessionId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw toBriqpayProcessorError(
      "/payments",
      response.status,
      await response.text(),
    );
  }

  const data = (await response.json()) as { paymentReference: string };
  await ctx.onComplete({
    isSuccess: true,
    paymentReference: data.paymentReference,
  });
}
