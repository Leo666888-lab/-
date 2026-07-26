import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryCache } from "../src/cache/index.js";
import { createPgliteDatabase, type Database } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { DEMO_IDS, seedDemo } from "../src/seed.js";
import { FakeSmsProvider, type SmsMessageInput, type SmsSendResult } from "../src/sms/index.js";

const SMS_SECRET = "sms-test-hmac-key-that-is-at-least-32-characters";
const SMS_TEMPLATE = "SMS_123456789";

interface Fixture {
  app: FastifyInstance;
  cache: MemoryCache;
  database: Database;
  provider: FakeSmsProvider;
}

async function createFixture(options: {
  provider?: FakeSmsProvider;
  cache?: MemoryCache;
  smsVerifyMaxAttempts?: number;
  smsResponseMinMs?: number;
  smsResendCooldownSeconds?: number;
  smsSendRateLimitMax?: number;
  smsSendRateLimitIpMax?: number;
  smsSendRateLimitWindowSeconds?: number;
  enabled?: boolean;
} = {}): Promise<Fixture> {
  const database = await createPgliteDatabase(":memory:");
  await migrate(database);
  await seedDemo(database);
  const cache = options.cache ?? new MemoryCache();
  const provider = options.provider ?? new FakeSmsProvider();
  const enabled = options.enabled ?? true;
  const app = buildApp({
    database,
    cache,
    publicOrigin: "http://localhost",
    smsProvider: enabled ? provider : undefined,
    smsCodeHmacKey: enabled ? SMS_SECRET : undefined,
    smsLoginTemplateCode: enabled ? SMS_TEMPLATE : undefined,
    smsVerifyMaxAttempts: options.smsVerifyMaxAttempts,
    smsResponseMinMs: options.smsResponseMinMs ?? 0,
    smsResendCooldownSeconds: options.smsResendCooldownSeconds,
    smsSendRateLimitMax: options.smsSendRateLimitMax,
    smsSendRateLimitIpMax: options.smsSendRateLimitIpMax,
    smsSendRateLimitWindowSeconds: options.smsSendRateLimitWindowSeconds,
  });
  await app.ready();
  return { app, cache, database, provider };
}

