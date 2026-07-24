import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addDaysToDateInput,
  buildCreateOrderPayload,
  escapeAttr,
  escapeHtml,
  groupOutstanding,
  normalizeBootstrap,
  roleCan,
  settlementRequest,
  toDateInputValue,
  toDateTimeInputValue,
  toIsoDateTime,
  yuanToCents
} from "./frontend-core.js";

const publicDir = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(publicDir, "styles.css"), "utf8");

test("escapes API text and quoted attribute values", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('x')"> & العربية`),
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; العربية"
  );
  assert.equal(
    escapeAttr(`id" autofocus onfocus="alert(1)`),
    "id&quot; autofocus onfocus=&quot;alert(1)"
  );
});

test("normalizes bootstrap data while preserving Chinese, English, and Arabic", () => {
  const data = normalizeBootstrap({
    user: { id: "u1", phone: "13800000000", displayName: "财务 Finance المالية" },
    tenant: { id: "t1", name: "义乌 Trading شركة", timezone: "Asia/Shanghai" },
    role: "finance",
    orders: [{
      id: "o1",
      partnerId: "p1",
      partnerName: "迪拜 النور Trading",
      orderNo: "طلب-中文-001",
      direction: "receivable",
      fulfillmentStatus: "fulfilled",
      settlementStatus: "partial",
      currency: "USD",
      totalCents: 10000,
      paidCents: 3000,
      outstandingCents: 7000,
      payments: [{
        id: "pay1",
        amountCents: 3000,
        method: "bank_transfer",
        reversedAt: "2026-07-25T01:02:03.000Z",
        reversalReason: "重复入账 Duplicate قيد مكرر"
      }]
    }],
    partners: [{ id: "p1", version: 4, name: "迪拜 النور Trading", kind: "customer", balances: [] }],
    reminders: [{ id: "r1", orderId: "o1", partnerName: "迪拜 النور Trading", direction: "receivable", outstandingCents: 7000 }]
  });

  assert.equal(data.user.displayName, "财务 Finance المالية");
  assert.equal(data.orders[0].partnerName, "迪拜 النور Trading");
  assert.equal(data.orders[0].orderNo, "طلب-中文-001");
  assert.equal(data.orders[0].payments[0].reversedAt, "2026-07-25T01:02:03.000Z");
  assert.equal(data.orders[0].payments[0].reversalReason, "重复入账 Duplicate قيد مكرر");
  assert.equal(data.partners[0].version, 4);
  assert.equal(data.role, "finance");
});

test("keeps balances separated by currency", () => {
  const orders = normalizeBootstrap({
    orders: [
      { direction: "receivable", fulfillmentStatus: "fulfilled", currency: "CNY", totalCents: 10000, paidCents: 0, outstandingCents: 10000 },
      { direction: "receivable", fulfillmentStatus: "fulfilled", currency: "USD", totalCents: 20000, paidCents: 5000, outstandingCents: 15000 },
      { direction: "receivable", fulfillmentStatus: "planned", currency: "CNY", totalCents: 90000, paidCents: 0, outstandingCents: 90000 },
      { direction: "payable", fulfillmentStatus: "fulfilled", currency: "CNY", totalCents: 5000, paidCents: 0, outstandingCents: 5000 }
    ]
  }).orders;

  assert.deepEqual(groupOutstanding(orders, "receivable"), [
    { currency: "CNY", cents: 10000 },
    { currency: "USD", cents: 15000 }
  ]);
});

test("builds exact integer-cent create-order payloads", () => {
  const payload = buildCreateOrderPayload({
    partnerId: "33333333-3333-4333-8333-333333333333",
    orderNo: " طلب-001 ",
    direction: "receivable",
    orderDate: "2026-07-25",
    plannedDeliveryDate: "2026-07-28",
    settlementCycle: "months:3",
    customSettlementDays: "",
    currency: "USD",
    notes: " 中文 English العربية ",
    items: [{ description: " Sports Socks جوارب ", quantity: "12", unitPrice: "25.08" }]
  });

  assert.equal(payload.orderNo, "طلب-001");
  assert.equal(payload.settlementMonths, 3);
  assert.equal(payload.settlementDays, 0);
  assert.equal(payload.items[0].unitPriceCents, 2508);
  assert.equal(payload.items[0].quantity, 12);
  assert.equal(payload.notes, "中文 English العربية");
});

