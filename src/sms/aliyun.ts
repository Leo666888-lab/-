import CredentialPackage from "@alicloud/credentials";
import DysmsPackage, { SendSmsRequest, type SendSmsResponse } from "@alicloud/dysmsapi20170525";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import { phoneForAliyun } from "../lib/phone.js";
import { SmsProviderError, type SmsMessageInput, type SmsProvider, type SmsSendResult } from "./provider.js";

interface AliyunSmsClient {
  sendSms(request: SendSmsRequest): Promise<SendSmsResponse>;
}

interface CredentialLike {
  getCredential(): Promise<unknown>;
}

const Credential = (CredentialPackage as unknown as { default: new () => CredentialLike }).default;
const DysmsClient = (DysmsPackage as unknown as {
  default: new (config: OpenApiConfig) => AliyunSmsClient;
}).default;

export interface AliyunSmsProviderOptions {
  endpoint: string;
  regionId: string;
  signName: string;
  client?: AliyunSmsClient;
}

export class AliyunSmsProvider implements SmsProvider {
  readonly name = "aliyun";
  private readonly client: AliyunSmsClient;

  constructor(private readonly options: AliyunSmsProviderOptions) {
    this.client = options.client ?? new DysmsClient(new OpenApiConfig({
      credential: new Credential(),
      endpoint: options.endpoint,
      regionId: options.regionId,
      protocol: "https",
      connectTimeout: 2_000,
      readTimeout: 5_000,
    }));
  }

  async sendSms(input: SmsMessageInput): Promise<SmsSendResult> {
    let response: SendSmsResponse;
    try {
      response = await this.client.sendSms(new SendSmsRequest({
        phoneNumbers: phoneForAliyun(input.phone),
        signName: this.options.signName,
        templateCode: input.templateCode,
        templateParam: JSON.stringify(input.params),
        outId: input.outId,
      }));
    } catch {
      throw new SmsProviderError("TRANSPORT_ERROR", true);
    }

    const code = response.body?.code ?? "INVALID_RESPONSE";
    if (code !== "OK") {
      const retryable = /^(?:isv\.BUSINESS_LIMIT_CONTROL|isv\.SYSTEM_ERROR|INTERNAL_ERROR|SYSTEM_ERROR)$/i.test(code);
      throw new SmsProviderError(code.slice(0, 128), retryable);
    }
    return {
      providerRequestId: response.body?.requestId,
      providerMessageId: response.body?.bizId,
    };
  }
}
