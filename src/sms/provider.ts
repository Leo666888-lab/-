export interface SmsMessageInput {
  phone: string;
  templateCode: string;
  params: Readonly<Record<string, string>>;
  outId: string;
}

export interface SmsSendResult {
  providerRequestId?: string;
  providerMessageId?: string;
}

export interface SmsProvider {
  readonly name: string;
  sendSms(input: SmsMessageInput): Promise<SmsSendResult>;
}

export class SmsProviderError extends Error {
  constructor(
    public readonly providerCode: string,
    public readonly retryable: boolean,
  ) {
    super("SMS provider request failed");
    this.name = "SmsProviderError";
  }
}
