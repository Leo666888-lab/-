import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addDaysToDateInput,
  buildCreateOrderPayload,
  daysBetweenDateInputs,
  dueBucketForDateInputs,
  escapeAttr,
  escapeHtml,
  formatFileSize,
  groupOutstanding,
  normalizeBootstrap,
  orderStatus,
  roleCan,
  settlementRequest,
  toDateInputValue,
  toDateTimeInputValue,
  toIsoDateTime,
  validateLocalFile,
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
      version: 3,
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
      }],
      corrections: [{
        id: "correction-1",
        reason: "复核纸单后更正数量",
        changedFields: ["items", "totalCents"],
        correctedByName: "财务 Finance المالية",
        fromVersion: 2,
        toVersion: 3,
        createdAt: "2026-07-25T02:00:00.000Z"
      }]
    }],
    partners: [{ id: "p1", version: 4, name: "迪拜 النور Trading", kind: "customer", balances: [] }],
    reminders: [{ id: "r1", orderId: "o1", partnerName: "迪拜 النور Trading", direction: "receivable", outstandingCents: 7000 }],
    recentPayments: [{
      id: "pay1",
      orderId: "o1",
      orderNo: "طلب-中文-001",
      partnerName: "迪拜 النور Trading",
      direction: "receivable",
      currency: "USD",
      amountCents: 3000,
      method: "bank_transfer",
      paidAt: "2026-07-24T10:00:00.000Z",
      reversedAt: "2026-07-25T01:02:03.000Z"
    }]
  });

  assert.equal(data.user.displayName, "财务 Finance المالية");
  assert.equal(data.orders[0].partnerName, "迪拜 النور Trading");
  assert.equal(data.orders[0].orderNo, "طلب-中文-001");
  assert.equal(data.orders[0].payments[0].reversedAt, "2026-07-25T01:02:03.000Z");
  assert.equal(data.orders[0].payments[0].reversalReason, "重复入账 Duplicate قيد مكرر");
  assert.equal(data.orders[0].version, 3);
  assert.equal(data.orders[0].corrections[0].reason, "复核纸单后更正数量");
  assert.deepEqual(data.orders[0].corrections[0].changedFields, ["items", "totalCents"]);
  assert.equal(data.recentPayments[0].partnerName, "迪拜 النور Trading");
  assert.equal(data.recentPayments[0].orderNo, "طلب-中文-001");
  assert.equal(data.recentPayments[0].amountCents, 3000);
  assert.equal(data.recentPayments[0].reversedAt, "2026-07-25T01:02:03.000Z");
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
  assert.deepEqual(settlementRequest("months:2"), { settlementDays: 0, settlementMonths: 2 });
  assert.throws(() => settlementRequest("custom", "3.5"), /0 到 3650/);
  assert.equal(roleCan("finance", "payment"), true);
  assert.equal(roleCan("sales", "payment"), false);
  assert.equal(roleCan("owner", "reversePayment"), true);
  assert.equal(roleCan("finance", "reversePayment"), true);
  assert.equal(roleCan("sales", "reversePayment"), false);
  assert.equal(roleCan("sales", "correctOrder"), true);
  assert.equal(roleCan("sales", "cancelOrder"), true);
  assert.equal(roleCan("viewer", "cancelOrder"), false);
  assert.equal(roleCan("sales", "partner"), true);
  assert.equal(roleCan("viewer", "partner"), false);
  assert.equal(roleCan("owner", "closePeriod"), true);
  assert.equal(roleCan("finance", "closePeriod"), true);
  assert.equal(roleCan("viewer", "closePeriod"), false);
  assert.equal(roleCan("owner", "readAccounting"), true);
  assert.equal(roleCan("viewer", "readAccounting"), true);
  assert.equal(roleCan("sales", "readAccounting"), false);
});

