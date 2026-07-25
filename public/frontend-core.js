const HTML_ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

const DIRECTIONS = new Set(["receivable", "payable"]);
const FULFILLMENT_STATUSES = new Set(["planned", "fulfilled", "cancelled"]);
const SETTLEMENT_STATUSES = new Set(["planned", "awaiting", "partial", "settled", "cancelled"]);
const ROLES = new Set(["owner", "finance", "sales", "viewer"]);
const PARTNER_KINDS = new Set(["customer", "supplier", "both"]);
const LOCAL_FILE_RULES = {
  import: {
    extensions: new Set(["csv", "xlsx"]),
    mimeTypes: new Set([
      "application/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
      "text/plain"
    ]),
    maxBytes: 10 * 1024 * 1024,
    supportedLabel: "CSV 或 XLSX",
    tooLargeLabel: "10 MB"
  },
  ocr: {
    extensions: new Set(["jpeg", "jpg", "png", "webp"]),
    mimeTypes: new Set(["image/jpeg", "image/png", "image/webp"]),
    maxBytes: 10 * 1024 * 1024,
    supportedLabel: "JPG、PNG 或 WebP",
    tooLargeLabel: "10 MB"
  }
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

export function escapeAttr(value) {
  return escapeHtml(value);
}

export function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "0 B";
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function validateLocalFile(file = {}, purpose = "import") {
  const rules = LOCAL_FILE_RULES[purpose];
  if (!rules) throw new Error("不支持的本地文件用途");

  const name = asText(file.name).trim();
  const size = Number(file.size);
  const mimeType = asText(file.type).trim().toLowerCase();
  const extension = name.includes(".") ? name.split(".").at(-1).toLowerCase() : "";
  const result = {
    accepted: false,
    name,
    extension,
    mimeType,
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    sizeLabel: formatFileSize(size)
  };

  if (!name) return { ...result, message: "请选择文件" };
  if (!rules.extensions.has(extension)) return { ...result, message: `仅支持 ${rules.supportedLabel} 文件` };
  if (!Number.isFinite(size) || size <= 0) return { ...result, message: "文件为空或无法读取" };
  if (size > rules.maxBytes) return { ...result, message: `文件不能超过 ${rules.tooLargeLabel}` };

  const genericMime = !mimeType || mimeType === "application/octet-stream";
  const mimeAccepted = purpose === "ocr" ? rules.mimeTypes.has(mimeType) : genericMime || rules.mimeTypes.has(mimeType);
  if (!mimeAccepted) return { ...result, message: "文件类型与扩展名不一致" };
  return { ...result, accepted: true, message: "文件基本信息已在本地确认" };
}

export function asText(value, fallback = "") {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

export function asCents(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

export function normalizeOrder(raw = {}) {
  const fulfillmentStatus = FULFILLMENT_STATUSES.has(raw.fulfillmentStatus) ? raw.fulfillmentStatus : "planned";
  const settlementStatus = SETTLEMENT_STATUSES.has(raw.settlementStatus) ? raw.settlementStatus : fulfillmentStatus === "fulfilled" ? "awaiting" : "planned";
  const totalCents = asCents(raw.totalCents);
  const paidCents = Math.min(totalCents, asCents(raw.paidCents));
  return {
    id: asText(raw.id),
    version: Math.max(1, Number.parseInt(raw.version, 10) || 1),
    partnerId: asText(raw.partnerId),
    partnerName: asText(raw.partnerName, "未命名往来单位"),
    orderNo: asText(raw.orderNo, "未编号"),
    direction: DIRECTIONS.has(raw.direction) ? raw.direction : "receivable",
    orderDate: asText(raw.orderDate),
    plannedDeliveryDate: asText(raw.plannedDeliveryDate),
    fulfillmentStatus,
    settlementStatus,
    fulfilledAt: asText(raw.fulfilledAt),
    settlementDays: Math.max(0, Number.parseInt(raw.settlementDays, 10) || 0),
    settlementMonths: Math.max(0, Number.parseInt(raw.settlementMonths, 10) || 0),
    dueAt: asText(raw.dueAt),
    currency: /^[A-Z]{3}$/.test(asText(raw.currency)) ? raw.currency : "CNY",
    totalCents,
    paidCents,
    outstandingCents: Math.max(0, Math.min(totalCents, asCents(raw.outstandingCents ?? totalCents - paidCents))),
    notes: asText(raw.notes),
    createdAt: asText(raw.createdAt),
    updatedAt: asText(raw.updatedAt),
    items: Array.isArray(raw.items) ? raw.items.map(normalizeItem) : [],
    payments: Array.isArray(raw.payments) ? raw.payments.map(normalizePayment) : [],
    corrections: Array.isArray(raw.corrections) ? raw.corrections.map(normalizeCorrection) : []
  };
}

export function normalizeCorrection(raw = {}) {
  return {
    id: asText(raw.id),
    reason: asText(raw.reason),
    changedFields: Array.isArray(raw.changedFields) ? raw.changedFields.map(asText).filter(Boolean) : [],
    correctedBy: asText(raw.correctedBy),
    correctedByName: asText(raw.correctedByName, "系统"),
    fromVersion: Math.max(1, Number.parseInt(raw.fromVersion, 10) || 1),
    toVersion: Math.max(1, Number.parseInt(raw.toVersion, 10) || 1),
    createdAt: asText(raw.createdAt)
  };
}

export function normalizeItem(raw = {}) {
  return {
    id: asText(raw.id),
    description: asText(raw.description, "未命名商品"),
    quantity: Math.max(0, Number.parseInt(raw.quantity, 10) || 0),
    unitPriceCents: asCents(raw.unitPriceCents),
    lineTotalCents: asCents(raw.lineTotalCents)
  };
}

export function normalizePayment(raw = {}) {
  return {
    id: asText(raw.id),
    amountCents: asCents(raw.amountCents),
    method: asText(raw.method),
    paidAt: asText(raw.paidAt),
    note: asText(raw.note),
    proofKey: asText(raw.proofKey),
    createdBy: asText(raw.createdBy),
    createdAt: asText(raw.createdAt),
    reversedAt: asText(raw.reversedAt),
    reversalReason: asText(raw.reversalReason)
  };
}

export function normalizePartner(raw = {}) {
  return {
    id: asText(raw.id),
    version: Math.max(1, Number.parseInt(raw.version, 10) || 1),
    name: asText(raw.name, "未命名往来单位"),
    kind: PARTNER_KINDS.has(raw.kind) ? raw.kind : "both",
    contactName: asText(raw.contactName),
    phone: asText(raw.phone),
    balances: Array.isArray(raw.balances) ? raw.balances.map((balance) => ({
      currency: /^[A-Z]{3}$/.test(asText(balance?.currency)) ? balance.currency : "CNY",
      receivableCents: asCents(balance?.receivableCents),
      payableCents: asCents(balance?.payableCents)
    })) : []
  };
}

export function normalizeReminder(raw = {}) {
  return {
    id: asText(raw.id),
    orderId: asText(raw.orderId),
    orderNo: asText(raw.orderNo),
    partnerName: asText(raw.partnerName, "未命名往来单位"),
    direction: DIRECTIONS.has(raw.direction) ? raw.direction : "receivable",
    dueAt: asText(raw.dueAt),
    status: asText(raw.status, "open"),
    snoozedUntil: asText(raw.snoozedUntil),
    outstandingCents: asCents(raw.outstandingCents)
  };
}

export function normalizeRecentPayment(raw = {}) {
  return {
    id: asText(raw.id),
    orderId: asText(raw.orderId),
    orderNo: asText(raw.orderNo, "未编号"),
    partnerName: asText(raw.partnerName, "未命名往来单位"),
    direction: DIRECTIONS.has(raw.direction) ? raw.direction : "receivable",
    currency: /^[A-Z]{3}$/.test(asText(raw.currency)) ? raw.currency : "CNY",
    amountCents: asCents(raw.amountCents),
    method: asText(raw.method),
    paidAt: asText(raw.paidAt),
    reversedAt: asText(raw.reversedAt)
  };
}

export function normalizeBootstrap(raw = {}) {
  return {
    user: {
      id: asText(raw.user?.id),
      phone: asText(raw.user?.phone),
      displayName: asText(raw.user?.displayName, "当前用户")
    },
    tenant: {
      id: asText(raw.tenant?.id),
      name: asText(raw.tenant?.name, "企业账本"),
      timezone: asText(raw.tenant?.timezone, "Asia/Shanghai")
    },
    role: ROLES.has(raw.role) ? raw.role : "viewer",
    orders: Array.isArray(raw.orders) ? raw.orders.map(normalizeOrder) : [],
    partners: Array.isArray(raw.partners) ? raw.partners.map(normalizePartner) : [],
    reminders: Array.isArray(raw.reminders) ? raw.reminders.map(normalizeReminder) : [],
    recentPayments: Array.isArray(raw.recentPayments) ? raw.recentPayments.map(normalizeRecentPayment) : []
  };
}

export function formatMoney(cents, currency = "CNY") {
  const safeCurrency = /^[A-Z]{3}$/.test(asText(currency)) ? currency : "CNY";
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: safeCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(asCents(cents) / 100);
  } catch {
    return `${safeCurrency} ${(asCents(cents) / 100).toFixed(2)}`;
  }
}

export function groupOutstanding(orders, direction) {
  const totals = new Map();
  for (const order of orders) {
    if (direction && order.direction !== direction) continue;
    if (order.fulfillmentStatus !== "fulfilled" || order.outstandingCents <= 0) continue;
    totals.set(order.currency, (totals.get(order.currency) ?? 0) + order.outstandingCents);
  }
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, cents]) => ({ currency, cents }));
}

