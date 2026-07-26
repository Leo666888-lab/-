import { SmsProviderError, type SmsProvider } from "../sms/index.js";
import type { NotificationMessage, NotificationProvider, NotificationSendResult } from "./provider.js";

function templateParams(value: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!["string", "number", "boolean"].includes(typeof item)) {
      throw new TypeError("notification template parameters must be scalar values");
    }
    params[key] = String(item);
  }
  return params;
}

export class AliyunSmsNotificationProvider implements NotificationProvider {
  readonly name = "aliyun";

  constructor(
    private readonly sms: SmsProvider,
    private readonly templateCode: string,
  ) {}

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    try {
      const result = await this.sms.sendSms({
        phone: message.destination,
        templateCode: this.templateCode,
        params: templateParams(message.templateParams),
        outId: message.outId,
      });
      if (!result.providerMessageId) {
        throw new Error("SMS provider accepted a notification without a message identifier");
      }
      return {
        outcome: "accepted",
        providerRequestId: result.providerRequestId,
        providerMessageId: result.providerMessageId,
      };
    } catch (error) {
      if (!(error instanceof SmsProviderError) || error.providerCode === "TRANSPORT_ERROR") throw error;
      return {
        outcome: "rejected",
        retryable: error.retryable,
        code: error.providerCode,
      };
    }
  }
}