test("validates money, custom terms, and role permissions", () => {
  assert.equal(yuanToCents("0.01"), 1);
  assert.equal(yuanToCents("3000"), 300000);
  assert.throws(() => yuanToCents("1.001"), /两位小数/);
  assert.deepEqual(settlementRequest("custom", "45"), { settlementDays: 45, settlementMonths: 0 });
  assert.throws(() => settlementRequest("custom", "3.5"), /0 到 3650/);
  assert.equal(roleCan("finance", "payment"), true);
  assert.equal(roleCan("sales", "payment"), false);
  assert.equal(roleCan("owner", "reversePayment"), true);
  assert.equal(roleCan("finance", "reversePayment"), true);
  assert.equal(roleCan("sales", "reversePayment"), false);
  assert.equal(roleCan("sales", "cancelOrder"), true);
  assert.equal(roleCan("viewer", "cancelOrder"), false);
  assert.equal(roleCan("sales", "partner"), true);
  assert.equal(roleCan("viewer", "partner"), false);
});

test("uses the enterprise timezone for date and datetime-local values", () => {
  const utcBoundary = new Date("2026-07-24T16:30:00.000Z");
  assert.equal(toDateInputValue(utcBoundary, "Asia/Shanghai"), "2026-07-25");
  assert.equal(toDateTimeInputValue(utcBoundary, "Asia/Shanghai"), "2026-07-25T00:30");
  assert.equal(addDaysToDateInput("2026-07-25", 2), "2026-07-27");
  assert.equal(addDaysToDateInput("2024-02-28", 1), "2024-02-29");
  assert.throws(() => addDaysToDateInput("2026-02-31", 1), /有效日期/);
  assert.equal(toIsoDateTime("2026-07-25T00:30", "Asia/Shanghai"), utcBoundary.toISOString());
  assert.throws(() => toIsoDateTime("2026-02-31T12:00", "Asia/Shanghai"), /有效时间/);
});

test("uses real API mutations and never persists session tokens in browser storage", () => {
  assert.doesNotMatch(appSource, /localStorage|sessionStorage|indexedDB/);
  assert.match(appSource, /credentials:\s*"same-origin"/);
  assert.match(appSource, /"\/api\/auth\/login"/);
  assert.match(appSource, /"\/api\/bootstrap"/);
  assert.match(appSource, /"\/api\/orders"/);
  assert.match(appSource, /\/fulfill`/);
  assert.match(appSource, /\/payments`/);
  assert.match(appSource, /\/api\/payments\/\$\{encodeURIComponent\(paymentId\)\}\/reverse`/);
  assert.match(appSource, /\/cancel`/);
  assert.match(appSource, /\/ack`/);
  assert.match(appSource, /\/snooze`/);
  assert.match(appSource, /"\/api\/partners"/);
  assert.match(appSource, /method:\s*"PATCH"/);
  assert.match(appSource, /"\/api\/auth\/logout"/);
  assert.match(appSource, /"\/api\/auth\/change-password"/);
  assert.match(appSource, /"Idempotency-Key"/);
  assert.match(appSource, /toDateInputValue\(new Date\(\), tenantTimeZone\(\)\)/);
  assert.match(appSource, /toDateTimeInputValue\(new Date\(\), tenantTimeZone\(\)\)/);
  assert.doesNotMatch(appSource, /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/);
  assert.match(indexSource, /id="reversalModal"/);
  assert.match(indexSource, /id="cancelOrderModal"/);
  assert.doesNotMatch(appSource, /applyDemoImport|state\.orders\.(?:push|unshift)/);
});

test("is CSP-friendly and self-hosts visual dependencies", () => {
  assert.match(indexSource, /<meta charset="UTF-8"/);
  assert.match(indexSource, /src="\.\/vendor\/lucide\.js"/);
  assert.doesNotMatch(indexSource, /https?:\/\//);
  assert.doesNotMatch(indexSource, /<script(?![^>]*src=)[^>]*>\s*\S/);
  assert.equal(fs.existsSync(path.join(publicDir, "vendor", "lucide.js")), true);
  assert.equal(fs.existsSync(path.join(publicDir, "vendor", "lucide.LICENSE.txt")), true);
  assert.doesNotMatch(stylesSource, /\.login-story::after/);
});