export function yuanToCents(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,13}(?:\.\d{1,2})?$/.test(text)) throw new Error("金额最多保留两位小数");
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error("金额超出安全范围");
  return cents;
}

export function settlementRequest(value, customDays = 0) {
  const monthMatch = /^months:(\d{1,3})$/.exec(asText(value));
  if (monthMatch) {
    const months = Number(monthMatch[1]);
    if (months < 1 || months > 120) throw new Error("月数账期必须是 1 到 120 个月");
    return { settlementDays: 0, settlementMonths: months };
  }
  if (value === "custom") {
    const days = Number(customDays);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error("自定义账期必须是 0 到 3650 天");
    return { settlementDays: days, settlementMonths: 0 };
  }
  const match = /^days:(0|7|30)$/.exec(asText(value));
  if (!match) throw new Error("请选择有效的结算周期");
  return { settlementDays: Number(match[1]), settlementMonths: 0 };
}

export function roleCan(role, action) {
  const permissions = {
    createOrder: ["owner", "finance", "sales"],
    fulfill: ["owner", "finance", "sales"],
    payment: ["owner", "finance"],
    reversePayment: ["owner", "finance"],
    cancelOrder: ["owner", "finance", "sales"],
    correctOrder: ["owner", "finance", "sales"],
    reminder: ["owner", "finance", "sales"],
    partner: ["owner", "finance", "sales"]
  };
  return (permissions[action] ?? []).includes(role);
}

