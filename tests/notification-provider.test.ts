import { describe, expect, it } from "vitest";
import { AliyunSmsNotificationProvider } from "../src/notifications/aliyun-sms-provider.js";
import { FakeSmsProvider, SmsProviderError } from "../src/sms/index.js";

const message = {
  outId: "bb000000-0000-4000-8000-000000000001",
  channel: "sms" as const,
  destination: "13800000000",
  locale: "zh-CN",
  templateKey: "settlement_daily_digest",
  templateParams: { count: 3 },
};

describe("Aliyun notification adapter", () => {
  it("maps a daily digest to the approved SMS template", async () => {
    const sms = new FakeSmsProvider();
    const provider = new AliyunSmsNotificationProvider(sms, "SMS_123456789");

    await expect(provider.send(message)).resolves.toMatchObject({
      outcome: "accepted",
      providerMessageId: `fake-message-${message.outId}`,
    });
    expect(sms.messages[0]).toMatchObject({
      phone: "13800000000",
      templateCode: "SMS_123456789",
      params: { count: "3" },
      outId: message.outId,
    });
  });

  it("returns definitive provider rejections but preserves transport ambiguity", async () => {
    const sms = new FakeSmsProvider();
    const provider = new AliyunSmsNotificationProvider(sms, "SMS_123456789");

    sms.failure = new SmsProviderError("isv.BUSINESS_LIMIT_CONTROL", true);
    await expect(provider.send(message)).resolves.toEqual({
      outcome: "rejected",
      retryable: true,
      code: "isv.BUSINESS_LIMIT_CONTROL",
    });

    sms.failure = new SmsProviderError("TRANSPORT_ERROR", true);
    await expect(provider.send(message)).rejects.toMatchObject({
      providerCode: "TRANSPORT_ERROR",
    });
  });

  it("rejects nested template parameters before contacting the provider", async () => {
    const sms = new FakeSmsProvider();
    const provider = new AliyunSmsNotificationProvider(sms, "SMS_123456789");
    await expect(provider.send({
      ...message,
      templateParams: { count: { unsafe: true } },
    })).rejects.toThrow(/scalar values/);
    expect(sms.messages).toHaveLength(0);
  });
});
