import type { SmsMessageInput, SmsProvider, SmsSendResult } from "./provider.js";

export interface FakeSmsMessage extends SmsMessageInput {
  sentAt: string;
}

export class FakeSmsProvider implements SmsProvider {
  readonly name = "fake";
  readonly messages: FakeSmsMessage[] = [];
  failure: Error | null = null;

  async sendSms(input: SmsMessageInput): Promise<SmsSendResult> {
    if (this.failure) throw this.failure;
    this.messages.push({ ...input, params: { ...input.params }, sentAt: new Date().toISOString() });
    return {
      providerRequestId: `fake-request-${input.outId}`,
      providerMessageId: `fake-message-${input.outId}`,
    };
  }
}
