declare module 'web-push' {
  type PushSubscription = {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  type WebPushError = Error & { statusCode?: number };
  const webPush: {
    sendNotification(subscription: PushSubscription, payload?: string): Promise<unknown>;
  };
  export default webPush;
}