test("routes accounting tiles to dedicated books and period closing", () => {
  assert.match(appSource, /data-action="load-accounting-section" data-section="ledger"/);
  assert.match(appSource, /data-action="load-accounting-section" data-section="bank-journal"/);
  assert.match(indexSource, /data-view="period-close"/);
  assert.match(appSource, /apiRequest\(`\/api\/accounting\/ledger\?limit=500\$\{query\}`/);
  assert.match(appSource, /apiRequest\("\/api\/accounting\/bank-journal\?limit=500"/);
  assert.match(appSource, /cash-flow-statement/);
  assert.match(appSource, /apiRequest\(`\/api\/accounting\/periods\/\$\{encodeURIComponent\(periodId\)\}\/close`/);
  assert.match(appSource, /window\.confirm\(/);
  assert.match(appSource, /function revealAccountingTarget/);
  assert.match(appSource, /target\.scrollIntoView\(\{ behavior: "smooth", block \}\)/);
  assert.match(appSource, /revealAccountingTarget\(target, "start"\)/);
});

test("keeps local test helpers out of the online login surface", () => {
  assert.match(indexSource, /id="localTestAccountButton"[^>]+local-test-control hidden/);
  assert.match(indexSource, /id="loginNote" class="login-note">账号由企业管理员创建/);
  assert.match(appSource, /function configureEnvironmentUi\(\)/);
  assert.match(appSource, /localHostnames = new Set\(\["localhost", "127\.0\.0\.1", "::1"\]\)/);
});

test("provides accessible light and dark theme controls", () => {
  assert.equal((indexSource.match(/data-theme-toggle/g) || []).length, 2);
  assert.match(indexSource, /aria-label="切换到深色模式"/);
  assert.match(appSource, /function applyTheme\(theme, \{ persist = false \} = \{\}\)/);
  assert.match(appSource, /function toggleTheme\(\)/);
  assert.match(appSource, /document\.documentElement\.dataset\.theme = normalizedTheme/);
  assert.match(appSource, /meta\[name="theme-color"\]/);
  assert.match(stylesSource, /html\[data-theme="dark"\]/);
});

test("keeps voucher currencies visible and blocks unsafe CNY account aggregation", () => {
  assert.match(appSource, /const currency = journal\.currency \|\| lines\.find\(\(line\) => line\.currency\)\?\.currency \|\| "CNY"/);
  assert.match(appSource, /const lineCurrency = line\.currency \|\| currency/);
  assert.match(appSource, /formatMoney\(debit, currency\)/);
  assert.match(appSource, /formatMoney\(Number\(line\.debitCents\), lineCurrency\)/);
  assert.match(appSource, /formatMoney\(Number\(line\.creditCents\), lineCurrency\)/);
  assert.match(appSource, /<td>\$\{escapeHtml\(lineCurrency\)\}<\/td>/);
  assert.match(appSource, /const foreignFulfilledCount = state\.data\.orders\.filter\(\(order\) => order\.fulfillmentStatus === "fulfilled" && order\.currency !== "CNY"\)\.length/);
  assert.match(appSource, /const accountTable = foreignFulfilledCount\s*\n\s*\? `<section class="capability-status danger accounting-currency-warning"/);
  assert.match(appSource, /本位币科目汇总已暂停展示/);
  assert.match(appSource, /不会把外币发生额并入 CNY 科目余额/);
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

test("uses one calendar-day rule for due filters, labels, and overdue status", () => {
  assert.equal(daysBetweenDateInputs("2026-07-25", "2026-07-24"), -1);
  assert.equal(daysBetweenDateInputs("2026-07-25", "2026-08-01"), 7);
  assert.equal(dueBucketForDateInputs("2026-07-24", "2026-07-25"), "overdue");
  assert.equal(dueBucketForDateInputs("2026-07-25", "2026-07-25"), "today");
  assert.equal(dueBucketForDateInputs("2026-08-01", "2026-07-25"), "upcoming");
  assert.equal(dueBucketForDateInputs("2026-08-02", "2026-07-25"), "later");
  assert.equal(orderStatus({ fulfillmentStatus: "fulfilled", settlementStatus: "partial", outstandingCents: 100 }, { isOverdue: true }).className, "overdue");
  assert.equal(orderStatus({ fulfillmentStatus: "fulfilled", settlementStatus: "settled", outstandingCents: 0 }, { isOverdue: true }).className, "settled");
});

test("uses real API mutations and only persists an allowlisted UI theme preference", () => {
  assert.doesNotMatch(appSource, /sessionStorage|indexedDB/);
  assert.match(appSource, /const THEME_STORAGE_KEY = "siyan-ui-theme"/);
  assert.match(appSource, /localStorage\.getItem\(THEME_STORAGE_KEY\)/);
  assert.match(appSource, /localStorage\.setItem\(THEME_STORAGE_KEY, normalizedTheme\)/);
  assert.doesNotMatch(appSource, /localStorage\.(getItem|setItem)\(\s*["'`](?!siyan-ui-theme)/);
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
  assert.match(appSource, /toDateTimeInputValue\(now, tenantTimeZone\(\)\)/);
  assert.match(appSource, /fulfilledAtInput\.min/);
  assert.match(appSource, /fulfilledAtInput\.max/);
  assert.doesNotMatch(appSource, /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/);
  assert.match(indexSource, /id="reversalModal"/);
  assert.match(indexSource, /id="cancelOrderModal"/);
  assert.match(indexSource, /id="paymentQueueModal"/);
  assert.match(appSource, /overviewPaymentActivityMarkup/);
  assert.match(appSource, /overviewDueTrendMarkup/);
  assert.match(appSource, /open-payment-queue/);
  assert.doesNotMatch(appSource, /applyDemoImport|state\.orders\.(?:push|unshift)/);
});

test("provides accessible password and SMS login with server-controlled resend cooldown", () => {
  assert.match(indexSource, /id="authTabs"[^>]*role="tablist"/);
  assert.match(indexSource, /id="passwordLoginTab"[^>]*role="tab"[^>]*aria-controls="loginForm"/);
  assert.match(indexSource, /id="smsLoginTab"[^>]*role="tab"[^>]*aria-controls="smsLoginForm"/);
  assert.match(indexSource, /id="smsLoginCode"[^>]*autocomplete="one-time-code"[^>]*pattern="\[0-9\]\{6\}"/);
  assert.match(indexSource, /id="smsCodeStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(indexSource, /id="smsLoginError"[^>]*role="alert"[^>]*aria-live="assertive"/);
  assert.match(appSource, /"\/api\/auth\/sms-codes"/);
  assert.match(appSource, /"\/api\/auth\/sms-login"/);
  assert.match(appSource, /response\.headers\.get\("retry-after"\)/);
  assert.match(appSource, /startSmsCountdown\(error\.retryAfterSeconds\)/);
  assert.match(appSource, /setAttribute\("aria-selected", String\(active\)\)/);
  assert.match(appSource, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.doesNotMatch(`${indexSource}\n${appSource}`, /testCode|固定验证码|测试验证码/);
});

test("keeps mobile order actions inside the full-width card action row", () => {
  assert.match(
    stylesSource,
    /@media \(max-width: 760px\)[\s\S]*\.view \.data-table \.actions-cell \{ width: 100%; \}/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width: 430px\)[\s\S]*\.payment-summary-grid b \{[^}]*white-space: nowrap;/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width: 320px\)[\s\S]*\.payment-summary-grid \.remaining \{ grid-column: 1 \/ -1; \}/,
  );
});

test("is CSP-friendly and self-hosts visual dependencies", () => {
  assert.match(indexSource, /<meta charset="UTF-8"/);
  assert.match(indexSource, /src="\.\/vendor\/lucide\.js"/);
  assert.match(indexSource, /href="\.\/assets\/favicon-64\.png"/);
  assert.equal(fs.existsSync(path.join(publicDir, "assets", "siyan-mark.png")), true);
  assert.equal(fs.existsSync(path.join(publicDir, "assets", "favicon-64.png")), true);
  assert.doesNotMatch(indexSource, /https?:\/\//);
  assert.doesNotMatch(indexSource, /<script(?![^>]*src=)[^>]*>\s*\S/);
  assert.equal(fs.existsSync(path.join(publicDir, "vendor", "lucide.js")), true);
  assert.equal(fs.existsSync(path.join(publicDir, "vendor", "lucide.LICENSE.txt")), true);
  assert.doesNotMatch(stylesSource, /\.login-story::after/);
});

test("keeps the responsive commercial UI and keyboard accessibility contracts", () => {
  assert.match(indexSource, /name="theme-color" content="#17181a"/);
  assert.match(indexSource, /<title>思燕智能财务｜思燕家居<\/title>/);
  assert.equal((indexSource.match(/思燕家居/g) || []).length, 3);
  assert.match(indexSource, /<h1>思燕智能财务<\/h1>/);
  assert.equal((indexSource.match(/src="\.\/assets\/siyan-mark\.png"/g) || []).length, 3);
  assert.match(indexSource, /id="workspaceAvatar"[^>]*><i data-lucide="building-2"><\/i><\/span>/);
  assert.doesNotMatch(appSource, /workspaceAvatar"\)\.textContent/);
  assert.match(appSource, /workspaceIdentity"\)\.setAttribute\("aria-label", `当前企业：\$\{tenant\.name\}`\)/);
  assert.match(stylesSource, /\.workspace-switch > div > span/);
  assert.doesNotMatch(stylesSource, /\.workspace-switch span\s*\{/);
  assert.match(indexSource, /data-view="orders"><i data-lucide="notebook-tabs"/);
  assert.match(appSource, /orderFilters:\s*\{\s*direction:/);
  assert.match(appSource, /\["awaiting","未开始"\]/);
  assert.doesNotMatch(appSource, /\["pending","未开始"\]/);
  assert.match(appSource, /order\.outstandingCents <= 0 \|\| dueBucket/);
  assert.match(appSource, /payment-summary-grid/);
  assert.match(appSource, /reminder-group/);
  assert.match(appSource, /modalReturnFocus/);
  assert.match(appSource, /aria-current/);
  assert.match(stylesSource, /--accent:\s*#b39464/);
  assert.match(stylesSource, /SiYan Quiet Intelligence/);
  assert.match(indexSource, /id="desktopSidebarToggle"/);
  assert.match(appSource, /function setDesktopSidebarCollapsed/);
  assert.match(stylesSource, /#detailModal\s*\{\s*place-items:\s*stretch end/);
  assert.match(stylesSource, /grid-template-columns:\s*minmax\(180px, \.8fr\) minmax\(0, 1\.2fr\)/);
  assert.match(stylesSource, /\.kpi strong, \.kpi \.currency-stack strong \{ white-space: normal/);
  assert.match(stylesSource, /\.commercial-lines \{ min-width: 0; \}/);
  assert.match(stylesSource, /\.report-tabbar \{[\s\S]*grid-auto-flow: column;[\s\S]*background: var\(--surface-soft\);/);
  assert.match(stylesSource, /\.report-tabbar \.report-tab \{ width: 100%; min-width: 0; white-space: nowrap; \}/);
  assert.match(stylesSource, /\.report-tabbar \{ display: flex; flex-wrap: nowrap; width: 100%; overflow-x: auto; \}/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(stylesSource, /\.sidebar \{ z-index: 31; \}/);
  assert.match(stylesSource, /\.sidebar-scrim \{ z-index: 29; \}/);
  assert.doesNotMatch(`${indexSource}\n${appSource}\n${stylesSource}`, /\uFFFD/);
});

test("exposes the order-driven finance workflow with honest capability states", () => {
  for (const view of ["evidence", "approvals", "inventory", "checks", "balances", "auxiliary", "reports", "tax", "period-close", "automation"]) {
    assert.match(indexSource, new RegExp(`id="view-${view}"`));
    assert.match(appSource, new RegExp(`${view}:|"${view}"`));
  }
  assert.match(appSource, /function orderBusinessChainMarkup/);
  assert.match(appSource, /function renderOrderImpactPreview/);
  assert.match(appSource, /原始凭证.*待接入/);
  assert.match(appSource, /审批状态机尚未接入/);
  assert.match(appSource, /当前为订单交收数量预览/);
  assert.match(appSource, /原始数据保护已开启/);
  assert.match(appSource, /cash-flow-statement/);
  assert.match(appSource, /所得税申报草稿/);
  assert.match(appSource, /function ledgerSourceOrderId/);
  assert.match(appSource, /点击订单号可回到业务单据和收付款记录/);
  assert.match(appSource, /查看银行日记账/);
  assert.match(appSource, /账面利润只用于流程演示，不作为完整经营或纳税结论/);
  assert.match(appSource, /销售成本结转、费用报销、工资、折旧和税费计提尚未接入/);
  assert.match(appSource, /\["block", "原始凭证完整性"/);
  assert.match(appSource, /\["block", "审批完整性"/);
  assert.match(appSource, /\["block", "折旧、摊销与成本结转"/);
  assert.match(stylesSource, /\.business-chain/);
  assert.match(stylesSource, /\.capability-status/);
  assert.match(stylesSource, /\.risk-check-row/);
  assert.match(stylesSource, /\.nav-item\.role-hidden/);
  assert.doesNotMatch(`${indexSource}\n${appSource}`, /凭证上传成功|审批已通过|库存已同步/);
});

test("keeps foreign-currency accounting visible without unsafe base-currency totals", () => {
  assert.match(appSource, /const currency = journal\.currency \|\| lines\.find\(\(line\) => line\.currency\)\?\.currency \|\| "CNY"/);
  assert.match(appSource, /const lineCurrency = line\.currency \|\| currency/);
  assert.match(appSource, /formatMoney\(Number\(line\.debitCents\), lineCurrency\)/);
  assert.match(appSource, /本位币科目汇总已暂停展示/);
  assert.match(appSource, /class="capability-status-actions"><button class="outline-button small-button" data-view="checks">查看风险/);

  const periodCloseSource = appSource.slice(
    appSource.indexOf("async function loadPeriodCloseView"),
    appSource.indexOf("function renderAll"),
  );
  assert.match(periodCloseSource, /foreign\s*\? Promise\.resolve\(null\)\s*:\s*apiRequest\(`\/api\/accounting\/trial-balance/);
  assert.match(periodCloseSource, /检测到外币业务，已跳过混币试算平衡请求/);
  assert.match(periodCloseSource, /foreign \? "block" : balancePayload\?\.balanced/);
});

test("locks asynchronous submission modals until their request finishes", () => {
  assert.match(appSource, /function setModalBusy\(id, busy\)/);
  assert.match(appSource, /setAttribute\("aria-busy", "true"\)/);
  assert.match(appSource, /data-modal-busy-disabled="true"/);
  assert.match(appSource, /if \(isModalBusy\(id\) && !force\)/);

  const submissionModals = [
    "orderModal",
    "fulfillModal",
    "paymentModal",
    "reversalModal",
    "cancelOrderModal",
    "snoozeModal",
    "partnerModal",
    "passwordModal",
    "memberModal"
  ];
  for (const modalId of submissionModals) {
    assert.match(appSource, new RegExp(`setModalBusy\\("${modalId}", true\\)`));
    assert.match(appSource, new RegExp(`setModalBusy\\("${modalId}", false\\)`));
    assert.match(appSource, new RegExp(`closeModal\\("${modalId}", \\{ force: true \\}\\)`));
    assert.doesNotMatch(appSource, new RegExp(`closeModal\\("${modalId}"\\);`));
  }
});

test("validates supported import and local OCR files before processing", () => {
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize(2 * 1024 * 1024), "2.0 MB");

  assert.deepEqual(
    validateLocalFile({ name: "义乌订单.xlsx", size: 2048, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, "import"),
    {
      accepted: true,
      name: "义乌订单.xlsx",
      extension: "xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 2048,
      sizeLabel: "2.0 KB",
      message: "文件基本信息已在本地确认"
    }
  );
  assert.equal(validateLocalFile({ name: "订单.exe", size: 2048, type: "application/octet-stream" }, "import").accepted, false);
  assert.equal(validateLocalFile({ name: "旧版订单.xls", size: 2048, type: "application/vnd.ms-excel" }, "import").accepted, false);
  assert.equal(validateLocalFile({ name: "订单.xlsx", size: 11 * 1024 * 1024, type: "application/octet-stream" }, "import").accepted, false);
  assert.equal(validateLocalFile({ name: "纸单.jpg", size: 4096, type: "image/jpeg" }, "ocr").accepted, true);
  assert.equal(validateLocalFile({ name: "纸单.jpg", size: 4096, type: "image/svg+xml" }, "ocr").accepted, false);
  assert.equal(validateLocalFile({ name: "纸单.jpg", size: 4096, type: "" }, "ocr").accepted, false);
});

test("renders server-backed import, local-only OCR, and partner master-detail contracts", () => {
  assert.match(appSource, /function renderContactsView/);
  assert.match(appSource, /data-contact-kind/);
  assert.match(appSource, /contact-detail-pane/);
  assert.match(appSource, /order\.partnerId === partnerId/);
  assert.match(appSource, /workflow-steps/);
  assert.match(appSource, /data-local-drop="import"/);
  assert.match(appSource, /"\/api\/order-imports\/preview"/);
  assert.match(appSource, /"\/api\/order-imports\/commit"/);
  assert.match(appSource, /headers:\s*\{\s*"Idempotency-Key": state\.importIdempotencyKey\s*\}/);
  assert.match(appSource, /rowNumbers:\s*\[\.\.\.state\.importSelectedRows\]/);
  assert.match(appSource, /function arrayBufferToBase64\(buffer\)/);
  assert.match(appSource, /chunkSize = 32 \* 1024/);
  assert.match(appSource, /readAsArrayBuffer\(file\)/);
  assert.match(appSource, /data-import-mapping/);
  assert.match(appSource, /data-import-row/);
  assert.match(appSource, /download-import-template/);
  assert.match(appSource, /思燕智能财务-订单导入模板\.csv/);
  assert.match(appSource, /Excel 导入[\s\S]*CSV \/ XLSX 安全解析、字段映射、校验和审计已启用/);
  assert.match(appSource, /纸单 OCR[\s\S]*等待阿里云 OCR 与对象存储服务开通/);
  assert.doesNotMatch(appSource, /accept="[^"]*\.xls(?:,|\")/);
  assert.doesNotMatch(appSource, /解析服务待接入|当前不会上传、解析或写入账务/);
  assert.match(appSource, /id="ocrLocalPreview"/);
  assert.match(appSource, /new FileReader\(\)/);
  assert.match(appSource, /new Image\(\)/);
  assert.match(appSource, /data-action="ocr-manual-order"/);
  assert.match(appSource, /保存识别结果<\/button>/);
  assert.match(appSource, /没有 OCR 坐标数据时，不会伪造字段高亮区域/);
  assert.doesNotMatch(appSource, /\/api\/ocr(?:\/|"|`)/);
  assert.match(stylesSource, /\.contact-workspace\s*\{/);
  assert.match(stylesSource, /@media \(max-width: 900px\)[\s\S]*\.contact-workspace/);
  assert.match(appSource, /matchMedia\("\(max-width: 900px\)"\)/);
  assert.match(stylesSource, /\.workflow-steps\s*\{/);
  assert.match(stylesSource, /\.ocr-layout\s*\{/);
});

test("renders server-backed audit history without exposing sensitive request keys", () => {
  assert.match(appSource, /apiRequest\("\/api\/audit\?limit=100"/);
  assert.match(appSource, /安全与审计记录/);
  assert.match(appSource, /state\.data\.role === "owner" \|\| state\.data\.role === "finance"/);
  assert.match(appSource, /auditActionLabels/);
  const auditDetailSource = appSource.slice(appSource.indexOf("function auditDetail"), appSource.indexOf("function auditPanelMarkup"));
  assert.doesNotMatch(auditDetailSource, /idempotencyKey|sessionId|token/);
  assert.match(stylesSource, /\.audit-row\s*\{/);
});

test("provides private, versioned reminder preferences only to finance roles", () => {
  assert.match(appSource, /apiRequest\("\/api\/notification-settings\/me"/);
  assert.match(appSource, /method:\s*"PUT"/);
  assert.match(appSource, /sendLocalTime:\s*"09:00"/);
  assert.match(appSource, /version:\s*state\.notificationSettings\.preference\.version/);
  assert.match(appSource, /preference\.version\) && preference\.version >= 0/);
  assert.match(appSource, /state\.data\.role === "owner" \|\| state\.data\.role === "finance"/);
  assert.match(appSource, /canReadAudit \? notificationSettingsPanelMarkup\(\) : ""/);
  assert.match(appSource, /id="notificationEnabled"[^>]*role="switch"/);
  assert.match(appSource, /id="notificationSendLocalTime" type="time"/);
  assert.match(appSource, /id="notificationAdvanceDays" type="number"/);
  assert.match(appSource, /id="notificationReceivableEnabled" type="checkbox"/);
  assert.match(appSource, /id="notificationPayableEnabled" type="checkbox"/);
  assert.match(appSource, /id="notificationOverdueDaily" type="checkbox"/);
  assert.match(appSource, /!settings\.eligible \|\| !settings\.phoneVerified/);
  assert.match(appSource, /请先通过短信验证码登录完成验证，再开启提醒/);
  assert.match(appSource, /正在保存提醒设置/);
  assert.match(appSource, /提醒设置已保存/);
  assert.match(appSource, /notificationSettingsSaveStatus === "error"/);
  assert.match(appSource, /phoneMasked:\s*safeMaskedPhone\(payload\?\.phoneMasked\)/);
  const notificationPanelSource = appSource.slice(
    appSource.indexOf("function notificationSettingsPanelMarkup"),
    appSource.indexOf("function captureNotificationPreferenceDraft"),
  );
  assert.doesNotMatch(notificationPanelSource, /user\.phone|state\.data\.user\.phone/);
  assert.match(stylesSource, /\.notification-preference-grid\s*\{/);
  assert.match(stylesSource, /@media \(max-width: 430px\)[\s\S]*\.notification-preference-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(stylesSource, /\.switch input:focus-visible \+ span/);
});

test("provides owner-managed invitations, roles, and account status controls", () => {
  assert.match(indexSource, /id="invitationForm"/);
  assert.match(indexSource, /id="memberModal"/);
  assert.match(appSource, /\/api\/auth\/accept-invitation/);
  assert.match(appSource, /apiRequest\("\/api\/members"/);
  assert.match(appSource, /\/api\/members\/\$\{encodeURIComponent\(memberId\)\}\/role/);
  assert.match(appSource, /\/api\/members\/\$\{encodeURIComponent\(memberId\)\}\/status/);
  assert.match(appSource, /\/api\/members\/\$\{encodeURIComponent\(memberId\)\}\/reinvite/);
  assert.match(appSource, /只显示这一次/);
  assert.match(appSource, /旧链接已失效/);
  assert.match(stylesSource, /\.member-row\s*\{/);
});

test("provides controlled order correction UI with immutable history cues", () => {
  assert.match(indexSource, /id="correctionReason"/);
  assert.match(indexSource, /不会覆盖历史/);
  assert.match(appSource, /method: "PATCH"[\s\S]*正在保存订单更正/);
  assert.match(appSource, /SETTLED_IDENTITY_LOCKED|hasPaymentHistory/);
  assert.match(appSource, /function correctionHistoryMarkup/);
  assert.match(appSource, /更正前后快照不可修改/);
  assert.match(appSource, /data-action="correct-order"/);
  assert.match(stylesSource, /\.correction-row\s*\{/);
});
