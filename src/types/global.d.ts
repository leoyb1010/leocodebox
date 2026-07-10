export {};

declare global {
  interface Window {
    __ROUTER_BASENAME__?: string;
    leocodeboxLocal?: { enabled: boolean };
  }

  interface EventSourceEventMap {
    result: MessageEvent;
    progress: MessageEvent;
    done: MessageEvent;
  }
}
