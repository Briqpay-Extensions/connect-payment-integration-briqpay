declare module "*.scss";

interface BriqpayV3 {
  suspend: () => void;
  resume: () => void;
  resumeDecision: () => void;
}

interface BriqpayGlobal {
  v3: BriqpayV3;
  subscribe: (event: string, callback: () => void) => void;
}

declare global {
  interface Window {
    _briqpay: BriqpayGlobal;
  }
}