describe.sequential("SMS authentication", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.allSettled(fixtures.splice(0).flatMap((fixture) => [
      fixture.app.close(),
      fixture.cache.close(),
      fixture.database.close(),
    ]));
  });

  it("sends a random code, stores only its digest, and issues the existing secure session", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const sent = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/sms-codes",
      payload: { phone: "+86 138 0000 0000" },
    });
    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toMatchObject({
      accepted: true,
      expiresInSeconds: 300,
      retryAfterSeconds: 60,
    });
    expect(sent.body).not.toContain("testCode");
    expect(sent.body).not.toContain('"code"');
    expect(fixture.provider.messages).toHaveLength(1);
    const message = fixture.provider.messages[0];
    const code = message?.params.code;
    const challengeId = sent.json().challengeId as string;
    expect(message).toMatchObject({ phone: "13800000000", templateCode: SMS_TEMPLATE, outId: challengeId });
    expect(code).toMatch(/^\d{6}$/);
    const cached = await fixture.cache.get(`sms:challenge:login:${challengeId}`);
    expect(cached).toMatch(/^[a-f0-9]{64}$/);
    expect(cached).not.toBe(code);

    const login = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/sms-login",
      payload: { phone: "+8613800000000", challengeId, code },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ role: "owner", user: { phone: "13800000000" } });
    expect(login.headers["set-cookie"]).toContain("settlement_session=");
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]).toContain("SameSite=Strict");

    const verified = await fixture.database.query<{ phone_verified_at: Date | string | null }>(
      "SELECT phone_verified_at FROM users WHERE id = $1",
      [DEMO_IDS.user],
    );
    expect(verified.rows[0]?.phone_verified_at).not.toBeNull();

    const stored = await fixture.database.query<{ token_hash: string }>(
      "SELECT token_hash FROM sessions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1",
      [DEMO_IDS.tenant],
    );
    expect(stored.rows[0]?.token_hash).toHaveLength(64);
    expect(stored.rows[0]?.token_hash).not.toBe(login.json().token);

    const replay = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/sms-login",
      payload: { phone: "13800000000", challengeId, code },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("INVALID_SMS_CODE");
  });

  it("does not mark a phone as verified after password login", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const login = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "13800000000", password: "demo1234" },
    });
    expect(login.statusCode).toBe(200);
    const user = await fixture.database.query<{ phone_verified_at: Date | string | null }>(
      "SELECT phone_verified_at FROM users WHERE id = $1",
      [DEMO_IDS.user],
    );
    expect(user.rows[0]?.phone_verified_at).toBeNull();
  });

  it("limits wrong guesses and keeps every invalid challenge response indistinguishable", async () => {
    const fixture = await createFixture({ smsVerifyMaxAttempts: 2 });
    fixtures.push(fixture);
    const sent = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/sms-codes",
      payload: { phone: "13800000000" },
    });
    const challengeId = sent.json().challengeId as string;
    const correctCode = fixture.provider.messages[0]?.params.code;
    const wrongCode = correctCode === "000000" ? "000001" : "000000";
    const attempts = [];
    for (const code of [wrongCode, wrongCode, correctCode]) {
      attempts.push(await fixture.app.inject({
        method: "POST",
        url: "/api/auth/sms-login",
        payload: { phone: "13800000000", challengeId, code },
      }));
    }
    expect(attempts.map((response) => response.statusCode)).toEqual([401, 401, 401]);
    expect(attempts.map((response) => response.json().error.code)).toEqual([
      "INVALID_SMS_CODE",
      "INVALID_SMS_CODE",
      "INVALID_SMS_CODE",
    ]);
  });

  it("allows only one concurrent use of a correct code", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const sent = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/sms-codes",
      payload: { phone: "13800000000" },
    });
    const request = {
      method: "POST" as const,
      url: "/api/auth/sms-login",
      payload: {
        phone: "13800000000",
        challengeId: sent.json().challengeId,
        code: fixture.provider.messages[0]?.params.code,
      },
    };
    const responses = await Promise.all([fixture.app.inject(request), fixture.app.inject(request)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
  });

  it("rejects an expired code and enforces the send window independently of cooldown", async () => {
    let now = 1_000;
    const cache = new MemoryCache(() => now);
    const fixture = await createFixture({
      cache,
      smsResendCooldownSeconds: 1,
      smsSendRateLimitMax: 2,
      smsSendRateLimitIpMax: 20,
      smsSendRateLimitWindowSeconds: 3_600,
    });
    fixtures.push(fixture);

    const first = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/sms-codes",
      payload: { phone: "13800000000" },
    });
    const firstCode = fixture.provider.messages[0]?.params.code;
    now += 301_000;
    const expired = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/sms-login",
      payload: { phone: "13800000000", challengeId: first.json().challengeId, code: firstCode },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe("INVALID_SMS_CODE");

    const second = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/sms-codes",
      payload: { phone: "13800000000" },
    });
    now += 1_001;
    const limited = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/sms-codes",
      payload: { phone: "13800000000" },
    });
    expect(second.statusCode).toBe(202);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("SMS_CODE_RATE_LIMITED");
  });

  it("returns the same generic result for unknown users and provider failures without releasing cooldown", async () => {
    const provider = new FakeSmsProvider();
    provider.failure = new Error("provider detail must remain internal");
    const fixture = await createFixture({ provider, smsResponseMinMs: 20 });
    fixtures.push(fixture);

    const requestCode = async (phone: string) => {
      const startedAt = Date.now();
      const response = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/sms-codes",
        payload: { phone },
      });
      return { response, elapsedMs: Date.now() - startedAt };
    };
    const known = await requestCode("13800000000");
    const unknown = await requestCode("13912345678");
    expect(known.response.statusCode).toBe(202);
    expect(unknown.response.statusCode).toBe(202);
    expect(Object.keys(known.response.json()).sort()).toEqual(Object.keys(unknown.response.json()).sort());
    expect(known.response.json()).toMatchObject({ accepted: true, expiresInSeconds: 300, retryAfterSeconds: 60 });
    expect(unknown.response.json()).toMatchObject({ accepted: true, expiresInSeconds: 300, retryAfterSeconds: 60 });
    expect(known.elapsedMs).toBeGreaterThanOrEqual(15);
    expect(unknown.elapsedMs).toBeGreaterThanOrEqual(15);

    const repeated = await requestCode("13800000000");
    expect(repeated.response.statusCode).toBe(429);
    expect(repeated.response.json().error.code).toBe("SMS_CODE_RATE_LIMITED");
    expect(repeated.response.headers["retry-after"]).toBe("60");
  });

  it("does not expose registered phones through a slow provider and drains sends on close", async () => {
    let releaseSend: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const sendStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    class SlowSmsProvider extends FakeSmsProvider {
      override async sendSms(input: SmsMessageInput): Promise<SmsSendResult> {
        markStarted();
        await sendGate;
        return super.sendSms(input);
      }
    }

    const fixture = await createFixture({ provider: new SlowSmsProvider(), smsResponseMinMs: 30 });
    fixtures.push(fixture);
    const requestCode = async (phone: string) => {
      const startedAt = Date.now();
      const response = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/sms-codes",
        payload: { phone },
      });
      return { response, elapsedMs: Date.now() - startedAt };
    };

    const known = await requestCode("13800000000");
    await sendStarted;
    const unknown = await requestCode("13912345678");
    expect(known.response.statusCode).toBe(202);
    expect(unknown.response.statusCode).toBe(202);
    expect(Object.keys(known.response.json()).sort()).toEqual(Object.keys(unknown.response.json()).sort());
    expect(known.elapsedMs).toBeGreaterThanOrEqual(25);
    expect(unknown.elapsedMs).toBeGreaterThanOrEqual(25);
    expect(known.elapsedMs).toBeLessThan(250);
    expect(Math.abs(known.elapsedMs - unknown.elapsedMs)).toBeLessThan(100);
    expect(fixture.provider.messages).toHaveLength(0);

    let closed = false;
    const close = fixture.app.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    releaseSend();
    await close;
    expect(closed).toBe(true);
    expect(fixture.provider.messages).toHaveLength(1);
  });

  it("fails closed when SMS is disabled or verification storage is unavailable", async () => {
    const disabled = await createFixture({ enabled: false });
    fixtures.push(disabled);
    const unavailable = await disabled.app.inject({
      method: "POST",
      url: "/api/auth/sms-codes",
      payload: { phone: "13800000000" },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe("SMS_UNAVAILABLE");

    class BrokenCache extends MemoryCache {
      override async setIfAbsent(): Promise<boolean> {
        throw new Error("cache unavailable");
      }
    }
    const broken = await createFixture({ cache: new BrokenCache() });
    fixtures.push(broken);
    const failedClosed = await broken.app.inject({
      method: "POST",
      url: "/api/auth/sms-codes",
      payload: { phone: "13800000000" },
    });
    expect(failedClosed.statusCode).toBe(503);
    expect(failedClosed.json().error.code).toBe("SMS_VERIFICATION_UNAVAILABLE");
    expect(broken.provider.messages).toHaveLength(0);

    class BrokenConsumeCache extends MemoryCache {
      failConsume = false;
      override async consumeOneTimeValue(key: string, expectedValue: string, maxAttempts: number) {
        if (this.failConsume) throw new Error("cache unavailable");
        return super.consumeOneTimeValue(key, expectedValue, maxAttempts);
      }
    }
    const consumeCache = new BrokenConsumeCache();
    const brokenConsume = await createFixture({ cache: consumeCache });
    fixtures.push(brokenConsume);
    const sent = await brokenConsume.app.inject({
      method: "POST",
      url: "/api/auth/sms-codes",
      payload: { phone: "13800000000" },
    });
    consumeCache.failConsume = true;
    const verifyFailedClosed = await brokenConsume.app.inject({
      method: "POST",
      url: "/api/auth/sms-login",
      payload: {
        phone: "13800000000",
        challengeId: sent.json().challengeId,
        code: brokenConsume.provider.messages[0]?.params.code,
      },
    });
    expect(verifyFailedClosed.statusCode).toBe(503);
    expect(verifyFailedClosed.json().error.code).toBe("SMS_VERIFICATION_UNAVAILABLE");
  });
});
