import {
  SendSmsResponse,
  SendSmsResponseBody,
  type SendSmsRequest,
} from "@alicloud/dysmsapi20170525";
import { expect, it } from "vitest";
import { AliyunSmsProvider, FakeSmsProvider, SmsProviderError } from "../src/sms/index.js";

it("captures fake messages without imposing a fixed verification code", async () => {
  const provider = new FakeSmsProvider();
  const result = await provider.sendSms({
    phone: "13800000000",
    templateCode: "SMS_123456",
    params: { code: "483920" },
    outId: "test-out-id",
  });
  expect(provider.messages).toEqual([expect.objectContaining({
    phone: "13800000000",
    templateCode: "SMS_123456",
    params: { code: "483920" },
    outId: "test-out-id",
  })]);
  expect(result.providerMessageId).toContain("test-out-id");
});

it("maps a generic SMS request to Aliyun SendSms and returns provider identifiers", async () => {
  let captured: SendSmsRequest | undefined;
  const provider = new AliyunSmsProvider({
    endpoint: "dysmsapi.aliyuncs.com",
    regionId: "cn-hangzhou",
    signName: "思燕家居",
    client: {
      async sendSms(request) {
        captured = request;
        return new SendSmsResponse({
          body: new SendSmsResponseBody({ code: "OK", requestId: "request-id", bizId: "biz-id" }),
        });
      },
    },
  });
  await expect(provider.sendSms({
    phone: "+86 138 0000 0000",
    templateCode: "SMS_123456",
    params: { code: "483920" },
    outId: "challenge-id",
  })).resolves.toEqual({ providerRequestId: "request-id", providerMessageId: "biz-id" });
  expect(captured).toMatchObject({
    phoneNumbers: "13800000000",
    signName: "思燕家居",
    templateCode: "SMS_123456",
    templateParam: JSON.stringify({ code: "483920" }),
    outId: "challenge-id",
  });
});

it("turns non-OK and transport failures into sanitized provider errors", async () => {
  const rejected = new AliyunSmsProvider({
    endpoint: "dysmsapi.aliyuncs.com",
    regionId: "cn-hangzhou",
    signName: "思燕家居",
    client: {
      async sendSms() {
        return new SendSmsResponse({
          body: new SendSmsResponseBody({ code: "isv.BUSINESS_LIMIT_CONTROL", message: "contains provider detail" }),
        });
      },
    },
  });
  await expect(rejected.sendSms({
    phone: "13800000000",
    templateCode: "SMS_123456",
    params: { code: "483920" },
    outId: "challenge-id",
  })).rejects.toMatchObject({
    providerCode: "isv.BUSINESS_LIMIT_CONTROL",
    retryable: true,
    message: "SMS provider request failed",
  });
});
