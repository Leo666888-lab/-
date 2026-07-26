import type { NotificationMessage, NotificationProvider, NotificationSendResult } from "./provider.js";

export class FakeNotificationProvider implements NotificationProvider {
  readonly name = "fake";
  readonly sent: NotificationMessage[] = [];

  constructor(
    private readonly responder?: (message: NotificationMessage) => NotificationSendResult | Promise<NotificationSendResult>,
  ) {}

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    this.sent.push(structuredClone(message));
    if (this.responder) return this.responder(message);
    return {
      outcome: "accepted",
      providerRequestId: `fake-request-${message.outId}`,
      providerMessageId: `fake-message-${message.outId}`,
    };
  }
}