export function orderStatus(order, options = {}) {
  const isOverdue = options.isOverdue ?? Boolean(order.dueAt && new Date(order.dueAt).getTime() < Date.now());
  if (order.fulfillmentStatus === "cancelled") return { label: "已取消", className: "draft" };
  if (order.fulfillmentStatus === "planned") return { label: "待交货", className: "draft" };
  if (order.settlementStatus === "settled" || order.outstandingCents === 0) return { label: "已结清", className: "settled" };
  if (isOverdue) return { label: "已逾期", className: "overdue" };
  if (order.settlementStatus === "partial") return { label: "部分结算", className: "partial" };
  return { label: "待结算", className: "pending" };
}

export function buildCreateOrderPayload(input) {
  const items = input.items.map((item) => {
    const quantity = Number(item.quantity);
    if (!item.description.trim()) throw new Error("请填写商品说明");
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("商品数量必须是正整数");
    const unitPriceCents = yuanToCents(item.unitPrice);
    if (unitPriceCents <= 0) throw new Error("商品单价必须大于 0");
    return { description: item.description.trim(), quantity, unitPriceCents };
  });
  if (!items.length) throw new Error("请至少添加一项商品");
  return {
    partnerId: input.partnerId,
    orderNo: input.orderNo.trim(),
    direction: input.direction,
    orderDate: input.orderDate,
    plannedDeliveryDate: input.plannedDeliveryDate || null,
    ...settlementRequest(input.settlementCycle, input.customSettlementDays),
    currency: input.currency,
    notes: input.notes.trim() || null,
    items
  };
}

function zonedParts(value, timeZone, includeTime = false) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("请选择有效时间");
  const options = {
    timeZone: asText(timeZone, "Asia/Shanghai"),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {})
  };
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", options).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "Asia/Shanghai" }).formatToParts(date);
  }
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function toDateInputValue(value = new Date(), timeZone = "Asia/Shanghai") {
  const parts = zonedParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function toDateTimeInputValue(value = new Date(), timeZone = "Asia/Shanghai") {
  const parts = zonedParts(value, timeZone, true);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function dateInputMilliseconds(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asText(value));
  if (!match) throw new Error("请选择有效日期");
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    throw new Error("请选择有效日期");
  }
  return date.getTime();
}

export function addDaysToDateInput(value, days) {
  const amount = Number(days);
  if (!Number.isInteger(amount)) throw new Error("请选择有效日期");
  const date = new Date(dateInputMilliseconds(value));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function daysBetweenDateInputs(fromValue, toValue) {
  return Math.round((dateInputMilliseconds(toValue) - dateInputMilliseconds(fromValue)) / 86_400_000);
}

export function dueBucketForDateInputs(dueValue, todayValue) {
  if (!dueValue) return "later";
  const days = daysBetweenDateInputs(todayValue, dueValue);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  return days <= 7 ? "upcoming" : "later";
}

export function toIsoDateTime(localValue, timeZone = "Asia/Shanghai") {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(asText(localValue));
  if (!match) throw new Error("请选择有效时间");
  const wallTime = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6] || 0)
  );
  const wallDate = new Date(wallTime);
  if (wallDate.getUTCFullYear() !== Number(match[1])
      || wallDate.getUTCMonth() !== Number(match[2]) - 1
      || wallDate.getUTCDate() !== Number(match[3])
      || wallDate.getUTCHours() !== Number(match[4])
      || wallDate.getUTCMinutes() !== Number(match[5])) {
    throw new Error("请选择有效时间");
  }
  let instant = wallTime;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = zonedParts(new Date(instant), timeZone, true);
    const representedWallTime = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(match[6] || 0)
    );
    instant += wallTime - representedWallTime;
  }
  const result = new Date(instant);
  if (Number.isNaN(result.getTime())) throw new Error("请选择有效时间");
  return result.toISOString();
}
