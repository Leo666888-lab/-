export interface NotificationMessage {
  outId: string;
  channel: "sms";
  destination: string;
  locale: string;
  templateKey: string;
  templateParams: Record<string, unknown>;
}

export type NotificationSendResult =
  | {
    outcome: "accepted";
    providerRequestId?: string;
    providerMessageId: string;
  }
  | {
    outcome: "rejected";
    retryable: boolean;
    code: string;
    providerRequestId?: string;
  };

export interface NotificationProvider {
  readonly name: string;
  send(message: NotificationMessage): Promise<NotificationSendResult>;
  close?(): Promise<void>;
}
