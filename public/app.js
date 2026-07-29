import {
  addDaysToDateInput,
  buildCreateOrderPayload,
  daysBetweenDateInputs,
  dueBucketForDateInputs,
  escapeAttr,
  escapeHtml,
  formatMoney,
  groupOutstanding,
  normalizeBootstrap,
  normalizeOrder,
  orderStatus,
  roleCan,
  toDateInputValue,
  toDateTimeInputValue,
  toIsoDateTime,
  validateLocalFile,
  yuanToCents
} from "./frontend-core.js";

const state = {
  view: "overview",
  token: null,
  data: null,
  orderDirection: "receivable",
  orderFilters: { direction: "all", fulfillment: "all", settlement: "all", due: "all", currency: "all" },
  orderSearch: "",
  paymentQueueSearch: "",
  ledgerFilters: { receivable: "all", payable: "all" },
  ledgerSearch: { receivable: "", payable: "" },
  contactSearch: "",
  contactKind: "all",
  selectedPartnerId: "",
  contactDetailOpen: false,
  importInspection: null,
  importContentBase64: "",
  importReadVersion: 0,
  importStage: 0,
  importStatus: "idle",
  importError: "",
  importPreview: null,
  importMapping: {},
  importSelectedRows: [],
  importResult: null,
  importIdempotencyKey: "",
  ocrInspection: null,
  ocrPreviewDataUrl: "",
  ocrPreviewLoading: false,
  ocrReadVersion: 0,
  auditEntries: [],
  auditStatus: "idle",
  auditError: "",
  members: [],
  membersStatus: "idle",
  membersError: "",
  notificationSettings: null,
  notificationPreferenceDraft: null,
  notificationSettingsStatus: "idle",
  notificationSettingsError: "",
  notificationSettingsSaveStatus: "idle",
  notificationSettingsSaveError: "",
  invitationUrl: "",
  invitationExpiresAt: "",
  invitationToken: "",
  authMode: "password",
  smsChallengeId: "",
  smsChallengePhone: "",
  smsCountdownEndsAt: 0,
  smsCountdownTimer: 0,
  smsRequestPending: false,
  editingOrderId: "",
  editingOrderVersion: 0,
  detailOrderId: "",
  detailOrder: null,
  pendingRequests: 0,
  accountingRenderVersion: 0,
  financeRenderVersion: 0,
  inventorySearch: "",
  smartCheckFilter: "all",
  smartChecks: [],
  reportTab: "balance-sheet",
  taxRate: 25,
  taxDraftPayload: null,
  modalReturnFocus: new Map()
};

const viewLabels = {
  overview: "经营工作台",
  receivable: "客户应收",
  payable: "供应商应付",
  orders: "订单与业务",
  evidence: "原始凭证",
  approvals: "审批中心",
  inventory: "仓储管理",
  accounting: "记账凭证",
  checks: "智能检查",
  balances: "科目余额",
  auxiliary: "辅助明细",
  reports: "财务报表",
  tax: "所得税草稿",
  "period-close": "期末处理",
  contacts: "客户/供应商",
  reminders: "提醒中心",
  imports: "导入数据",
  ocr: "纸单识别",
  automation: "自动化规则",
  settings: "工作区设置"
};

const viewGroups = {
  overview: "经营",
  orders: "经营",
  receivable: "经营",
  payable: "经营",
  contacts: "经营",
  evidence: "业务流",
  approvals: "业务流",
  inventory: "业务流",
  accounting: "财务",
  checks: "财务",
  balances: "财务",
  auxiliary: "财务",
  reports: "财务",
  tax: "财务",
  "period-close": "财务",
  reminders: "工具",
  imports: "工具",
  ocr: "工具",
  automation: "设置",
  settings: "设置"
};

const roleLabels = { owner: "负责人", finance: "财务", sales: "业务", viewer: "只读成员" };
const paymentMethodLabels = {
  bank_transfer: "银行转账",
  wechat: "微信",
  cash: "现金",
  alipay: "支付宝"
};

class ApiClientError extends Error {
  constructor(status, code, message, details, retryAfterSeconds = 0) {
    super(message || "请求失败，请稍后重试");
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const byId = (id) => document.getElementById(id);

function icon(name, size = 16) {
  const safeSize = Number.isFinite(Number(size)) ? Number(size) : 16;
  return `<i data-lucide="${escapeAttr(name)}" style="width:${safeSize}px;height:${safeSize}px"></i>`;
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function showToast(message, kind = "default") {
  const toast = byId("toast");
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3400);
}

function setSyncing(active, message = "正在同步") {
  state.pendingRequests += active ? 1 : -1;
  state.pendingRequests = Math.max(0, state.pendingRequests);
  const status = byId("syncStatus");
  byId("syncStatusText").textContent = message;
  status.classList.toggle("hidden", state.pendingRequests === 0);
  byId("refreshButton")?.classList.toggle("is-spinning", state.pendingRequests > 0);
}

function retryAfterSeconds(response) {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Math.max(0, Number(value.trim()));
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0;
}

async function apiRequest(path, { method = "GET", body, headers = {}, auth = true, busyText = "正在同步" } = {}) {
  setSyncing(true, busyText);
  try {
    const requestHeaders = { Accept: "application/json", ...headers };
    if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
    if (auth && state.token) requestHeaders.Authorization = `Bearer ${state.token}`;
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      throw new ApiClientError(
        response.status,
        payload?.error?.code,
        payload?.error?.message || `请求失败（${response.status}）`,
        payload?.error?.details,
        retryAfterSeconds(response)
      );
    }
    return payload ?? {};
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    throw new ApiClientError(0, "NETWORK_ERROR", "无法连接服务器，请检查服务是否正在运行");
  } finally {
    setSyncing(false);
  }
}

function setFormError(element, message = "") {
  element.textContent = message;
  element.classList.toggle("hidden", !message);
}

function updateSmsCountdown() {
  const button = byId("smsCodeSend");
  const remaining = Math.max(0, Math.ceil((state.smsCountdownEndsAt - Date.now()) / 1000));
  button.disabled = state.smsRequestPending || remaining > 0;
  button.textContent = remaining > 0 ? `${remaining} 秒后重发` : "获取验证码";
  if (remaining === 0 && state.smsCountdownTimer) {
    window.clearInterval(state.smsCountdownTimer);
    state.smsCountdownTimer = 0;
  }
}

function startSmsCountdown(seconds) {
  if (state.smsCountdownTimer) window.clearInterval(state.smsCountdownTimer);
  const duration = Math.max(1, Math.min(3600, Math.ceil(Number(seconds) || 60)));
  state.smsCountdownEndsAt = Date.now() + duration * 1000;
  updateSmsCountdown();
  state.smsCountdownTimer = window.setInterval(updateSmsCountdown, 250);
}

function resetSmsChallenge(statusMessage = "验证码将发送至当前手机号") {
  if (state.smsCountdownTimer) window.clearInterval(state.smsCountdownTimer);
  state.smsCountdownTimer = 0;
  state.smsCountdownEndsAt = 0;
  state.smsChallengeId = "";
  state.smsChallengePhone = "";
  state.smsRequestPending = false;
  byId("smsLoginCode").value = "";
  byId("smsCodeSend").removeAttribute("aria-busy");
  const status = byId("smsCodeStatus");
  status.textContent = statusMessage;
  delete status.dataset.kind;
  updateSmsCountdown();
}

function setAuthMode(mode, { focus = true } = {}) {
  const smsMode = mode === "sms";
  state.authMode = smsMode ? "sms" : "password";
  const passwordPhone = byId("loginPhone");
  const smsPhone = byId("smsLoginPhone");
  if (smsMode && passwordPhone.value.trim()) smsPhone.value = passwordPhone.value.trim();
  if (!smsMode && smsPhone.value.trim()) passwordPhone.value = smsPhone.value.trim();

  byId("loginForm").classList.toggle("hidden", smsMode);
  byId("smsLoginForm").classList.toggle("hidden", !smsMode);
  for (const [tabId, active] of [["passwordLoginTab", !smsMode], ["smsLoginTab", smsMode]]) {
    const tab = byId(tabId);
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  setFormError(smsMode ? byId("smsLoginError") : byId("loginError"));
  if (focus) window.requestAnimationFrame(() => (smsMode ? smsPhone : passwordPhone).focus());
}

function configureEnvironmentUi() {
  const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);
  const isLocal = localHostnames.has(window.location.hostname);
  const testAccountButton = byId("localTestAccountButton");
  const loginNote = byId("loginNote");
  if (testAccountButton) {
    testAccountButton.classList.toggle("hidden", !isLocal);
    testAccountButton.setAttribute("aria-hidden", String(!isLocal));
  }
  if (loginNote) {
    loginNote.textContent = isLocal
      ? "本地测试账号仅用于开发环境，不应带入线上环境。"
      : "账号由企业管理员创建，登录会话采用安全令牌保护。";
  }
}

function showLogin(errorMessage = "") {
  state.accountingRenderVersion += 1;
  state.financeRenderVersion += 1;
  state.smartChecks = [];
  state.taxDraftPayload = null;
  state.importInspection = null;
  state.importContentBase64 = "";
  state.importReadVersion += 1;
  state.importStage = 0;
  state.importStatus = "idle";
  state.importError = "";
  state.importPreview = null;
  state.importMapping = {};
  state.importSelectedRows = [];
  state.importResult = null;
  state.importIdempotencyKey = "";
  state.ocrInspection = null;
  state.ocrPreviewDataUrl = "";
  state.ocrPreviewLoading = false;
  state.ocrReadVersion += 1;
  state.auditEntries = [];
  state.auditStatus = "idle";
  state.auditError = "";
  state.members = [];
  state.membersStatus = "idle";
  state.membersError = "";
  state.notificationSettings = null;
  state.notificationPreferenceDraft = null;
  state.notificationSettingsStatus = "idle";
  state.notificationSettingsError = "";
  state.notificationSettingsSaveStatus = "idle";
  state.notificationSettingsSaveError = "";
  state.invitationUrl = "";
  state.invitationExpiresAt = "";
  state.invitationToken = "";
  state.editingOrderId = "";
  state.editingOrderVersion = 0;
  byId("view-imports")?.replaceChildren();
  byId("view-ocr")?.replaceChildren();
  byId("appShell").classList.add("hidden");
  byId("loginScreen").classList.remove("hidden");
  byId("invitationForm").classList.add("hidden");
  byId("authTabs").classList.remove("hidden");
  byId("loginNote").classList.remove("hidden");
  byId("loginHeadingTitle").textContent = "欢迎回来";
  byId("loginHeadingSubtitle").textContent = "登录你的企业账本";
  resetSmsChallenge();
  setAuthMode("password", { focus: false });
  setFormError(byId("loginError"), errorMessage);
  byId("loginSubmit").disabled = false;
}

function showInvitationAcceptance(token) {
  state.invitationToken = token;
  byId("appShell").classList.add("hidden");
  byId("loginScreen").classList.remove("hidden");
  byId("loginForm").classList.add("hidden");
  byId("smsLoginForm").classList.add("hidden");
  byId("invitationForm").classList.remove("hidden");
  byId("authTabs").classList.add("hidden");
  byId("loginNote").classList.add("hidden");
  resetSmsChallenge();
  byId("invitationToken").value = token;
  byId("invitationError").textContent = "";
  byId("invitationError").classList.add("hidden");
  byId("loginHeadingTitle").textContent = "加入企业账本";
  byId("loginHeadingSubtitle").textContent = "验证邀请并设置你的登录密码";
  refreshIcons();
}

function showApplication() {
  resetSmsChallenge();
  byId("loginScreen").classList.add("hidden");
  byId("appShell").classList.remove("hidden");
}

function applyBootstrap(payload) {
  state.data = normalizeBootstrap(payload);
  const { tenant, user, role } = state.data;
  byId("workspaceName").textContent = tenant.name;
  byId("workspaceMeta").textContent = `${tenant.timezone} · ${roleLabels[role]}`;
  byId("workspaceIdentity").setAttribute("aria-label", `当前企业：${tenant.name}`);
  byId("userName").textContent = user.displayName;
  byId("userAvatar").textContent = initial(user.displayName, "用");
  byId("topbarPeriod").textContent = `${tenantDate(new Date()).slice(0, 7)} 会计期间`;
  document.querySelector(".user-menu").setAttribute("aria-label", `当前账号：${user.displayName}`);
  showApplication();
  renderAll();
}

async function loadBootstrap({ announce = false } = {}) {
  const payload = await apiRequest("/api/bootstrap", { busyText: "正在读取企业账本" });
  applyBootstrap(payload);
  if (announce) showToast("数据已刷新");
}

async function completeLogin(loginPayload) {
  const fallbackToken = typeof loginPayload.token === "string" ? loginPayload.token : null;
  state.token = null;
  try {
    await loadBootstrap();
  } catch (cookieError) {
    if (cookieError.status !== 401 || !fallbackToken) throw cookieError;
    state.token = fallbackToken;
    await loadBootstrap();
  }
}

async function initializeSession() {
  state.token = null;
  try {
    await loadBootstrap();
  } catch (error) {
    if (error.status === 401) showLogin();
    else showLogin(error.message);
  }
}

async function login(event) {
  event.preventDefault();
  const submit = byId("loginSubmit");
  const errorElement = byId("loginError");
  setFormError(errorElement);
  submit.disabled = true;
  submit.setAttribute("aria-busy", "true");
  try {
    const loginPayload = await apiRequest("/api/auth/login", {
      method: "POST",
      auth: false,
      busyText: "正在安全登录",
      body: {
        phone: byId("loginPhone").value.trim(),
        password: byId("loginPassword").value
      }
    });
    await completeLogin(loginPayload);
    byId("loginPassword").value = "";
    showToast("登录成功");
  } catch (error) {
    setFormError(errorElement, error.message);
  } finally {
    submit.disabled = false;
    submit.removeAttribute("aria-busy");
  }
}

async function requestSmsCode() {
  const phoneInput = byId("smsLoginPhone");
  const sendButton = byId("smsCodeSend");
  const errorElement = byId("smsLoginError");
  const statusElement = byId("smsCodeStatus");
  setFormError(errorElement);
  if (!phoneInput.reportValidity()) return;

  state.smsRequestPending = true;
  phoneInput.disabled = true;
  sendButton.setAttribute("aria-busy", "true");
  updateSmsCountdown();
  try {
    const phone = phoneInput.value.trim();
    const payload = await apiRequest("/api/auth/sms-codes", {
      method: "POST",
      auth: false,
      busyText: "正在发送验证码",
      body: { phone }
    });
    if (typeof payload.challengeId !== "string" || !payload.challengeId) {
      throw new ApiClientError(502, "INVALID_SMS_RESPONSE", "验证码服务响应无效，请稍后再试");
    }
    state.smsChallengeId = payload.challengeId;
    state.smsChallengePhone = phone;
    const expiresInSeconds = Math.max(1, Number(payload.expiresInSeconds) || 300);
    const expiryText = expiresInSeconds < 60
      ? `${Math.ceil(expiresInSeconds)} 秒`
      : `${Math.ceil(expiresInSeconds / 60)} 分钟`;
    statusElement.textContent = `验证码已发送，${expiryText}内有效`;
    statusElement.dataset.kind = "success";
    startSmsCountdown(payload.retryAfterSeconds);
    if (state.authMode === "sms") byId("smsLoginCode").focus();
  } catch (error) {
    if (error.status === 429 && error.retryAfterSeconds > 0) startSmsCountdown(error.retryAfterSeconds);
    setFormError(errorElement, error.message);
  } finally {
    state.smsRequestPending = false;
    phoneInput.disabled = false;
    sendButton.removeAttribute("aria-busy");
    updateSmsCountdown();
  }
}

async function loginWithSms(event) {
  event.preventDefault();
  const submit = byId("smsLoginSubmit");
  const errorElement = byId("smsLoginError");
  const phone = byId("smsLoginPhone").value.trim();
  setFormError(errorElement);
  if (!state.smsChallengeId || phone !== state.smsChallengePhone) {
    setFormError(errorElement, "请先为当前手机号获取验证码");
    byId("smsCodeSend").focus();
    return;
  }

  submit.disabled = true;
  submit.setAttribute("aria-busy", "true");
  try {
    const loginPayload = await apiRequest("/api/auth/sms-login", {
      method: "POST",
      auth: false,
      busyText: "正在验证并登录",
      body: {
        phone,
        challengeId: state.smsChallengeId,
        code: byId("smsLoginCode").value.trim()
      }
    });
    await completeLogin(loginPayload);
    resetSmsChallenge();
    showToast("登录成功");
  } catch (error) {
    setFormError(errorElement, error.message);
    if (error.code === "INVALID_SMS_CODE") {
      byId("smsLoginCode").focus();
      byId("smsLoginCode").select();
    }
  } finally {
    submit.disabled = false;
    submit.removeAttribute("aria-busy");
  }
}

async function acceptInvitation(event) {
  event.preventDefault();
  const submit = byId("invitationSubmit");
  const errorElement = byId("invitationError");
  const password = byId("invitationPassword").value;
  const confirmation = byId("invitationPasswordConfirm").value;
  errorElement.textContent = "";
  errorElement.classList.add("hidden");
  if (password !== confirmation) {
    errorElement.textContent = "两次输入的密码不一致";
    errorElement.classList.remove("hidden");
    return;
  }
  submit.disabled = true;
  try {
    const payload = await apiRequest("/api/auth/accept-invitation", {
      method: "POST",
      auth: false,
      busyText: "正在接受企业邀请",
      body: { token: state.invitationToken, password }
    });
    window.history.replaceState({}, "", window.location.pathname);
    byId("invitationPassword").value = "";
    byId("invitationPasswordConfirm").value = "";
    showLogin();
    if (payload.member?.phone) byId("loginPhone").value = payload.member.phone;
    showToast("邀请已接受，请使用新密码登录", "success");
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.classList.remove("hidden");
  } finally {
    submit.disabled = false;
  }
}

async function logout(button) {
  if (button) button.disabled = true;
  try {
    await apiRequest("/api/auth/logout", { method: "POST", busyText: "正在安全退出" });
    state.token = null;
    state.data = null;
    byId("loginPassword").value = "";
    showLogin();
    showToast("已安全退出");
  } catch (error) {
    if (error.status === 401) {
      state.token = null;
      state.data = null;
      showLogin();
    }
    showToast(error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function initial(value, fallback) {
  return String(value || fallback).trim().slice(0, 1).toUpperCase();
}

function formatDate(value, options = {}) {
  if (!value) return "未设置";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly && !options.time) return `${dateOnly[1]}/${dateOnly[2]}/${dateOnly[3]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: state.data?.tenant.timezone || "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(options.time ? { hour: "2-digit", minute: "2-digit", hour12: false } : {})
    }).format(date);
  } catch {
    return date.toLocaleString("zh-CN");
  }
}

function tenantTimeZone() {
  return state.data?.tenant.timezone || "Asia/Shanghai";
}

function tomorrowNineValue() {
  const today = toDateInputValue(new Date(), tenantTimeZone());
  return `${addDaysToDateInput(today, 1)}T09:00`;
}

function settlementLabel(order) {
  if (order.settlementMonths) return `交货后 ${order.settlementMonths} 个月`;
  if (order.settlementDays) return `交货后 ${order.settlementDays} 天`;
  return "交货即结";
}

function statusBadge(order) {
  const status = displayOrderStatus(order);
  return `<span class="status-badge ${status.className}">${status.label}</span>`;
}

function moneyMarkup(cents, currency) {
  return escapeHtml(formatMoney(cents, currency));
}

function groupedMoneyMarkup(groups, emptyText = "暂无") {
  if (!groups.length) return `<span class="muted-value">${escapeHtml(emptyText)}</span>`;
  return `<span class="currency-stack">${groups.map((group) => `<strong>${moneyMarkup(group.cents, group.currency)}</strong>`).join("")}</span>`;
}

function tenantDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return toDateInputValue(date, tenantTimeZone());
}

function dueBucket(value) {
  const dueDate = tenantDate(value);
  if (!dueDate) return "later";
  const today = tenantDate(new Date());
  return dueBucketForDateInputs(dueDate, today);
}

function displayOrderStatus(order) {
  return orderStatus(order, {
    isOverdue: order.outstandingCents > 0 && dueBucket(order.dueAt) === "overdue"
  });
}

function groupDirectionalOutstanding(orders) {
  const groups = new Map();
  orders.forEach((order) => {
    if (order.fulfillmentStatus !== "fulfilled" || order.outstandingCents <= 0) return;
    const key = `${order.direction}:${order.currency}`;
    const current = groups.get(key) || { direction: order.direction, currency: order.currency, cents: 0 };
    current.cents += order.outstandingCents;
    groups.set(key, current);
  });
  return [...groups.values()].sort((a, b) => `${a.direction}:${a.currency}`.localeCompare(`${b.direction}:${b.currency}`));
}

function directionalMoneyMarkup(groups, emptyText = "暂无") {
  if (!groups.length) return `<span class="muted-value">${escapeHtml(emptyText)}</span>`;
  return `<span class="currency-stack directional-money">${groups.map((group) => `<strong><em>${group.direction === "receivable" ? "应收" : "应付"}</em>${moneyMarkup(group.cents, group.currency)}</strong>`).join("")}</span>`;
}

function dueMarkup(order) {
  if (order.fulfillmentStatus !== "fulfilled") {
    return `${escapeHtml(formatDate(order.plannedDeliveryDate))}<small>计划交货</small>`;
  }
  const dueDate = tenantDate(order.dueAt);
  if (!dueDate) return `未设置<small>等待到期日</small>`;
  const today = tenantDate(new Date());
  const days = daysBetweenDateInputs(today, dueDate);
  const bucket = dueBucketForDateInputs(dueDate, today);
  const detail = order.outstandingCents === 0 ? "已结清" : bucket === "overdue" ? `已逾期 ${Math.abs(days)} 天` : bucket === "today" ? "今天到期" : `还有 ${days} 天`;
  return `${escapeHtml(formatDate(order.dueAt))}<small class="${bucket === "overdue" && order.outstandingCents > 0 ? "overdue-text" : ""}">${escapeHtml(detail)}</small>`;
}

function emptyState(message, iconName = "inbox") {
  return `<div class="empty-state">${icon(iconName, 28)}<div>${escapeHtml(message)}</div></div>`;
}

function actionButtons(order, compact = false) {
  const buttons = [];
  if (order.fulfillmentStatus === "planned" && roleCan(state.data.role, "fulfill")) {
    buttons.push(`<button class="fulfill-action" data-action="open-fulfill" data-order-id="${escapeAttr(order.id)}">确认交货</button>`);
  }
  if (order.fulfillmentStatus === "fulfilled" && order.outstandingCents > 0 && roleCan(state.data.role, "payment")) {
    buttons.push(`<button class="payment-action" data-action="open-payment" data-order-id="${escapeAttr(order.id)}">${order.direction === "receivable" ? "登记收款" : "登记付款"}</button>`);
  }
  if (!compact) buttons.push(`<button class="detail-action" data-action="view-detail" data-order-id="${escapeAttr(order.id)}" aria-label="查看订单详情" title="查看订单详情">${icon("chevron-right", 15)}</button>`);
  return buttons.join("");
}

function renderOrderRows(orders, columns = 9) {
  if (!orders.length) return `<tr class="empty-table-row"><td class="empty-table-cell" colspan="${columns}">${emptyState("没有符合条件的订单", "search-x")}</td></tr>`;
  return orders.map((order) => `<tr data-order-id="${escapeAttr(order.id)}" tabindex="0" aria-label="查看订单 ${escapeAttr(order.orderNo)}">
    <td class="partner-cell" data-label="订单 / 对象"><div class="table-partner"><span class="mini-avatar">${escapeHtml(initial(order.partnerName, "客"))}</span><div><strong dir="auto">${escapeHtml(order.partnerName)}</strong><div class="ledger-meta" dir="auto">${escapeHtml(order.orderNo)}</div></div></div></td>
    <td data-label="方向"><span class="direction-label ${order.direction}">${order.direction === "receivable" ? "客户应收" : "供应商应付"}</span></td>
    <td data-label="交货状态"><span class="fulfillment-label ${order.fulfillmentStatus}">${order.fulfillmentStatus === "fulfilled" ? "已交货" : order.fulfillmentStatus === "cancelled" ? "已取消" : "待交货"}</span></td>
    <td class="due-cell" data-label="到期日">${dueMarkup(order)}</td>
    <td class="amount-cell" data-label="订单金额">${moneyMarkup(order.totalCents, order.currency)}</td>
    <td class="amount-cell" data-label="已结金额">${moneyMarkup(order.paidCents, order.currency)}</td>
    <td class="amount-cell balance-cell" data-label="未结金额"><strong>${moneyMarkup(order.outstandingCents, order.currency)}</strong></td>
    <td data-label="结算状态">${statusBadge(order)}</td>
    <td class="actions-cell"><div class="row-actions">${actionButtons(order)}</div></td>
  </tr>`).join("");
}

function renderLedgerRows(direction, limit = null) {
  let orders = state.data.orders.filter((order) => order.direction === direction && order.fulfillmentStatus === "fulfilled" && order.outstandingCents > 0);
  if (limit) orders = orders.slice(0, limit);
  if (!orders.length) return emptyState("没有待结算订单", "circle-check");
  return orders.map((order) => `<div class="ledger-row" data-order-id="${escapeAttr(order.id)}" role="button" tabindex="0" aria-label="查看订单 ${escapeAttr(order.orderNo)}"><div class="ledger-main"><div class="ledger-name"><span dir="auto">${escapeHtml(order.partnerName)}</span>${statusBadge(order)}</div><div class="ledger-meta" dir="auto">${escapeHtml(order.orderNo)} · ${escapeHtml(settlementLabel(order))}</div></div><div class="ledger-money"><strong>${moneyMarkup(order.outstandingCents, order.currency)}</strong><small>总额 ${moneyMarkup(order.totalCents, order.currency)}</small></div></div>`).join("");
}

function overviewRecentOrdersMarkup(orders) {
  const recent = [...orders]
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, 5);
  if (!recent.length) return emptyState("还没有订单", "receipt-text");
  return recent.map((order) => `<button type="button" class="overview-feed-row" data-action="view-detail" data-order-id="${escapeAttr(order.id)}">
    <span class="feed-symbol ${order.direction}">${icon(order.direction === "receivable" ? "arrow-down-left" : "arrow-up-right", 15)}</span>
    <span class="feed-copy"><span class="feed-title"><strong dir="auto">${escapeHtml(order.partnerName)}</strong>${statusBadge(order)}</span><small dir="auto">${escapeHtml(order.orderNo)} · ${order.direction === "receivable" ? "客户应收" : "供应商应付"}</small></span>
    <span class="feed-value"><strong>${moneyMarkup(order.totalCents, order.currency)}</strong><small>${escapeHtml(formatDate(order.createdAt))}</small></span>
  </button>`).join("");
}

function overviewPaymentActivityMarkup(payments) {
  if (!payments.length) return emptyState("还没有收付款记录", "wallet-cards");
  return payments.slice(0, 5).map((payment) => {
    const reversed = Boolean(payment.reversedAt);
    const directionLabel = payment.direction === "receivable" ? "收款" : "付款";
    return `<button type="button" class="overview-feed-row ${reversed ? "is-reversed" : ""}" data-action="view-detail" data-order-id="${escapeAttr(payment.orderId)}">
      <span class="feed-symbol ${payment.direction}">${icon("banknote", 15)}</span>
      <span class="feed-copy"><span class="feed-title"><strong dir="auto">${escapeHtml(payment.partnerName)}</strong>${reversed ? '<span class="status-badge overdue">已冲销</span>' : ""}</span><small dir="auto">${escapeHtml(payment.orderNo)} · ${escapeHtml(paymentMethodLabels[payment.method] || payment.method || directionLabel)}</small></span>
      <span class="feed-value"><strong>${directionLabel} ${moneyMarkup(payment.amountCents, payment.currency)}</strong><small>${escapeHtml(formatDate(payment.paidAt, { time: true }))}</small></span>
    </button>`;
  }).join("");
}

function overviewDueTrendMarkup(orders) {
  const counts = { overdue: 0, today: 0, upcoming: 0, later: 0 };
  orders.forEach((order) => {
    if (order.fulfillmentStatus !== "fulfilled" || order.outstandingCents <= 0) return;
    counts[dueBucket(order.dueAt)] += 1;
  });
  const buckets = [
    ["overdue", "已逾期"],
    ["today", "今日到期"],
    ["upcoming", "未来 7 天"],
    ["later", "7 天以后"]
  ];
  const maximum = Math.max(1, ...Object.values(counts));
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return `<div class="due-trend-summary"><strong>${total}</strong><span>笔未结订单按到期时间分布</span></div><div class="due-trend-list">${buckets.map(([key, label]) => `<div class="due-trend-row ${key}"><div><span>${label}</span><b>${counts[key]}</b></div><progress max="${maximum}" value="${counts[key]}" aria-label="${label} ${counts[key]} 笔"></progress></div>`).join("")}</div>`;
}

function accountingSnapshotMarkup() {
  const accounts = state.data.accounting?.accounts || [];
  const byCode = new Map(accounts.map((account) => [account.code, account]));
  const cnyOrders = state.data.orders.filter((order) => order.currency === "CNY");
  const foreignOrders = state.data.orders.filter((order) => order.currency !== "CNY" && order.fulfillmentStatus === "fulfilled").length;
  const useAccountBalances = accounts.length > 0 && foreignOrders === 0;
  const cnyPayments = cnyOrders.reduce((sum, order) => sum + Number(order.paidCents || 0), 0);
  const derived = {
    cash: cnyPayments,
    receivable: cnyOrders
      .filter((order) => order.direction === "receivable" && order.fulfillmentStatus === "fulfilled")
      .reduce((sum, order) => sum + Number(order.outstandingCents || 0), 0),
    payable: cnyOrders
      .filter((order) => order.direction === "payable" && order.fulfillmentStatus === "fulfilled")
      .reduce((sum, order) => sum + Number(order.outstandingCents || 0), 0),
    revenue: cnyOrders
      .filter((order) => order.direction === "receivable" && order.fulfillmentStatus === "fulfilled")
      .reduce((sum, order) => sum + Number(order.totalCents || 0), 0)
  };
  const accountBalance = (code, fallback, normalSide = "debit") => {
    const account = byCode.get(code);
    if (!account) return fallback;
    const debit = Number(account.debitCents || 0);
    const credit = Number(account.creditCents || 0);
    return normalSide === "credit" ? credit - debit : debit - credit;
  };
  const cash = useAccountBalances ? accountBalance("1002", derived.cash) : derived.cash;
  const receivable = useAccountBalances ? accountBalance("1122", derived.receivable) : derived.receivable;
  const payable = useAccountBalances ? accountBalance("2202", derived.payable, "credit") : derived.payable;
  const inventory = useAccountBalances ? accountBalance("1405", 0) : 0;
  const revenue = useAccountBalances
    ? accounts.filter((account) => account.category === "revenue").reduce((sum, account) => sum + Number(account.creditCents || 0) - Number(account.debitCents || 0), 0)
    : derived.revenue;
  const spending = useAccountBalances
    ? accounts.filter((account) => account.category === "cost" || account.category === "expense").reduce((sum, account) => sum + Number(account.debitCents || 0) - Number(account.creditCents || 0), 0)
    : cnyOrders.filter((order) => order.direction === "payable" && order.fulfillmentStatus === "fulfilled").reduce((sum, order) => sum + Number(order.totalCents || 0), 0);
  const profit = revenue - spending;
  const items = [
    ["收入", revenue, "green", "chart-no-axes-combined"],
    ["成本与费用", spending, "amber", "receipt"],
    ["账面利润*", profit, profit >= 0 ? "green" : "red", "badge-percent"],
    ["资金余额", cash, "blue", "landmark"],
    ["应收款", receivable, "green", "arrow-down-left"],
    ["应付款", payable, "blue", "arrow-up-right"],
    ["库存金额", inventory, "amber", "warehouse"]
  ];
  return `<section class="panel accounting-snapshot operating-snapshot"><div class="panel-header"><div><h2>经营与财务结果</h2><span>以通俗经营语言展示，来源为服务器订单和自动记账结果。</span></div><button class="text-button" data-view="reports">查看财务报表 ${icon("arrow-up-right", 13)}</button></div><div class="accounting-snapshot-grid operating-metric-grid">${items.map(([label, cents, tone, iconName]) => `<button type="button" class="accounting-snapshot-item operating-metric" data-view="${label === "应收款" ? "receivable" : label === "应付款" ? "payable" : label === "库存金额" ? "inventory" : label === "资金余额" ? "accounting" : "reports"}"><span>${icon(iconName, 15)}${label}</span><strong class="${tone}-text">${formatMoney(Number(cents), "CNY")}</strong></button>`).join("")}</div><div class="accounting-snapshot-note">${useAccountBalances ? "数据来源：已入账凭证 · 自动汇总 · 本位币 CNY。" : "当前按人民币订单形成经营预览。"} *销售成本结转和费用单据尚未接入，账面利润只用于流程演示，不作为完整经营或纳税结论。${foreignOrders ? ` 检测到 ${foreignOrders} 笔外币业务，正式折算前已从人民币指标中排除。` : ""}</div></section>`;
}

function overviewQuickActionsMarkup() {
  const canCreate = roleCan(state.data.role, "createOrder");
  const canPay = roleCan(state.data.role, "payment");
  const actions = [
    canCreate ? ["new-order", "receivable", "badge-plus", "新建销售订单", "客户下单或销售出货"] : null,
    canCreate ? ["new-order", "payable", "shopping-cart", "新建采购订单", "向供应商采购或收货"] : null,
    canPay ? ["open-payment-queue", "", "wallet-cards", "登记收付款", "支持一笔订单分多次结算"] : null,
    ["go-local-evidence", "", "scan-line", "上传票据", "先在本地识别和校对"],
    ["open-expense-capability", "", "receipt", "费用报销", "查看费用模块接入状态"],
    ["open-smart-checks", "", "shield-alert", "查看异常", "核对凭证、账款和外币风险"]
  ].filter(Boolean);
  return `<section class="quick-workbench" aria-label="常用业务">${actions.map(([action, direction, iconName, label, detail]) => `<button type="button" class="quick-workbench-action" data-action="${action}"${direction ? ` data-direction="${direction}"` : ""}><span>${icon(iconName, 18)}</span><strong>${label}</strong><small>${detail}</small></button>`).join("")}</section>`;
}

function overviewProcessMarkup(orders) {
  const fulfilled = orders.filter((order) => order.fulfillmentStatus === "fulfilled").length;
  const settled = orders.filter((order) => order.settlementStatus === "settled").length;
  const processSteps = [
    ["orders", "订单录入", orders.length, "complete"],
    ["evidence", "原始凭证", null, "unavailable"],
    ["approvals", "审批", null, "unavailable"],
    ["inventory", "完成交收", fulfilled, fulfilled ? "complete" : "pending"],
    ["accounting", "自动凭证", fulfilled, fulfilled ? "complete" : "pending"],
    ["reports", "财务结果", fulfilled, fulfilled ? "complete" : "pending"]
  ];
  return `<section class="panel process-overview"><div class="panel-header"><div><h2>订单到财务结果</h2><span>同一笔业务只录一次，沿链路自动沉淀；未接入环节不会伪装完成。</span></div><span class="status-badge ${fulfilled ? "settled" : "pending"}">${settled}/${orders.length} 笔已结清</span></div><div class="process-track">${processSteps.map(([view, label, count, status], index) => `<button type="button" class="process-step ${status}" data-view="${view}"><span class="process-step-index">${status === "complete" ? icon("check", 14) : status === "unavailable" ? icon("plug-zap", 14) : index + 1}</span><strong>${label}</strong><small>${status === "unavailable" ? "待接入" : `${count} 笔`}</small></button>`).join("")}</div><div class="process-footnote">当前共 ${orders.length} 笔订单，${fulfilled} 笔已确认交收并触发自动记账，${orders.length - fulfilled} 笔仍在业务阶段。</div></section>`;
}

function overviewTodoMarkup(orders, reminders) {
  const planned = orders.filter((order) => order.fulfillmentStatus === "planned").length;
  const overdue = orders.filter((order) => order.outstandingCents > 0 && dueBucket(order.dueAt) === "overdue").length;
  const foreign = orders.filter((order) => order.currency !== "CNY" && order.fulfillmentStatus === "fulfilled").length;
  const todos = [
    ["orders", planned, "待确认交货", planned ? "影响到期日和自动记账" : "当前无待交货订单", planned ? "amber" : "green"],
    ["reminders", overdue, "逾期账款", overdue ? "需要优先跟进结算" : "当前无逾期账款", overdue ? "red" : "green"],
    ["evidence", "--", "原始凭证", "对象存储未接入，暂无法核验缺失", "muted"],
    ["checks", foreign, "外币业务", foreign ? "正式汇率折算前不可并入 CNY 报表" : "当前无外币入账风险", foreign ? "red" : "green"]
  ];
  return `<section class="panel todo-overview"><div class="panel-header"><div><h2>待办与异常</h2><span>${reminders.length} 条系统提醒 · 只提示，不自动修改原始数据</span></div><button class="text-button" data-view="checks">全部检查 ${icon("arrow-up-right", 13)}</button></div><div class="todo-list">${todos.map(([view, value, label, detail, tone]) => `<button type="button" class="todo-row" data-view="${view}"><span class="todo-value ${tone}-text">${value}</span><span><strong>${label}</strong><small>${detail}</small></span>${icon("chevron-right", 16)}</button>`).join("")}</div></section>`;
}

function renderOverview() {
  const orders = state.data.orders;
  const reminders = state.data.reminders;
  const planned = orders.filter((order) => order.fulfillmentStatus === "planned");
  const today = tenantDate(new Date());
  const currentMonth = today.slice(0, 7);
  const dueThisMonth = orders.filter((order) => tenantDate(order.dueAt).startsWith(currentMonth));
  const receivable = groupOutstanding(dueThisMonth, "receivable");
  const payable = groupOutstanding(dueThisMonth, "payable");
  const overdueOrders = orders.filter((order) => order.outstandingCents > 0 && dueBucket(order.dueAt) === "overdue");
  const upcomingOrders = orders.filter((order) => order.outstandingCents > 0 && dueBucket(order.dueAt) === "upcoming");
  const urgentOrder = [...overdueOrders].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())[0];
  const view = byId("view-overview");
  view.innerHTML = `
    <div class="view-heading"><div><p class="eyebrow">BUSINESS & FINANCE</p><h1>经营工作台</h1><p>${escapeHtml(state.data.tenant.name)} · 订单、资金与财务结果已连接</p></div><div class="heading-actions">${roleCan(state.data.role, "payment") ? `<button class="outline-button" data-action="open-payment-queue">${icon("wallet-cards")}登记收付款</button>` : ""}${roleCan(state.data.role, "createOrder") ? `<button class="primary-button" data-action="new-order">${icon("plus")}新建订单</button>` : ""}</div></div>
    ${overviewQuickActionsMarkup()}
    ${accountingSnapshotMarkup()}
    <div class="workbench-grid">${overviewProcessMarkup(orders)}${overviewTodoMarkup(orders, reminders)}</div>
    <div class="kpi-grid settlement-health-grid">
      <div class="kpi"><div class="kpi-top"><span>本月待收</span><span class="kpi-icon green">${icon("arrow-down-left")}</span></div>${groupedMoneyMarkup(receivable, "本月暂无应收")}<small>${dueThisMonth.filter((order) => order.direction === "receivable" && order.outstandingCents > 0).length} 笔本月到期</small></div>
      <div class="kpi"><div class="kpi-top"><span>本月待付</span><span class="kpi-icon blue">${icon("arrow-up-right")}</span></div>${groupedMoneyMarkup(payable, "本月暂无应付")}<small>${dueThisMonth.filter((order) => order.direction === "payable" && order.outstandingCents > 0).length} 笔本月到期</small></div>
      <div class="kpi"><div class="kpi-top"><span>逾期未结</span><span class="kpi-icon red">${icon("triangle-alert")}</span></div>${directionalMoneyMarkup(groupDirectionalOutstanding(overdueOrders), "暂无逾期")}<small>${overdueOrders.length} 笔需要优先处理</small></div>
      <div class="kpi"><div class="kpi-top"><span>未来 7 天到期</span><span class="kpi-icon amber">${icon("calendar-clock")}</span></div>${directionalMoneyMarkup(groupDirectionalOutstanding(upcomingOrders), "暂无到期")}<small>${upcomingOrders.length} 笔即将到期</small></div>
    </div>
    <div class="alert-banner ${overdueOrders.length ? "urgent" : reminders.length ? "" : "cleared"}"><div class="alert-banner-content">${icon(overdueOrders.length ? "triangle-alert" : reminders.length ? "bell-ring" : "circle-check", 18)}<div><strong>${overdueOrders.length ? `有 ${overdueOrders.length} 笔逾期账款需要立即处理` : reminders.length ? `有 ${reminders.length} 笔账款需要处理` : "当前提醒已处理完成"}</strong><span>${urgentOrder ? `${escapeHtml(urgentOrder.partnerName)} · ${escapeHtml(urgentOrder.orderNo)} · ${urgentOrder.direction === "receivable" ? "应收" : "应付"} ${moneyMarkup(urgentOrder.outstandingCents, urgentOrder.currency)}` : reminders.length ? "处理后可在提醒中心确认或调整下次提醒时间。" : "新账款进入提醒窗口后会自动显示。"}</span></div></div>${reminders.length ? `<button class="text-button" data-view="reminders">查看提醒 ${icon("arrow-up-right", 13)}</button>` : ""}</div>
    ${planned.length ? `<section class="pending-deliveries"><div class="panel-header"><div><h2>待确认交货</h2><span>计划日期不会自动触发结算</span></div><button class="text-button" data-view="orders">查看全部</button></div><div class="compact-order-list">${planned.slice(0, 4).map((order) => `<div class="compact-order"><div><strong dir="auto">${escapeHtml(order.partnerName)}</strong><span dir="auto">${escapeHtml(order.orderNo)} · 计划 ${escapeHtml(formatDate(order.plannedDeliveryDate))}</span></div><div class="compact-order-actions"><b>${moneyMarkup(order.totalCents, order.currency)}</b>${actionButtons(order, true)}</div></div>`).join("")}</div></section>` : ""}
    <div class="panel-grid"><section class="panel"><div class="panel-header"><div><h2>客户应收</h2><span>已交货且尚未收清</span></div><button class="text-button" data-view="receivable">查看全部 ${icon("arrow-up-right", 13)}</button></div><div class="ledger-list">${renderLedgerRows("receivable", 4)}</div></section><section class="panel"><div class="panel-header"><div><h2>供应商应付</h2><span>已收货且尚未付清</span></div><button class="text-button" data-view="payable">查看全部 ${icon("arrow-up-right", 13)}</button></div><div class="ledger-list">${renderLedgerRows("payable", 4)}</div></section></div>
    <div class="overview-insight-grid"><section class="panel overview-feed-panel"><div class="panel-header"><div><h2>最近订单</h2><span>按创建时间排列</span></div><button class="text-button" data-view="orders">查看全部 ${icon("arrow-up-right", 13)}</button></div><div class="overview-feed">${overviewRecentOrdersMarkup(orders)}</div></section><section class="panel overview-feed-panel"><div class="panel-header"><div><h2>付款动态</h2><span>真实收付款与冲销记录</span></div></div><div class="overview-feed">${overviewPaymentActivityMarkup(state.data.recentPayments)}</div></section><section class="panel due-trend-panel"><div class="panel-header"><div><h2>账期趋势</h2><span>不同币种不合并金额</span></div><button class="text-button" data-view="reminders">查看提醒 ${icon("arrow-up-right", 13)}</button></div>${overviewDueTrendMarkup(orders)}</section></div>`;
}

function filteredLedgerOrders(direction) {
  const search = state.ledgerSearch[direction].toLowerCase();
  const filter = state.ledgerFilters[direction];
  return state.data.orders.filter((order) => {
    if (order.direction !== direction || order.fulfillmentStatus !== "fulfilled" || order.outstandingCents <= 0) return false;
    if (search && !`${order.partnerName}${order.orderNo}`.toLowerCase().includes(search)) return false;
    const status = displayOrderStatus(order);
    return filter === "all" || (filter === "overdue" && status.className === "overdue") || (filter === "partial" && order.settlementStatus === "partial") || (filter === "pending" && order.paidCents === 0);
  });
}

function renderLedgerView(direction) {
  const isReceivable = direction === "receivable";
  const orders = filteredLedgerOrders(direction);
  const allDirectionOrders = state.data.orders.filter((order) => order.direction === direction);
  byId(`view-${direction}`).innerHTML = `<div class="view-heading"><div><p class="eyebrow">${isReceivable ? "RECEIVABLES" : "PAYABLES"}</p><h1>${isReceivable ? "客户应收" : "供应商应付"}</h1><p>${isReceivable ? "登记客户每一次付款，余额由服务器自动派生。" : "安排供应商货款，完整保留每次付款记录。"}</p></div><div class="heading-actions">${roleCan(state.data.role, "createOrder") ? `<button class="primary-button" data-action="new-order" data-direction="${direction}">${icon("plus")}新建${isReceivable ? "应收" : "应付"}</button>` : ""}</div></div>
    <div class="kpi-grid compact-kpis"><div class="kpi"><div class="kpi-top"><span>${isReceivable ? "待收余额" : "待付余额"}</span><span class="kpi-icon ${isReceivable ? "green" : "blue"}">${icon(isReceivable ? "arrow-down-left" : "arrow-up-right")}</span></div>${groupedMoneyMarkup(groupOutstanding(state.data.orders, direction))}<small>不同币种分开统计</small></div><div class="kpi"><div class="kpi-top"><span>部分结算</span><span class="kpi-icon amber">${icon("circle-dot")}</span></div><strong>${allDirectionOrders.filter((order) => order.settlementStatus === "partial").length}</strong><small>可继续分批登记</small></div><div class="kpi"><div class="kpi-top"><span>已结清</span><span class="kpi-icon green">${icon("circle-check")}</span></div><strong>${allDirectionOrders.filter((order) => order.settlementStatus === "settled").length}</strong><small>历史订单</small></div><div class="kpi"><div class="kpi-top"><span>待交货</span><span class="kpi-icon blue">${icon("package-open")}</span></div><strong>${allDirectionOrders.filter((order) => order.fulfillmentStatus === "planned").length}</strong><small>尚未进入结算</small></div></div>
    <div class="table-toolbar"><div class="filter-row"><button class="filter-pill ${state.ledgerFilters[direction] === "all" ? "active" : ""}" aria-pressed="${state.ledgerFilters[direction] === "all"}" data-ledger-filter="all" data-direction="${direction}">全部</button><button class="filter-pill ${state.ledgerFilters[direction] === "overdue" ? "active" : ""}" aria-pressed="${state.ledgerFilters[direction] === "overdue"}" data-ledger-filter="overdue" data-direction="${direction}">已逾期</button><button class="filter-pill ${state.ledgerFilters[direction] === "partial" ? "active" : ""}" aria-pressed="${state.ledgerFilters[direction] === "partial"}" data-ledger-filter="partial" data-direction="${direction}">部分结算</button><button class="filter-pill ${state.ledgerFilters[direction] === "pending" ? "active" : ""}" aria-pressed="${state.ledgerFilters[direction] === "pending"}" data-ledger-filter="pending" data-direction="${direction}">未开始</button></div><div class="search-box">${icon("search")}<input class="ledger-search" aria-label="搜索${isReceivable ? "客户应收" : "供应商应付"}订单" data-direction="${direction}" value="${escapeAttr(state.ledgerSearch[direction])}" placeholder="搜索往来单位、订单号" /></div></div>
    <div class="data-table-wrap"><table class="data-table"><thead><tr><th>订单 / 对象</th><th>方向</th><th>交货状态</th><th>到期日</th><th>订单金额</th><th>已结金额</th><th>未结金额</th><th>结算状态</th><th></th></tr></thead><tbody id="${direction}Rows">${renderOrderRows(orders)}</tbody></table></div>`;
}

function filteredAllOrders() {
  const search = state.orderSearch.toLowerCase();
  const filters = state.orderFilters;
  return state.data.orders.filter((order) => {
    if (search && !`${order.partnerName}${order.orderNo}`.toLowerCase().includes(search)) return false;
    if (filters.direction !== "all" && order.direction !== filters.direction) return false;
    if (filters.fulfillment !== "all" && order.fulfillmentStatus !== filters.fulfillment) return false;
    if (filters.settlement !== "all" && order.settlementStatus !== filters.settlement) return false;
    if (filters.currency !== "all" && order.currency !== filters.currency) return false;
    if (filters.due !== "all" && (order.outstandingCents <= 0 || dueBucket(order.dueAt) !== filters.due)) return false;
    return true;
  });
}

function renderOrdersView() {
  const orders = filteredAllOrders();
  const currencies = [...new Set(state.data.orders.map((order) => order.currency))].sort();
  const select = (key, label, options) => `<label class="compact-filter"><span>${label}</span><select data-order-filter="${key}" aria-label="${label}">${options.map(([value, text]) => `<option value="${value}" ${state.orderFilters[key] === value ? "selected" : ""}>${text}</option>`).join("")}</select></label>`;
  byId("view-orders").innerHTML = `<div class="view-heading"><div><p class="eyebrow">ALL ORDERS</p><h1>全部订单</h1><p>计划、交货、结算状态均以服务器记录为准。</p></div><div class="heading-actions">${roleCan(state.data.role, "createOrder") ? `<button class="primary-button" data-action="new-order">${icon("plus")}新建订单</button>` : ""}</div></div><div class="orders-toolbar"><div class="order-filter-row">${select("direction", "方向", [["all","全部"],["receivable","客户应收"],["payable","供应商应付"]])}${select("fulfillment", "交货状态", [["all","全部"],["planned","待交货"],["fulfilled","已交货"],["cancelled","已取消"]])}${select("settlement", "结算状态", [["all","全部"],["awaiting","未开始"],["partial","部分结算"],["settled","已结清"]])}${select("due", "到期范围", [["all","全部"],["overdue","已逾期"],["today","今日到期"],["upcoming","未来 7 天"]])}${select("currency", "币种", [["all","全部币种"], ...currencies.map((currency) => [currency,currency])])}</div><div class="search-box">${icon("search")}<input id="ordersSearch" aria-label="搜索订单" value="${escapeAttr(state.orderSearch)}" placeholder="搜索订单号、客户或供应商" /></div></div><div class="data-table-wrap"><table class="data-table"><thead><tr><th>订单 / 对象</th><th>方向</th><th>交货状态</th><th>到期日</th><th>订单金额</th><th>已结金额</th><th>未结金额</th><th>结算状态</th><th></th></tr></thead><tbody id="ordersRows">${renderOrderRows(orders)}</tbody></table></div>`;
}

function capabilityStatusMarkup({ iconName, title, message, tone = "pending", actions = "" }) {
  return `<section class="capability-status ${tone}"><span class="capability-status-icon">${icon(iconName, 22)}</span><div><strong>${title}</strong><p>${message}</p></div>${actions ? `<div class="capability-status-actions">${actions}</div>` : ""}</section>`;
}

function renderEvidenceView() {
  const view = byId("view-evidence");
  if (!view || !state.data) return;
  const fulfilled = state.data.orders.filter((order) => order.fulfillmentStatus === "fulfilled");
  const rows = state.data.orders.slice(0, 8).map((order) => `<tr><td><button class="table-link" type="button" data-action="view-detail" data-order-id="${escapeAttr(order.id)}">${escapeHtml(order.orderNo)}</button></td><td>${escapeHtml(order.partnerName)}</td><td>${order.direction === "receivable" ? "销售订单" : "采购订单"}</td><td class="amount-cell">${moneyMarkup(order.totalCents, order.currency)}</td><td><span class="status-badge draft">无法核验</span><small class="table-subtext">附件存储未接入</small></td><td>${escapeHtml(formatDate(order.orderDate))}</td></tr>`).join("");
  view.innerHTML = `<div class="view-heading"><div><p class="eyebrow">SOURCE DOCUMENTS</p><h1>原始凭证中心</h1><p>发票、合同、收据和银行回单先绑定业务，再进入凭证与审计链路。</p></div><div class="heading-actions"><button class="outline-button" data-view="ocr">${icon("scan-line")}本地识别</button><button class="primary-button" data-action="show-capability" data-capability="document-storage">${icon("cloud-upload")}接入正式上传</button></div></div>
    ${capabilityStatusMarkup({ iconName: "cloud-off", title: "当前仅支持本地预览，文件不会上传或写入账务", message: "对象存储、病毒扫描、PDF 解析、附件版本和订单绑定尚未接入。页面明确显示真实状态，避免把本地预览误认为合规凭证归档。", actions: `<button class="outline-button small-button" data-view="ocr">打开纸单识别</button>` })}
    <div class="capability-kpi-grid"><div><span>服务器已归档</span><strong>0</strong><small>正式存储未启用</small></div><div><span>待核验订单</span><strong>${state.data.orders.length}</strong><small>接入后按订单逐笔核验</small></div><div><span>已交收业务</span><strong>${fulfilled.length}</strong><small>需优先补齐凭证</small></div><div><span>自动风险检查</span><strong>未启用</strong><small>重复票号与金额勾稽待接入</small></div></div>
    <section class="panel capability-workflow"><div class="panel-header"><div><h2>凭证处理流程</h2><span>拍照或上传 → OCR 识别 → 绑定订单 → 财务复核 → 随凭证归档</span></div></div><div class="workflow-ribbon"><span class="available">${icon("scan-line",16)}<strong>本地识别</strong><small>可用</small></span><span>${icon("cloud-upload",16)}<strong>安全上传</strong><small>待 OSS</small></span><span>${icon("link-2",16)}<strong>订单绑定</strong><small>待数据模型</small></span><span>${icon("badge-check",16)}<strong>财务复核</strong><small>待审批</small></span><span>${icon("archive",16)}<strong>审计归档</strong><small>待版本管理</small></span></div></section>
    <section class="panel capability-table-panel"><div class="panel-header"><div><h2>订单凭证核验队列</h2><span>这里列出真实订单，但不会伪造附件或绑定状态。</span></div><button class="text-button" data-view="orders">查看全部订单 ${icon("arrow-up-right",13)}</button></div><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>订单号</th><th>往来单位</th><th>业务类型</th><th>金额</th><th>凭证状态</th><th>业务日期</th></tr></thead><tbody>${rows || `<tr><td colspan="6">暂无订单</td></tr>`}</tbody></table></div></section>`;
}

function renderApprovalsView() {
  const view = byId("view-approvals");
  if (!view || !state.data) return;
  const orderRows = state.data.orders.slice(0, 8).map((order) => `<tr><td><button class="table-link" type="button" data-action="view-detail" data-order-id="${escapeAttr(order.id)}">${escapeHtml(order.orderNo)}</button></td><td>${escapeHtml(order.partnerName)}</td><td>${order.direction === "receivable" ? "销售" : "采购"}</td><td class="amount-cell">${moneyMarkup(order.totalCents, order.currency)}</td><td><span class="status-badge draft">旧流程</span><small class="table-subtext">未经过系统审批</small></td><td>${escapeHtml(roleLabels[state.data.role] || state.data.role)}</td></tr>`).join("");
  view.innerHTML = `<div class="view-heading"><div><p class="eyebrow">APPROVAL CENTER</p><h1>审批中心</h1><p>按业务类型、金额、部门和项目配置审批，未通过的付款不得执行。</p></div><div class="heading-actions"><button class="outline-button" data-view="automation">${icon("workflow")}查看流程模板</button><button class="primary-button" data-action="show-capability" data-capability="approval-engine">${icon("settings-2")}接入审批引擎</button></div></div>
    ${capabilityStatusMarkup({ iconName: "stamp", title: "审批状态机尚未接入，现有订单继续沿用原结算流程", message: "当前系统没有待审批、通过、驳回、转交或会签记录，因此不会给历史订单虚构审批结果。接入后，付款与自动过账将受审批状态控制。" })}
    <div class="capability-kpi-grid"><div><span>我的待审批</span><strong>--</strong><small>流程引擎未启用</small></div><div><span>逾期审批</span><strong>--</strong><small>催办任务未启用</small></div><div><span>已配置流程</span><strong>0</strong><small>默认模板待确认</small></div><div><span>审批审计</span><strong>未接入</strong><small>不得伪造留痕</small></div></div>
    <section class="panel approval-template-panel"><div class="panel-header"><div><h2>推荐的简单审批模板</h2><span>面向小商户，只让需要把关的业务进入审批。</span></div><span class="status-badge pending">建议方案</span></div><div class="approval-template-grid"><div><span>${icon("shopping-cart",18)}</span><strong>采购与付款</strong><p>业务录入 → 负责人确认 → 财务付款</p><small>大额业务可增加二次审批</small></div><div><span>${icon("badge-dollar-sign",18)}</span><strong>销售与赊账</strong><p>业务录入 → 信用检查 → 允许交货</p><small>超账期自动提醒负责人</small></div><div><span>${icon("receipt",18)}</span><strong>费用报销</strong><p>上传票据 → 负责人审批 → 财务入账</p><small>缺附件时不允许付款</small></div></div></section>
    <section class="panel capability-table-panel"><div class="panel-header"><div><h2>现有订单接入清单</h2><span>只展示真实业务状态，审批状态统一标记为未接入。</span></div></div><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>订单号</th><th>往来单位</th><th>类型</th><th>金额</th><th>审批状态</th><th>当前角色</th></tr></thead><tbody>${orderRows || `<tr><td colspan="6">暂无订单</td></tr>`}</tbody></table></div></section>`;
}

function inventoryPreviewRows() {
  const rows = new Map();
  state.data.orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      const name = String(item.description || "未命名商品").trim();
      const key = `${name}\0${order.currency}`;
      const row = rows.get(key) || { name, currency: order.currency, incoming: 0, outgoing: 0, plannedIncoming: 0, plannedOutgoing: 0, amountCents: 0 };
      const quantity = Number(item.quantity || 0);
      const total = Number(item.lineTotalCents || 0);
      if (order.fulfillmentStatus === "fulfilled") {
        if (order.direction === "payable") { row.incoming += quantity; row.amountCents += total; }
        else row.outgoing += quantity;
      } else if (order.fulfillmentStatus === "planned") {
        if (order.direction === "payable") row.plannedIncoming += quantity;
        else row.plannedOutgoing += quantity;
      }
      rows.set(key, row);
    });
  });
  const search = state.inventorySearch.trim().toLowerCase();
  return [...rows.values()].filter((row) => !search || row.name.toLowerCase().includes(search)).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function renderInventoryView({ restoreSearchFocus = false } = {}) {
  const view = byId("view-inventory");
  if (!view || !state.data) return;
  const rows = inventoryPreviewRows();
  const fulfilled = state.data.orders.filter((order) => order.fulfillmentStatus === "fulfilled");
  const inbound = fulfilled.filter((order) => order.direction === "payable").length;
  const outbound = fulfilled.filter((order) => order.direction === "receivable").length;
  const planned = state.data.orders.filter((order) => order.fulfillmentStatus === "planned").length;
  const tableRows = rows.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong></td><td>${escapeHtml(row.currency)}</td><td class="amount-cell green-text">${row.incoming}</td><td class="amount-cell blue-text">${row.outgoing}</td><td class="amount-cell">${row.incoming - row.outgoing}</td><td class="amount-cell">${row.plannedIncoming}</td><td class="amount-cell">${row.plannedOutgoing}</td><td class="amount-cell">${formatMoney(row.amountCents, row.currency)}</td></tr>`).join("");
  view.innerHTML = `<div class="view-heading"><div><p class="eyebrow">INVENTORY PREVIEW</p><h1>仓储管理</h1><p>先用真实订单交收数据预览商品流向，正式库存台账接入后再提供盘点、调拨和成本。</p></div><div class="heading-actions"><button class="outline-button" data-view="orders">${icon("notebook-tabs")}查看订单</button><button class="primary-button" data-action="show-capability" data-capability="inventory-ledger">${icon("warehouse")}接入库存台账</button></div></div>
    ${capabilityStatusMarkup({ iconName: "package-search", title: "当前为订单交收数量预览，不等于实际库存", message: "系统可确认交货或收货并自动记账，但尚无仓库、仓位、批次、盘点和安全库存数据。下表仅按订单商品明细汇总流入流出，不作为发货依据。", tone: "warning" })}
    <div class="capability-kpi-grid"><div><span>已确认收货</span><strong>${inbound}</strong><small>采购方向订单</small></div><div><span>已确认交货</span><strong>${outbound}</strong><small>销售方向订单</small></div><div><span>待确认交收</span><strong>${planned}</strong><small>可从订单页面处理</small></div><div><span>真实库存余额</span><strong>--</strong><small>库存台账未接入</small></div></div>
    <section class="panel capability-table-panel"><div class="panel-header"><div><h2>商品流向预览</h2><span>净流入 = 已收货数量 - 已交货数量，金额按币种分开。</span></div><div class="search-box compact-search">${icon("search")}<input id="inventorySearch" value="${escapeAttr(state.inventorySearch)}" aria-label="搜索商品" placeholder="搜索商品" /></div></div><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>商品</th><th>币种</th><th>已收货</th><th>已交货</th><th>净流入</th><th>在途采购</th><th>待交销售</th><th>采购金额</th></tr></thead><tbody>${tableRows || `<tr><td colspan="8">${state.inventorySearch ? "没有匹配商品" : "订单尚无商品明细"}</td></tr>`}</tbody></table></div></section>`;
  if (restoreSearchFocus) window.requestAnimationFrame(() => { const input = byId("inventorySearch"); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } });
}

function renderAutomationView() {
  const view = byId("view-automation");
  if (!view || !state.data) return;
  const rules = [
    ["销售交货", "应收账款增加，同时确认主营业务收入", "1122 → 5001", "已启用", "settled"],
    ["采购收货", "库存商品增加，同时形成应付账款", "1405 → 2202", "已启用", "settled"],
    ["客户收款", "银行存款增加，同时核销应收账款", "1002 → 1122", "已启用", "settled"],
    ["供应商付款", "核销应付账款，同时减少银行存款", "2202 → 1002", "已启用", "settled"],
    ["付款冲销", "生成反向分录，原付款记录永久保留", "反向追加", "已启用", "settled"],
    ["费用 / 工资 / 税费", "需要业务单据、科目和审批模板", "待配置", "待接入", "draft"]
  ];
  view.innerHTML = `<div class="view-heading"><div><p class="eyebrow">AUTOMATION RULES</p><h1>自动化规则</h1><p>普通用户只录业务，系统按已审定规则自动形成财务结果。</p></div><div class="heading-actions"><button class="primary-button" data-action="show-capability" data-capability="rule-editor">${icon("settings-2")}规则配置计划</button></div></div>
    ${capabilityStatusMarkup({ iconName: "workflow", title: "5 条基础记账规则已真实运行，在线编辑器尚未开放", message: "现有规则与服务器代码一致，覆盖当前销售、采购和收付款流程；修改会影响后续所有凭证。商业版将要求财务权限、二次确认、版本记录和审批后才可生效。", tone: "ready" })}
    <section class="panel rule-table-panel"><div class="panel-header"><div><h2>自动记账规则</h2><span>用经营语言解释结果，科目映射供财务复核；费用、工资、税费等规则尚未接入。</span></div><span class="status-badge settled">当前模板</span></div><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>业务触发</th><th>系统会做什么</th><th>科目映射</th><th>状态</th></tr></thead><tbody>${rules.map(([name, description, mapping, status, statusClass]) => `<tr><td><strong>${name}</strong></td><td>${description}</td><td><code>${mapping}</code></td><td><span class="status-badge ${statusClass}">${status}</span></td></tr>`).join("")}</tbody></table></div></section>
    <div class="settings-grid automation-config-grid"><section class="panel"><div class="panel-header"><div><h2>审批流程</h2><span>金额、业务类型、部门和项目</span></div><span class="status-badge draft">待接入</span></div><div class="setting-list"><div class="setting-row"><div><strong>采购付款审批</strong><span>建议负责人确认后由财务执行</span></div><button class="outline-button small-button" data-view="approvals">查看模板</button></div><div class="setting-row"><div><strong>赊销信用检查</strong><span>超额度或逾期客户需要负责人确认</span></div><button class="outline-button small-button" data-view="approvals">查看模板</button></div></div></section><section class="panel"><div class="panel-header"><div><h2>系统接口</h2><span>外部仓储、OCR、短信和税务</span></div><span class="status-badge draft">待配置</span></div><div class="setting-list"><div class="setting-row"><div><strong>仓储同步</strong><span>同步方向、频率、映射和失败重试</span></div><button class="outline-button small-button" data-view="inventory">查看状态</button></div><div class="setting-row"><div><strong>原始凭证</strong><span>对象存储、OCR 和附件安全扫描</span></div><button class="outline-button small-button" data-view="evidence">查看状态</button></div></div></section></div>`;
}

function partnerKindLabel(kind) {
  return kind === "customer" ? "客户" : kind === "supplier" ? "供应商" : "客户 / 供应商";
}

function contactBalanceEntries(partner) {
  return partner.balances.flatMap((balance) => [
    ...(balance.receivableCents > 0 ? [{ direction: "receivable", currency: balance.currency, cents: balance.receivableCents }] : []),
    ...(balance.payableCents > 0 ? [{ direction: "payable", currency: balance.currency, cents: balance.payableCents }] : [])
  ]);
}

function compactContactBalances(partner) {
  const entries = contactBalanceEntries(partner);
  if (!entries.length) return `<span class="contact-zero-balance">暂无未结余额</span>`;
  return `<span class="contact-balance-stack">${entries.slice(0, 2).map((entry) => `<span><em>${entry.direction === "receivable" ? "应收" : "应付"}</em>${moneyMarkup(entry.cents, entry.currency)}</span>`).join("")}${entries.length > 2 ? `<small>另有 ${entries.length - 2} 项</small>` : ""}</span>`;
}

function filteredContactPartners() {
  const search = state.contactSearch.trim().toLocaleLowerCase();
  return state.data.partners.filter((partner) => {
    const kindMatches = state.contactKind === "all" || partner.kind === state.contactKind || partner.kind === "both";
    const searchMatches = !search || `${partner.name} ${partner.contactName} ${partner.phone}`.toLocaleLowerCase().includes(search);
    return kindMatches && searchMatches;
  });
}

function recentPartnerOrders(partnerId) {
  return state.data.orders
    .filter((order) => order.partnerId === partnerId)
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.createdAt || left.orderDate) || 0;
      const rightTime = Date.parse(right.updatedAt || right.createdAt || right.orderDate) || 0;
      return rightTime - leftTime;
    })
    .slice(0, 5);
}

function contactDetailMarkup(partner) {
  if (!partner) return `<div class="contact-detail-empty">${emptyState("选择左侧单位查看详情", "contact")}</div>`;
  const balances = partner.balances.filter((balance) => balance.receivableCents > 0 || balance.payableCents > 0);
  const orders = recentPartnerOrders(partner.id);
  return `<div class="contact-detail-heading">
      <button class="icon-button mobile-only" type="button" data-action="contact-back" aria-label="返回往来单位列表">${icon("arrow-left")}</button>
      <span class="mini-avatar contact-detail-avatar">${escapeHtml(initial(partner.name, "客"))}</span>
      <div><h2 id="contactDetailHeading" tabindex="-1" dir="auto">${escapeHtml(partner.name)}</h2><span>${escapeHtml(partnerKindLabel(partner.kind))} · ${orders.length} 笔订单</span></div>
      ${roleCan(state.data.role, "partner") ? `<button class="outline-button small-button" data-action="edit-partner" data-partner-id="${escapeAttr(partner.id)}">${icon("pencil", 14)}编辑</button>` : ""}
    </div>
    <div class="contact-detail-section">
      <div class="contact-section-title"><h3>基础信息</h3></div>
      <dl class="contact-info-grid"><div><dt>联系人</dt><dd dir="auto">${escapeHtml(partner.contactName || "未填写")}</dd></div><div><dt>联系电话</dt><dd dir="auto">${escapeHtml(partner.phone || "未填写")}</dd></div></dl>
    </div>
    <div class="contact-detail-section">
      <div class="contact-section-title"><h3>当前余额</h3><span>不同币种独立展示</span></div>
      ${balances.length ? `<div class="contact-balance-table"><div class="contact-balance-head"><span>币种</span><span>应收</span><span>应付</span></div>${balances.map((balance) => `<div class="contact-balance-row"><strong>${escapeHtml(balance.currency)}</strong><span class="receivable-value">${balance.receivableCents ? moneyMarkup(balance.receivableCents, balance.currency) : "-"}</span><span class="payable-value">${balance.payableCents ? moneyMarkup(balance.payableCents, balance.currency) : "-"}</span></div>`).join("")}</div>` : emptyState("暂无未结余额", "circle-check")}
    </div>
    <div class="contact-detail-section contact-orders-section">
      <div class="contact-section-title"><h3>最近订单</h3><button class="text-button" data-view="orders">查看全部</button></div>
      <div class="contact-order-list">${orders.length ? orders.map((order) => `<div class="contact-order-row" role="button" tabindex="0" data-order-id="${escapeAttr(order.id)}" aria-label="查看订单 ${escapeAttr(order.orderNo)}"><div><strong dir="auto">${escapeHtml(order.orderNo)}</strong><span>${escapeHtml(formatDate(order.orderDate))} · ${order.direction === "receivable" ? "客户应收" : "供应商应付"}</span></div><div><strong>${moneyMarkup(order.outstandingCents, order.currency)}</strong>${statusBadge(order)}</div>${icon("chevron-right", 16)}</div>`).join("") : emptyState("该单位还没有订单", "file-text")}</div>
    </div>`;
}

function renderContactsView({ restoreSearchFocus = false } = {}) {
  const partners = filteredContactPartners();
  if (!partners.some((partner) => partner.id === state.selectedPartnerId)) state.selectedPartnerId = partners[0]?.id || "";
  const selectedPartner = partners.find((partner) => partner.id === state.selectedPartnerId) || null;
  byId("view-contacts").innerHTML = `<div class="view-heading"><div><p class="eyebrow">PARTNERS</p><h1>客户 / 供应商</h1><p>查找往来单位，分币种查看余额和最近订单。</p></div><div class="heading-actions">${roleCan(state.data.role,"partner") ? `<button class="primary-button" data-action="new-partner">${icon("user-plus")}新增往来单位</button>` : ""}</div></div>
    <div class="contact-workspace ${state.contactDetailOpen ? "mobile-detail-open" : ""}">
      <section class="contact-master" aria-label="往来单位列表">
        <div class="contact-toolbar"><div class="search-box">${icon("search")}<input id="contactSearch" aria-label="搜索客户或供应商" value="${escapeAttr(state.contactSearch)}" placeholder="搜索名称、联系人或电话" /></div><div class="filter-row contact-kind-filter">${[["all","全部"],["customer","客户"],["supplier","供应商"]].map(([value,label]) => `<button class="filter-pill ${state.contactKind === value ? "active" : ""}" type="button" data-contact-kind="${value}" aria-pressed="${state.contactKind === value}">${label}</button>`).join("")}</div></div>
        <div class="contact-list" role="listbox" aria-label="往来单位">${partners.length ? partners.map((partner) => `<div class="contact-list-row ${partner.id === state.selectedPartnerId ? "active" : ""}" role="option" tabindex="0" aria-selected="${partner.id === state.selectedPartnerId}" data-contact-select="${escapeAttr(partner.id)}"><span class="mini-avatar">${escapeHtml(initial(partner.name,"客"))}</span><span class="contact-list-copy"><strong dir="auto">${escapeHtml(partner.name)}</strong><small dir="auto">${escapeHtml(partnerKindLabel(partner.kind))} · ${escapeHtml(partner.contactName || partner.phone || "未填写联系人")}</small></span>${compactContactBalances(partner)}${icon("chevron-right",15)}</div>`).join("") : emptyState("没有符合条件的往来单位", "search-x")}</div>
      </section>
      <aside class="contact-detail-pane" aria-label="往来单位详情">${contactDetailMarkup(selectedPartner)}</aside>
    </div>`;
  refreshIcons();
  if (restoreSearchFocus) window.requestAnimationFrame(() => {
    const input = byId("contactSearch");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function selectContact(partnerId) {
  if (!state.data.partners.some((partner) => partner.id === partnerId)) return;
  state.selectedPartnerId = partnerId;
  state.contactDetailOpen = true;
  renderContactsView();
  if (window.matchMedia("(max-width: 900px)").matches) window.requestAnimationFrame(() => byId("contactDetailHeading")?.focus());
}

function renderRemindersView() {
  const reminders = state.data.reminders;
  const groups = { overdue: [], today: [], upcoming: [], later: [] };
  reminders.forEach((reminder) => groups[dueBucket(reminder.dueAt)].push(reminder));
  const reminderMarkup = (reminder, bucket) => {
    const order = state.data.orders.find((item) => item.id === reminder.orderId);
    const direction = reminder.direction === "receivable" ? "应收" : "应付";
    const overdueDays = bucket === "overdue"
      ? Math.abs(daysBetweenDateInputs(tenantDate(new Date()), tenantDate(reminder.dueAt)))
      : 0;
    return `<div class="reminder-item" data-order-id="${escapeAttr(reminder.orderId)}"><span class="reminder-icon ${bucket === "overdue" ? "" : "warn"}">${icon(bucket === "overdue" ? "alarm-clock" : "clock-3",16)}</span><div class="reminder-copy"><div class="reminder-title" dir="auto">${escapeHtml(reminder.partnerName)} · ${escapeHtml(reminder.orderNo)}</div><div class="reminder-detail"><span class="direction-label ${reminder.direction}">${direction}</span>${moneyMarkup(reminder.outstandingCents, order?.currency || "CNY")} · 到期 ${escapeHtml(formatDate(reminder.dueAt))}${bucket === "overdue" ? ` · <strong class="overdue-text">已逾期 ${overdueDays} 天</strong>` : ""}</div></div><div class="reminder-actions"><button class="reminder-primary" data-action="view-detail" data-order-id="${escapeAttr(reminder.orderId)}">查看订单</button>${roleCan(state.data.role,"payment") ? `<button class="reminder-payment-action" data-action="open-payment" data-order-id="${escapeAttr(reminder.orderId)}">登记${reminder.direction === "receivable" ? "收款" : "付款"}</button>` : ""}${roleCan(state.data.role,"reminder") ? `<button data-action="open-snooze" data-reminder-id="${escapeAttr(reminder.id)}">明天提醒</button><button data-action="ack-reminder" data-reminder-id="${escapeAttr(reminder.id)}">确认已处理</button>` : ""}</div></div>`;
  };
  const groupConfigs = [
    ["overdue", "已逾期", "超过到期日，优先核对并处理"],
    ["today", "今日到期", "今天需要完成确认"],
    ["upcoming", "未来 7 天", "即将进入结算节点"],
    ["later", "其他待处理", "已进入提醒队列"]
  ];
  const sections = groupConfigs.filter(([key]) => groups[key].length).map(([key, label, description]) => `<section class="reminder-group ${key}"><div class="panel-header"><div><h2>${label}</h2><span>${description}</span></div><b>${groups[key].length}</b></div><div class="reminder-list">${groups[key].map((reminder) => reminderMarkup(reminder, key)).join("")}</div></section>`).join("");
  byId("view-reminders").innerHTML = `<div class="view-heading"><div><p class="eyebrow">REMINDER CENTER</p><h1>提醒中心</h1><p>按到期时间处理应收与应付，结清后提醒自动关闭。</p></div><div class="heading-actions"><button class="outline-button" data-action="pending-notifications">${icon("radio")}外部通知待接入</button></div></div><div class="reminder-grid"><div class="reminder-stat overdue"><span>已逾期</span><strong class="danger-text">${groups.overdue.length}</strong></div><div class="reminder-stat"><span>今日到期</span><strong>${groups.today.length}</strong></div><div class="reminder-stat"><span>未来 7 天</span><strong>${groups.upcoming.length}</strong></div></div><div class="reminder-groups">${sections || `<section class="reminder-group cleared">${emptyState("当前没有待处理提醒", "circle-check")}</section>`}</div>`;
}

const importFieldDefinitions = [
  ["partnerName", "客户 / 供应商名称", true, "用于匹配或新建往来单位"],
  ["orderNo", "订单号", true, "必须在当前企业内唯一"],
  ["direction", "应收 / 应付方向", false, "也可由“客户名称”或“供应商名称”表头推断"],
  ["orderDate", "订货日期", true, "支持 2026-07-25 等常见日期格式"],
  ["plannedDeliveryDate", "计划交货日期", false, "留空时导入后可人工补充"],
  ["settlementMonths", "账期月数", false, "留空按 0 个月处理"],
  ["currency", "币种", false, "留空按 CNY 处理"],
  ["itemDescription", "商品名称", true, "每一行生成一笔订单和一条商品明细"],
  ["quantity", "数量", true, "必须为正整数"],
  ["unitPrice", "单价", true, "最多保留两位小数"]
];

function importWorkflowMarkup() {
  const preview = state.importPreview;
  const result = state.importResult;
  const details = [
    state.importInspection?.accepted ? "文件已就绪" : "选择本地文件",
    preview ? `${Object.keys(state.importMapping).length} 个字段已匹配` : "等待读取表头",
    preview ? `${preview.validRowCount} 行有效 · ${preview.invalidRowCount} 行异常` : "尚未开始",
    preview ? `${state.importSelectedRows.length} 行待导入` : "尚未开始",
    result?.batch ? `已导入 ${result.batch.importedCount} 笔` : "尚未开始"
  ];
  const labels = ["上传文件", "字段匹配", "数据校验", "预览确认", "导入结果"];
  return `<ol class="workflow-steps" aria-label="数据导入步骤">${labels.map((label, index) => {
    const className = index < state.importStage ? "complete" : index === state.importStage ? "active" : "locked";
    const marker = index < state.importStage ? icon("check", 14) : String(index + 1);
    return `<li class="workflow-step ${className}" ${index === state.importStage ? 'aria-current="step"' : ""}><span class="workflow-step-index">${marker}</span><span><strong>${label}</strong><small>${escapeHtml(details[index])}</small></span></li>`;
  }).join("")}</ol>`;
}

function localFileInspectionMarkup(inspection) {
  if (!inspection) return "";
  return `<div class="local-file-status ${inspection.accepted ? "valid" : "invalid"}" role="status">${icon(inspection.accepted ? "file-check-2" : "file-warning", 20)}<div><strong dir="auto">${escapeHtml(inspection.name || "未选择文件")}</strong><span>${inspection.extension ? `${escapeHtml(inspection.extension.toUpperCase())} · ${escapeHtml(inspection.sizeLabel)}` : escapeHtml(inspection.sizeLabel)} · ${escapeHtml(inspection.message)}</span></div></div>`;
}

function importErrorMarkup() {
  if (!state.importError) return "";
  return `<div class="import-error" role="alert">${icon("circle-alert", 18)}<div><strong>本次操作未完成</strong><span>${escapeHtml(state.importError)}</span></div></div>`;
}

function importUploadMarkup() {
  const selected = Boolean(state.importInspection?.accepted);
  const reading = state.importStatus === "reading";
  const busy = state.importStatus !== "idle";
  const canImport = roleCan(state.data.role, "createOrder");
  return `<div class="import-grid tool-workspace">
    <section class="local-file-panel" data-local-drop="import">
      <input id="importFileInput" class="local-file-input" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-local-file="import" />
      <div class="upload-zone ${selected ? "compact" : ""}">${icon(busy ? "loader-circle" : selected ? "file-spreadsheet" : "upload-cloud", 30)}<h2>${reading ? "正在安全读取文件" : state.importStatus === "previewing" ? "正在解析表格" : selected ? "文件已准备好" : "拖入 Excel 或 CSV 文件"}</h2><p>${selected ? "更换文件会清空当前导入步骤。" : "支持 CSV、XLSX，单个文件不超过 10 MB，最多 1000 行。"}</p><button class="outline-button" type="button" data-action="choose-import-file" ${busy ? "disabled" : ""}>${icon("folder-open", 16)}${selected ? "更换文件" : "选择文件"}</button></div>
      ${localFileInspectionMarkup(state.importInspection)}
      <div class="local-only-note">${icon("shield-check", 16)}<span><strong>人工确认后才写入账本</strong>文件会发送到当前企业的服务器做安全解析；预览和字段匹配阶段不会生成订单。</span></div>
    </section>
    <aside class="tool-side-panel">
      <div class="tool-panel-heading"><span class="integration-tag import-ready-tag">安全解析已启用</span><h2>导入前检查</h2><p>系统会拦截公式、宏和异常压缩文件，并检查重复订单号。每一行生成一笔待交货订单。</p></div>
      <div class="template-list"><div class="template-field"><strong>订单信息</strong><span>订单号、方向、日期、币种</span></div><div class="template-field"><strong>往来单位</strong><span>名称，可自动创建</span></div><div class="template-field"><strong>结算信息</strong><span>交货日期、账期</span></div><div class="template-field"><strong>商品明细</strong><span>说明、数量、单价</span></div></div>
      ${canImport ? `<div class="import-security-note">${icon("database-zap", 18)}<div><strong>不会自动确认交货</strong><span>导入后的订单状态为“待交货”，实际到货后再进入结算提醒。</span></div></div>` : `<div class="import-security-note important">${icon("shield-alert", 18)}<div><strong>当前账号为只读权限</strong><span>请联系负责人、财务或业务成员执行导入。</span></div></div>`}
      <button class="outline-button wide import-template-action" type="button" data-action="download-import-template">${icon("download", 16)}下载标准 CSV 模板</button>
      <button class="primary-button wide" type="button" data-action="start-import-preview" ${!canImport || !state.importContentBase64 || busy ? "disabled" : ""}>${state.importStatus === "previewing" ? icon("loader-circle", 16) + "正在解析" : "下一步：字段匹配" + icon("arrow-right", 16)}</button>
    </aside>
  </div>`;
}

function importMappingMarkup() {
  const preview = state.importPreview;
  const headers = Array.isArray(preview?.headers) ? preview.headers : [];
  const suggestionByField = new Map((preview?.suggestions || []).map((suggestion) => [suggestion.field, suggestion]));
  return `<section class="import-stage-panel">
    <div class="import-stage-heading"><div><span class="integration-tag import-ready-tag">${escapeHtml((preview?.format || "").toUpperCase())}${preview?.encoding ? ` · ${escapeHtml(preview.encoding.toUpperCase())}` : ""}</span><h2>确认字段匹配</h2><p>左侧是系统标准字段，右侧选择商家表格中的对应列。带“必填”的字段不能缺少。</p></div><div class="file-chip">${icon("file-spreadsheet", 16)}<span dir="auto">${escapeHtml(state.importInspection?.name || "")}</span></div></div>
    <div class="mapping-grid" role="group" aria-label="导入字段匹配">${importFieldDefinitions.map(([field, label, required, hint]) => {
      const selectedColumn = Number(state.importMapping[field] || 0);
      const suggestion = suggestionByField.get(field);
      return `<label class="mapping-row"><span class="mapping-label"><strong>${escapeHtml(label)}${required ? '<em>必填</em>' : ""}</strong><small>${escapeHtml(hint)}</small></span><span class="mapping-control"><select data-import-mapping="${escapeAttr(field)}" aria-label="${escapeAttr(label)}对应列" ${state.importStatus !== "idle" ? "disabled" : ""}><option value="0">${required ? "请选择表格列" : "未匹配"}</option>${headers.map((header, index) => `<option value="${index + 1}" ${selectedColumn === index + 1 ? "selected" : ""}>第 ${index + 1} 列 · ${escapeHtml(header)}</option>`).join("")}</select>${suggestion && suggestion.columnNumber === selectedColumn ? `<small>${suggestion.confidence === "exact" ? "表头完全匹配" : "按常用别名匹配"}</small>` : ""}</span></label>`;
    }).join("")}</div>
    <div class="import-stage-actions"><button class="outline-button" type="button" data-action="import-back-upload" ${state.importStatus !== "idle" ? "disabled" : ""}>${icon("arrow-left", 16)}返回上传</button><button class="primary-button" type="button" data-action="validate-import-mapping" ${state.importStatus !== "idle" ? "disabled" : ""}>${state.importStatus === "previewing" ? icon("loader-circle", 16) + "正在校验" : "校验数据" + icon("arrow-right", 16)}</button></div>
  </section>`;
}

function importValidationMarkup() {
  const preview = state.importPreview;
  const invalidRows = (preview?.rows || []).filter((row) => !row.valid);
  return `<section class="import-stage-panel">
    <div class="import-stage-heading"><div><span class="integration-tag import-ready-tag">校验完成</span><h2>核对数据质量</h2><p>异常行不会被导入。请返回修改原文件或字段匹配后重新校验。</p></div></div>
    <div class="import-summary-grid"><div><span>数据总行数</span><strong>${preview.rows.length}</strong></div><div class="valid"><span>可以导入</span><strong>${preview.validRowCount}</strong></div><div class="invalid"><span>异常行</span><strong>${preview.invalidRowCount}</strong></div></div>
    ${invalidRows.length ? `<div class="import-issue-list"><div class="contact-section-title"><h3>需要处理的问题</h3><span>${invalidRows.length} 行</span></div>${invalidRows.map((row) => `<div class="import-issue-row"><span>第 ${row.rowNumber} 行</span><div>${row.errors.map((error) => `<p><strong>${error.field ? escapeHtml(importFieldDefinitions.find(([field]) => field === error.field)?.[1] || error.field) : "文件内容"}</strong>${escapeHtml(error.message)}</p>`).join("")}</div></div>`).join("")}</div>` : `<div class="import-clean-state">${icon("badge-check", 28)}<div><strong>全部数据通过校验</strong><span>进入预览后仍需人工确认，系统不会在此步骤写入订单。</span></div></div>`}
    <div class="import-stage-actions"><button class="outline-button" type="button" data-action="import-back-mapping">${icon("arrow-left", 16)}返回字段匹配</button><button class="primary-button" type="button" data-action="open-import-preview" ${preview.validRowCount < 1 ? "disabled" : ""}>预览 ${preview.validRowCount} 行有效数据${icon("arrow-right", 16)}</button></div>
  </section>`;
}

function importPreviewMarkup() {
  const preview = state.importPreview;
  const validRows = preview.rows.filter((row) => row.valid);
  const selected = new Set(state.importSelectedRows);
  const allSelected = validRows.length > 0 && validRows.every((row) => selected.has(row.rowNumber));
  return `<section class="import-stage-panel">
    <div class="import-stage-heading"><div><span class="integration-tag import-ready-tag">写入前最后确认</span><h2>选择要导入的订单</h2><p>取消勾选可暂不导入该行。异常行已自动排除，提交后会记录导入批次和审计日志。</p></div><div class="selection-count"><strong id="importSelectionCount">${selected.size}</strong><span>行已选择</span></div></div>
    <div class="data-table-wrap import-preview-table"><table class="data-table"><thead><tr><th class="checkbox-cell"><input id="importSelectAll" type="checkbox" data-import-select-all aria-label="选择全部有效行" ${allSelected ? "checked" : ""} ${state.importStatus === "committing" ? "disabled" : ""} /></th><th>原表行</th><th>订单 / 往来单位</th><th>方向</th><th>订货 / 交货</th><th>商品</th><th>数量</th><th>单价</th><th>金额</th></tr></thead><tbody>${validRows.map((row) => `<tr><td class="checkbox-cell" data-label="选择"><input type="checkbox" data-import-row="${row.rowNumber}" aria-label="选择第 ${row.rowNumber} 行" ${selected.has(row.rowNumber) ? "checked" : ""} ${state.importStatus === "committing" ? "disabled" : ""} /></td><td data-label="原表行">${row.rowNumber}</td><td data-label="订单 / 往来单位"><strong dir="auto">${escapeHtml(row.values.orderNo)}</strong><small dir="auto">${escapeHtml(row.values.partnerName)}</small></td><td data-label="方向"><span class="direction-label ${row.values.direction}">${row.values.direction === "receivable" ? "应收" : "应付"}</span></td><td data-label="订货 / 交货"><strong>${escapeHtml(row.values.orderDate)}</strong><small>${row.values.plannedDeliveryDate ? escapeHtml(row.values.plannedDeliveryDate) : "未填写交货日"}</small></td><td data-label="商品" dir="auto">${escapeHtml(row.values.itemDescription)}</td><td data-label="数量">${row.values.quantity}</td><td class="amount-cell" data-label="单价">${moneyMarkup(row.values.unitPriceCents, row.values.currency)}</td><td class="amount-cell" data-label="金额"><strong>${moneyMarkup(row.values.lineTotalCents, row.values.currency)}</strong></td></tr>`).join("")}</tbody></table></div>
    ${preview.invalidRowCount ? `<div class="import-skip-note">${icon("info", 16)}${preview.invalidRowCount} 个异常行不会写入账本</div>` : ""}
    <div class="import-stage-actions"><button class="outline-button" type="button" data-action="import-back-validation" ${state.importStatus === "committing" ? "disabled" : ""}>${icon("arrow-left", 16)}返回校验结果</button><button id="commitImportButton" class="primary-button" type="button" data-action="commit-import" ${selected.size < 1 || state.importStatus === "committing" ? "disabled" : ""}>${state.importStatus === "committing" ? icon("loader-circle", 16) : icon("database-zap", 16)}<span id="commitImportButtonText">${state.importStatus === "committing" ? "正在导入" : `确认导入 ${selected.size} 笔订单`}</span></button></div>
  </section>`;
}

function importResultMarkup() {
  const result = state.importResult;
  const batch = result?.batch;
  if (!batch) return "";
  const orders = Array.isArray(batch.orders) ? batch.orders : [];
  return `<section class="import-result-panel">
    <div class="import-result-hero">${icon("circle-check-big", 42)}<div><span>导入完成</span><h2>${batch.importedCount} 笔订单已进入待交货</h2><p>批次号 ${escapeHtml(batch.id)} · ${escapeHtml(formatDate(batch.createdAt, { time: true }))}${result.idempotentReplay ? " · 本次为安全重试，未重复写入" : ""}</p></div></div>
    <div class="import-result-meta"><div><span>源文件</span><strong dir="auto">${escapeHtml(batch.fileName)}</strong></div><div><span>成功导入</span><strong>${batch.importedCount} 笔</strong></div><div><span>跳过异常</span><strong>${Number(result.skippedInvalidCount || 0)} 行</strong></div></div>
    <div class="import-result-orders"><div class="contact-section-title"><h3>已生成订单</h3><span>${orders.length} 笔</span></div>${orders.slice(0, 50).map((order) => `<button type="button" data-action="view-detail" data-order-id="${escapeAttr(order.id)}"><span dir="auto">${escapeHtml(order.orderNo)}</span>${icon("arrow-up-right", 15)}</button>`).join("")}${orders.length > 50 ? `<p>这里只显示前 50 笔，可在全部订单中查看完整结果。</p>` : ""}</div>
    <div class="import-stage-actions"><button class="outline-button" type="button" data-action="reset-import">${icon("file-plus-2", 16)}继续导入文件</button><button class="primary-button" type="button" data-action="view-imported-orders">查看全部订单${icon("arrow-right", 16)}</button></div>
  </section>`;
}

function renderImportView() {
  const content = state.importStage === 0
    ? importUploadMarkup()
    : state.importStage === 1
      ? importMappingMarkup()
      : state.importStage === 2
        ? importValidationMarkup()
        : state.importStage === 3
          ? importPreviewMarkup()
          : importResultMarkup();
  byId("view-imports").innerHTML = `<div class="view-heading"><div><p class="eyebrow">EXCEL IMPORT</p><h1>导入数据</h1><p>上传商家表格，确认字段和异常行后批量生成待交货订单。</p></div><span class="integration-tag import-ready-tag">CSV / XLSX 已启用</span></div>${importWorkflowMarkup()}${importErrorMarkup()}${content}`;
  const selectAll = byId("importSelectAll");
  if (selectAll && state.importPreview) {
    const validCount = state.importPreview.validRowCount;
    selectAll.indeterminate = state.importSelectedRows.length > 0 && state.importSelectedRows.length < validCount;
  }
  refreshIcons();
}

function resetImportWorkflow() {
  state.importInspection = null;
  state.importContentBase64 = "";
  state.importReadVersion += 1;
  state.importStage = 0;
  state.importStatus = "idle";
  state.importError = "";
  state.importPreview = null;
  state.importMapping = {};
  state.importSelectedRows = [];
  state.importResult = null;
  state.importIdempotencyKey = "";
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 32 * 1024;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return window.btoa(binary);
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("文件读取失败，请重新选择"));
    reader.onload = () => reader.result instanceof ArrayBuffer
      ? resolve(reader.result)
      : reject(new Error("文件内容无法读取"));
    reader.readAsArrayBuffer(file);
  });
}

async function prepareImportFile(file, inspection) {
  const readVersion = ++state.importReadVersion;
  state.importInspection = inspection;
  state.importContentBase64 = "";
  state.importStage = 0;
  state.importStatus = inspection.accepted ? "reading" : "idle";
  state.importError = "";
  state.importPreview = null;
  state.importMapping = {};
  state.importSelectedRows = [];
  state.importResult = null;
  state.importIdempotencyKey = "";
  renderImportView();
  if (!inspection.accepted) return;
  try {
    const buffer = await readFileAsArrayBuffer(file);
    if (readVersion !== state.importReadVersion) return;
    state.importContentBase64 = arrayBufferToBase64(buffer);
    state.importInspection = { ...inspection, message: "文件已读取，等待上传解析" };
  } catch (error) {
    if (readVersion !== state.importReadVersion) return;
    state.importInspection = { ...inspection, accepted: false, message: error.message || "文件读取失败" };
    state.importError = error.message || "文件读取失败，请重新选择";
  } finally {
    if (readVersion === state.importReadVersion) {
      state.importStatus = "idle";
      renderImportView();
    }
  }
}

function importRequestBody(mapping = undefined) {
  const body = {
    fileName: state.importInspection?.name || "",
    contentBase64: state.importContentBase64
  };
  if (mapping && Object.keys(mapping).length) body.mapping = mapping;
  return body;
}

async function requestImportPreview(nextStage, mapping = undefined) {
  if (!state.importContentBase64 || state.importStatus !== "idle") return;
  const requestVersion = state.importReadVersion;
  state.importStatus = "previewing";
  state.importError = "";
  renderImportView();
  try {
    const payload = await apiRequest("/api/order-imports/preview", {
      method: "POST",
      body: importRequestBody(mapping),
      busyText: "正在安全解析导入文件"
    });
    if (requestVersion !== state.importReadVersion) return;
    const preview = payload?.preview;
    if (!preview || !Array.isArray(preview.headers) || !Array.isArray(preview.rows)) {
      throw new Error("服务器返回的预览数据不完整，请稍后重试");
    }
    state.importPreview = preview;
    state.importMapping = { ...(preview.mapping || {}) };
    state.importSelectedRows = preview.rows.filter((row) => row.valid).map((row) => Number(row.rowNumber));
    state.importStage = nextStage;
    state.importIdempotencyKey = "";
  } catch (error) {
    if (requestVersion !== state.importReadVersion) return;
    state.importError = error.message || "导入文件解析失败";
  } finally {
    if (requestVersion === state.importReadVersion) {
      state.importStatus = "idle";
      renderImportView();
    }
  }
}

async function validateImportMapping() {
  const missing = importFieldDefinitions
    .filter(([, , required]) => required)
    .filter(([field]) => !Number.isInteger(Number(state.importMapping[field])) || Number(state.importMapping[field]) < 1)
    .map(([, label]) => label);
  if (missing.length) {
    state.importError = `请先匹配必填字段：${missing.join("、")}`;
    renderImportView();
    return;
  }
  await requestImportPreview(2, state.importMapping);
}

function makeImportIdempotencyKey() {
  const random = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `web-order-import-${random}`.slice(0, 128);
}

async function commitOrderImport() {
  if (state.importStatus !== "idle" || !state.importSelectedRows.length) return;
  state.importStatus = "committing";
  state.importError = "";
  state.importIdempotencyKey ||= makeImportIdempotencyKey();
  renderImportView();
  let payload;
  try {
    payload = await apiRequest("/api/order-imports/commit", {
      method: "POST",
      body: {
        ...importRequestBody(state.importMapping),
        rowNumbers: [...state.importSelectedRows].sort((left, right) => left - right)
      },
      headers: { "Idempotency-Key": state.importIdempotencyKey },
      busyText: "正在写入导入订单"
    });
  } catch (error) {
    state.importStatus = "idle";
    state.importError = error.message || "订单导入失败";
    renderImportView();
    return;
  }

  state.importStatus = "idle";
  state.importResult = {
    ...payload,
    skippedInvalidCount: payload.skippedInvalidCount ?? state.importPreview?.invalidRowCount ?? 0
  };
  state.importStage = 4;
  renderImportView();
  try {
    await loadBootstrap();
    showToast(`已成功导入 ${payload.batch?.importedCount || 0} 笔订单`);
  } catch (error) {
    showToast(`订单已导入，但账本刷新失败：${error.message}`, "error");
    renderImportView();
  }
}

function updateImportSelectionControls() {
  const selectedCount = state.importSelectedRows.length;
  const validCount = state.importPreview?.validRowCount || 0;
  const count = byId("importSelectionCount");
  const button = byId("commitImportButton");
  const buttonText = byId("commitImportButtonText");
  const selectAll = byId("importSelectAll");
  if (count) count.textContent = selectedCount;
  if (button) button.disabled = selectedCount < 1;
  if (buttonText) buttonText.textContent = `确认导入 ${selectedCount} 笔订单`;
  if (selectAll) {
    selectAll.checked = validCount > 0 && selectedCount === validCount;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < validCount;
  }
}

function downloadImportTemplate() {
  const headers = ["客户/供应商名称", "订单号", "方向", "订货日期", "计划交货日期", "账期月数", "币种", "商品", "数量", "单价"];
  const blob = new Blob([`\uFEFF${headers.join(",")}\r\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "思燕智能财务-订单导入模板.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("标准 CSV 模板已下载");
}

function renderOcrView() {
  const inspection = state.ocrInspection;
  const hasPreview = Boolean(state.ocrPreviewDataUrl);
  const previewMarkup = state.ocrPreviewLoading
    ? `<div class="ocr-preview-empty">${icon("loader-circle", 28)}<strong>正在本地读取图片</strong><span>不会上传到服务器</span></div>`
    : hasPreview
      ? `<img id="ocrLocalPreview" alt="本地选择的纸质单据预览" />`
      : `<div class="ocr-preview-empty">${icon("image-up", 30)}<strong>选择纸单图片</strong><span>支持 JPG、PNG、WebP，单张不超过 10 MB</span></div>`;
  byId("view-ocr").innerHTML = `<div class="view-heading"><div><p class="eyebrow">PAPER ORDER OCR</p><h1>纸单识别</h1><p>本地预览原始单据；识别、坐标高亮和保存等待真实 OCR 服务。</p></div><span class="integration-tag">OCR 服务待接入</span></div>
    <div class="ocr-layout tool-workspace">
      <section class="ocr-preview-panel" data-local-drop="ocr">
        <input id="ocrFileInput" class="local-file-input" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" data-local-file="ocr" />
        <div class="tool-panel-bar"><div><strong>原始单据</strong><span>图片仅保留在当前页面内存</span></div><button class="outline-button small-button" type="button" data-action="choose-ocr-file">${icon("image-plus", 15)}${inspection ? "更换图片" : "选择图片"}</button></div>
        <div class="ocr-preview ${hasPreview ? "has-image" : ""}">${previewMarkup}</div>
        ${localFileInspectionMarkup(inspection)}
        <div class="local-only-note">${icon("scan-line", 16)}<span><strong>当前不绘制识别框</strong>没有 OCR 坐标数据时，不会伪造字段高亮区域。</span></div>
      </section>
      <section class="ocr-fields">
        <div class="ocr-fields-header"><div><span class="integration-tag">等待服务</span><h2>识别字段与商品明细</h2><p>服务返回真实结果后，低置信度字段才会标记为需要确认。</p></div></div>
        <fieldset class="ocr-disabled-fields" disabled aria-label="等待 OCR 服务的识别字段">
          <div class="ocr-form"><label>客户 / 供应商<input value="" placeholder="等待识别" /></label><label>订单编号<input value="" placeholder="等待识别" /></label><label>订货日期<input value="" placeholder="等待识别" /></label><label>币种<input value="" placeholder="等待识别" /></label><label class="full">备注<textarea rows="2" placeholder="等待识别"></textarea></label></div>
          <div class="ocr-items-block"><div class="contact-section-title"><h3>商品明细</h3><span>0 项</span></div><div class="ocr-empty-items">${icon("list-plus", 22)}<span>识别服务返回商品行后在此校对</span></div></div>
        </fieldset>
        <div class="confidence-legend" aria-label="识别置信度说明"><span><i class="confidence-dot high"></i>识别清晰</span><span><i class="confidence-dot review"></i>需要确认</span><span><i class="confidence-dot missing"></i>未识别</span></div>
        <div class="ocr-action-bar">${roleCan(state.data.role, "createOrder") ? `<button class="outline-button" type="button" data-action="ocr-manual-order">${icon("square-pen", 16)}转人工新建订单</button>` : `<button class="outline-button" type="button" disabled>当前角色不可新建订单</button>`}<button class="primary-button" type="button" disabled title="OCR 服务尚未接入">${icon("save", 16)}保存识别结果</button></div>
      </section>
    </div>`;
  const preview = byId("ocrLocalPreview");
  if (preview && state.ocrPreviewDataUrl) preview.src = state.ocrPreviewDataUrl;
  refreshIcons();
}

function handleLocalFile(file, purpose) {
  const inspection = validateLocalFile(file, purpose);
  if (purpose === "import") {
    void prepareImportFile(file, inspection);
    return;
  }

  const readVersion = ++state.ocrReadVersion;
  state.ocrInspection = inspection;
  state.ocrPreviewDataUrl = "";
  state.ocrPreviewLoading = inspection.accepted;
  renderOcrView();
  if (!inspection.accepted) return;

  const failRead = (message) => {
    if (readVersion !== state.ocrReadVersion) return;
    state.ocrInspection = { ...inspection, accepted: false, message };
    state.ocrPreviewDataUrl = "";
    state.ocrPreviewLoading = false;
    renderOcrView();
  };
  const reader = new FileReader();
  reader.onerror = () => failRead("图片读取失败，请重新选择");
  reader.onload = () => {
    if (readVersion !== state.ocrReadVersion || typeof reader.result !== "string" || !/^data:image\/(?:jpeg|png|webp);base64,/i.test(reader.result)) return failRead("图片格式无法安全预览");
    const image = new Image();
    image.onerror = () => failRead("图片内容损坏或无法解码");
    image.onload = () => {
      if (readVersion !== state.ocrReadVersion) return;
      state.ocrPreviewDataUrl = reader.result;
      state.ocrPreviewLoading = false;
      renderOcrView();
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function defaultNotificationPreference() {
  return {
    enabled: false,
    sendLocalTime: "09:00",
    advanceDays: 7,
    overdueDaily: true,
    receivableEnabled: true,
    payableEnabled: true,
    version: 0
  };
}

function safeMaskedPhone(value) {
  const text = typeof value === "string" ? value.trim().slice(0, 40) : "";
  if (!text) return "未绑定手机号";
  const digitCount = (text.match(/\d/g) || []).length;
  return digitCount >= 7 && /^\+?[\d\s()-]+$/.test(text) ? "已绑定手机号" : text;
}

function normalizeNotificationSettings(payload) {
  const defaults = defaultNotificationPreference();
  const preference = payload?.preference || {};
  const sendLocalTime = typeof preference.sendLocalTime === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(preference.sendLocalTime)
    ? preference.sendLocalTime
    : defaults.sendLocalTime;
  const advanceDays = Number.isInteger(preference.advanceDays) && preference.advanceDays >= 0 && preference.advanceDays <= 365
    ? preference.advanceDays
    : defaults.advanceDays;
  const version = Number.isInteger(preference.version) && preference.version >= 0 ? preference.version : defaults.version;
  return {
    eligible: payload?.eligible === true,
    phoneMasked: safeMaskedPhone(payload?.phoneMasked),
    phoneVerified: payload?.phoneVerified === true,
    preference: {
      enabled: preference.enabled === true,
      sendLocalTime,
      advanceDays,
      overdueDaily: preference.overdueDaily !== false,
      receivableEnabled: preference.receivableEnabled !== false,
      payableEnabled: preference.payableEnabled !== false,
      version
    }
  };
}

function notificationPreferenceDraft(preference) {
  return { ...preference, advanceDays: String(preference.advanceDays) };
}

function canManageNotificationSettings() {
  return state.data && (state.data.role === "owner" || state.data.role === "finance");
}

function notificationSettingsPanelMarkup() {
  if (!canManageNotificationSettings()) return "";
  if (state.notificationSettingsStatus === "idle" || state.notificationSettingsStatus === "loading") {
    return `<section class="notification-settings-panel" aria-labelledby="notificationSettingsTitle"><div class="panel-header"><div><h2 id="notificationSettingsTitle">结算提醒</h2><span>每天汇总待结算与逾期订单</span></div></div><div class="notification-settings-state" role="status">${icon("loader-circle", 22)}<span>正在读取提醒设置</span></div></section>`;
  }
  if (state.notificationSettingsStatus === "error" || !state.notificationSettings) {
    return `<section class="notification-settings-panel" aria-labelledby="notificationSettingsTitle"><div class="panel-header"><div><h2 id="notificationSettingsTitle">结算提醒</h2><span>每天汇总待结算与逾期订单</span></div></div><div class="notification-settings-state error" role="alert">${icon("circle-alert", 22)}<span>${escapeHtml(state.notificationSettingsError || "提醒设置读取失败")}</span><button class="outline-button small-button" type="button" data-action="refresh-notification-settings">重试</button></div></section>`;
  }

  const settings = state.notificationSettings;
  const draft = state.notificationPreferenceDraft || notificationPreferenceDraft(settings.preference);
  const saving = state.notificationSettingsSaveStatus === "saving";
  const enabled = settings.phoneVerified && draft.enabled === true;
  const enableDisabled = saving || !settings.eligible || !settings.phoneVerified;
  const feedbackMessage = saving
    ? "正在保存提醒设置"
    : state.notificationSettingsSaveStatus === "success"
      ? "提醒设置已保存"
      : state.notificationSettingsSaveStatus === "error"
        ? state.notificationSettingsSaveError || "提醒设置保存失败"
        : "";
  const feedbackRole = state.notificationSettingsSaveStatus === "error" ? "alert" : "status";
  const verificationNote = settings.phoneVerified
    ? `<div id="notificationVerificationNote" class="notification-verification verified">${icon("badge-check", 17)}<div><strong>接收号码已验证</strong><span dir="auto">${escapeHtml(settings.phoneMasked)}</span></div></div>`
    : `<div id="notificationVerificationNote" class="notification-verification warning" role="status">${icon("message-square-warning", 17)}<div><strong>手机号尚未验证</strong><span dir="auto">${escapeHtml(settings.phoneMasked)}</span><small>请先通过短信验证码登录完成验证，再开启提醒。</small></div></div>`;

  if (!settings.eligible) {
    return `<section class="notification-settings-panel" aria-labelledby="notificationSettingsTitle"><div class="panel-header"><div><h2 id="notificationSettingsTitle">结算提醒</h2><span>每天汇总待结算与逾期订单</span></div><span class="status-badge draft">暂不可用</span></div><div class="notification-settings-body">${verificationNote}<div class="notification-settings-state"><span>当前账号尚不具备短信提醒配置条件。</span></div></div></section>`;
  }

  return `<section class="notification-settings-panel" aria-labelledby="notificationSettingsTitle">
    <div class="panel-header"><div><h2 id="notificationSettingsTitle">结算提醒</h2><span>按企业时区每天发送一次应收、应付与逾期汇总</span></div><span class="status-badge ${enabled ? "settled" : "draft"}">${enabled ? "已启用" : "未启用"}</span></div>
    <div class="notification-settings-body">${verificationNote}
      <form id="notificationPreferencesForm" class="notification-preferences-form" aria-busy="${saving}">
        <fieldset ${saving ? "disabled" : ""}>
          <div class="notification-enable-row"><div><strong id="notificationEnabledLabel">每日结算提醒</strong><span id="notificationEnabledHint">未验证手机号时不能开启</span></div><label class="switch"><input id="notificationEnabled" type="checkbox" role="switch" aria-labelledby="notificationEnabledLabel" aria-describedby="notificationEnabledHint notificationVerificationNote" ${enabled ? "checked" : ""} ${enableDisabled ? "disabled" : ""} /><span aria-hidden="true"></span></label></div>
          <div class="notification-preference-grid"><label>发送时间<input id="notificationSendLocalTime" type="time" value="${escapeAttr(draft.sendLocalTime || "09:00")}" step="60" required /></label><label>提前提醒天数<input id="notificationAdvanceDays" type="number" value="${escapeAttr(draft.advanceDays)}" min="0" max="365" step="1" inputmode="numeric" required /></label></div>
          <div class="notification-preference-checks" role="group" aria-label="提醒范围"><label class="check-label"><input id="notificationReceivableEnabled" type="checkbox" ${draft.receivableEnabled ? "checked" : ""} />客户应收</label><label class="check-label"><input id="notificationPayableEnabled" type="checkbox" ${draft.payableEnabled ? "checked" : ""} />供应商应付</label><label class="check-label"><input id="notificationOverdueDaily" type="checkbox" ${draft.overdueDaily ? "checked" : ""} />逾期后每天提醒</label></div>
        </fieldset>
        <div class="notification-form-footer"><p id="notificationSettingsFeedback" class="notification-settings-feedback ${state.notificationSettingsSaveStatus === "error" ? "error" : ""} ${feedbackMessage ? "" : "hidden"}" role="${feedbackRole}" aria-live="${feedbackRole === "alert" ? "assertive" : "polite"}">${escapeHtml(feedbackMessage)}</p><button id="notificationSettingsSubmit" class="primary-button" type="submit" ${saving ? "disabled" : ""}>${icon(saving ? "loader-circle" : "save", 15)}${saving ? "正在保存" : "保存提醒设置"}</button></div>
      </form>
    </div>
  </section>`;
}

function captureNotificationPreferenceDraft(form) {
  state.notificationPreferenceDraft = {
    enabled: byId("notificationEnabled")?.checked === true,
    sendLocalTime: byId("notificationSendLocalTime")?.value || "",
    advanceDays: byId("notificationAdvanceDays")?.value ?? "",
    overdueDaily: byId("notificationOverdueDaily")?.checked === true,
    receivableEnabled: byId("notificationReceivableEnabled")?.checked === true,
    payableEnabled: byId("notificationPayableEnabled")?.checked === true,
    version: state.notificationSettings?.preference.version ?? 0
  };
  if (state.notificationSettingsSaveStatus !== "saving") {
    state.notificationSettingsSaveStatus = "idle";
    state.notificationSettingsSaveError = "";
    const feedback = form.querySelector("#notificationSettingsFeedback");
    if (feedback) {
      feedback.textContent = "";
      feedback.classList.add("hidden");
    }
  }
}

function renderSettingsView() {
  const { tenant, user, role } = state.data;
  const canReadAudit = role === "owner" || role === "finance";
  const canManageMembers = role === "owner";
  const notificationPanel = canReadAudit ? notificationSettingsPanelMarkup() : "";
  byId("view-settings").innerHTML = `<div class="view-heading"><div><p class="eyebrow">WORKSPACE SETTINGS</p><h1>工作区设置</h1><p>企业、成员和安全记录均以服务器数据为准。</p></div></div><div class="settings-grid"><section class="settings-list"><div class="setting-row"><div><strong>企业</strong><span dir="auto">${escapeHtml(tenant.name)}</span></div><span class="settings-value">${escapeHtml(tenant.timezone)}</span></div><div class="setting-row"><div><strong>当前成员</strong><span dir="auto">${escapeHtml(user.displayName)}</span></div><span class="status-badge pending">${escapeHtml(roleLabels[role])}</span></div><div class="setting-row"><div><strong>账号密码</strong><span>修改后撤销其他设备上的登录会话</span></div><button class="outline-button small-button" data-action="change-password">修改密码</button></div><div class="setting-row"><div><strong>会话安全</strong><span>优先同源 HttpOnly cookie；兼容令牌仅保存在页面内存</span></div>${icon("shield-check",20)}</div></section><section class="settings-list"><div class="setting-row"><div><strong>短信登录与提醒</strong><span>验证码登录已具备；主动提醒按真实服务验收启用</span></div><span class="integration-tag">分阶段启用</span></div><div class="setting-row"><div><strong>Excel 导入</strong><span>CSV / XLSX 安全解析、字段映射、校验和审计已启用</span></div><span class="integration-tag import-ready-tag">已启用</span></div><div class="setting-row"><div><strong>纸单 OCR</strong><span>等待阿里云 OCR 与对象存储服务开通</span></div><span class="integration-tag">待接入</span></div><div class="setting-row"><div><strong>退出登录</strong><span>撤销当前服务端会话并清除安全 cookie</span></div><button class="outline-button small-button" data-action="logout">安全退出</button></div></section></div>${notificationPanel}${canManageMembers ? memberPanelMarkup() : ""}${canReadAudit ? auditPanelMarkup() : ""}`;
  const notificationForm = byId("notificationPreferencesForm");
  if (notificationForm) {
    notificationForm.addEventListener("input", () => captureNotificationPreferenceDraft(notificationForm));
    notificationForm.addEventListener("change", () => captureNotificationPreferenceDraft(notificationForm));
    notificationForm.addEventListener("submit", saveNotificationSettings);
  }
}

async function loadNotificationSettings({ force = false } = {}) {
  if (!canManageNotificationSettings()) return;
  if (!force && (state.notificationSettingsStatus === "loading" || state.notificationSettingsStatus === "ready")) return;
  state.notificationSettingsStatus = "loading";
  state.notificationSettingsError = "";
  if (state.view === "settings") renderSettingsView();
  try {
    const payload = await apiRequest("/api/notification-settings/me", { busyText: "正在读取提醒设置" });
    state.notificationSettings = normalizeNotificationSettings(payload);
    state.notificationPreferenceDraft = notificationPreferenceDraft(state.notificationSettings.preference);
    state.notificationSettingsStatus = "ready";
    state.notificationSettingsSaveStatus = "idle";
    state.notificationSettingsSaveError = "";
  } catch (error) {
    state.notificationSettings = null;
    state.notificationPreferenceDraft = null;
    state.notificationSettingsStatus = "error";
    state.notificationSettingsError = error.message;
  }
  if (state.view === "settings") {
    renderSettingsView();
    refreshIcons();
  }
}

async function saveNotificationSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!state.notificationSettings || !state.notificationSettings.eligible || state.notificationSettingsSaveStatus === "saving") return;
  captureNotificationPreferenceDraft(form);
  if (!form.reportValidity()) return;
  const draft = state.notificationPreferenceDraft;
  const advanceDays = Number(draft.advanceDays);
  if (!Number.isInteger(advanceDays) || advanceDays < 0 || advanceDays > 365) return;
  const body = {
    enabled: state.notificationSettings.phoneVerified && draft.enabled === true,
    sendLocalTime: draft.sendLocalTime || "09:00",
    advanceDays,
    overdueDaily: draft.overdueDaily === true,
    receivableEnabled: draft.receivableEnabled === true,
    payableEnabled: draft.payableEnabled === true,
    version: state.notificationSettings.preference.version
  };
  state.notificationSettingsSaveStatus = "saving";
  state.notificationSettingsSaveError = "";
  renderSettingsView();
  refreshIcons();
  try {
    const payload = await apiRequest("/api/notification-settings/me", {
      method: "PUT",
      body,
      busyText: "正在保存提醒设置"
    });
    const mergedPayload = payload?.preference
      ? {
          eligible: payload.eligible ?? state.notificationSettings.eligible,
          phoneMasked: payload.phoneMasked ?? state.notificationSettings.phoneMasked,
          phoneVerified: payload.phoneVerified ?? state.notificationSettings.phoneVerified,
          preference: payload.preference
        }
      : await apiRequest("/api/notification-settings/me", { busyText: "正在确认提醒设置" });
    state.notificationSettings = normalizeNotificationSettings(mergedPayload);
    state.notificationPreferenceDraft = notificationPreferenceDraft(state.notificationSettings.preference);
    state.notificationSettingsStatus = "ready";
    state.notificationSettingsSaveStatus = "success";
    showToast("提醒设置已保存", "success");
  } catch (error) {
    state.notificationSettingsSaveStatus = "error";
    state.notificationSettingsSaveError = error.message;
  }
  if (state.view === "settings") {
    renderSettingsView();
    refreshIcons();
    window.requestAnimationFrame(() => byId("notificationSettingsSubmit")?.focus());
  }
}

function memberStatus(member) {
  if (member.active) return ["已启用", "settled"];
  if (member.status === "invited") return ["待接受邀请", "pending"];
  if (member.status === "invitation_expired") return ["邀请已过期", "overdue"];
  return ["已停用", "draft"];
}

function memberPanelMarkup() {
  let content;
  if (state.membersStatus === "loading") {
    content = `<div class="audit-empty">${icon("loader-circle", 22)}<span>正在读取成员</span></div>`;
  } else if (state.membersStatus === "error") {
    content = `<div class="audit-empty error">${icon("circle-alert", 22)}<span>${escapeHtml(state.membersError || "成员读取失败")}</span><button class="outline-button small-button" data-action="refresh-members">重试</button></div>`;
  } else if (!state.members.length) {
    content = `<div class="audit-empty">${icon("users", 22)}<span>暂无成员记录</span></div>`;
  } else {
    content = `<div class="member-list">${state.members.map((member) => {
      const [statusLabel, statusClass] = memberStatus(member);
      const isCurrent = member.id === state.data.user.id;
      const needsInvitation = member.status === "invited" || member.status === "invitation_expired";
      const action = needsInvitation
        ? `<button class="outline-button small-button" data-action="reinvite-member" data-member-id="${escapeAttr(member.id)}">重新生成邀请</button>`
        : `<button class="outline-button small-button" data-action="toggle-member" data-member-id="${escapeAttr(member.id)}" data-active="${member.active ? "false" : "true"}">${member.active ? "停用" : "恢复"}</button>`;
      return `<div class="member-row"><span class="mini-avatar">${escapeHtml(initial(member.displayName, "员"))}</span><div class="member-copy"><strong dir="auto">${escapeHtml(member.displayName)}${isCurrent ? '<em>当前账号</em>' : ""}</strong><span dir="auto">${escapeHtml(member.phone)}</span></div><span class="status-badge ${statusClass}">${statusLabel}</span><label class="member-role"><span class="sr-only">${escapeHtml(member.displayName)}的角色</span><select data-member-role="${escapeAttr(member.id)}" aria-label="${escapeAttr(member.displayName)}的角色">${Object.entries(roleLabels).map(([value, label]) => `<option value="${value}" ${member.role === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label><div class="member-action">${action}</div></div>`;
    }).join("")}</div>`;
  }
  const invitation = state.invitationUrl
    ? `<div class="invitation-result" role="status"><div>${icon("link-2", 18)}<div><strong>邀请链接已生成，只显示这一次</strong><span>有效期至 ${escapeHtml(formatDate(state.invitationExpiresAt, { time: true }))}；重新生成后旧链接立即失效。</span></div></div><div class="invitation-link-row"><input id="generatedInvitationUrl" readonly value="${escapeAttr(state.invitationUrl)}" aria-label="一次性成员邀请链接" /><button class="outline-button" data-action="copy-invitation-link">${icon("copy", 15)}复制</button></div><button class="text-button" data-action="dismiss-invitation-link">我已保存，关闭提示</button></div>`
    : "";
  return `<section class="member-panel"><div class="panel-header"><div><h2>企业成员与权限</h2><span>负责人可邀请、分配角色和停用账号</span></div><button class="primary-button small-button" data-action="invite-member">${icon("user-plus", 14)}邀请成员</button></div>${invitation}${content}</section>`;
}

function rememberInvitation(invitation) {
  const token = typeof invitation?.token === "string" ? invitation.token : "";
  if (!token) throw new Error("服务器未返回一次性邀请链接");
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set("invite", token);
  state.invitationUrl = url.toString();
  state.invitationExpiresAt = typeof invitation.expiresAt === "string" ? invitation.expiresAt : "";
}

async function loadMembers({ force = false } = {}) {
  if (!state.data || state.data.role !== "owner") return;
  if (!force && (state.membersStatus === "loading" || state.membersStatus === "ready")) return;
  state.membersStatus = "loading";
  state.membersError = "";
  if (state.view === "settings") renderSettingsView();
  try {
    const payload = await apiRequest("/api/members", { busyText: "正在读取企业成员" });
    state.members = Array.isArray(payload.members) ? payload.members : [];
    state.membersStatus = "ready";
  } catch (error) {
    state.members = [];
    state.membersStatus = "error";
    state.membersError = error.message;
  }
  if (state.view === "settings") {
    renderSettingsView();
    refreshIcons();
  }
}

function openMemberModal() {
  byId("memberForm").reset();
  byId("memberRole").value = "finance";
  openModal("memberModal");
}

async function submitMember(event) {
  event.preventDefault();
  setModalBusy("memberModal", true);
  try {
    const payload = await apiRequest("/api/members", {
      method: "POST",
      busyText: "正在生成成员邀请",
      body: {
        displayName: byId("memberDisplayName").value.trim(),
        phone: byId("memberPhone").value.trim(),
        role: byId("memberRole").value
      }
    });
    rememberInvitation(payload.invitation);
    await loadMembers({ force: true });
    closeModal("memberModal", { force: true });
    showToast("成员邀请已生成", "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setModalBusy("memberModal", false);
  }
}

async function changeMemberRole(memberId, role, selectElement) {
  selectElement.disabled = true;
  try {
    await apiRequest(`/api/members/${encodeURIComponent(memberId)}/role`, {
      method: "PATCH",
      busyText: "正在修改成员角色",
      body: { role }
    });
    await loadMembers({ force: true });
    state.auditStatus = "idle";
    showToast("成员角色已更新", "success");
  } catch (error) {
    await loadMembers({ force: true });
    showToast(error.message, "error");
  } finally {
    selectElement.disabled = false;
  }
}

async function toggleMember(memberId, active, button) {
  button.disabled = true;
  try {
    await apiRequest(`/api/members/${encodeURIComponent(memberId)}/status`, {
      method: "PATCH",
      busyText: active ? "正在恢复成员" : "正在停用成员",
      body: { active }
    });
    await loadMembers({ force: true });
    state.auditStatus = "idle";
    showToast(active ? "成员已恢复" : "成员已停用", "success");
  } catch (error) {
    showToast(error.message, "error");
    button.disabled = false;
  }
}

async function reinviteMember(memberId, button) {
  button.disabled = true;
  try {
    const payload = await apiRequest(`/api/members/${encodeURIComponent(memberId)}/reinvite`, {
      method: "POST",
      busyText: "正在重新生成邀请"
    });
    rememberInvitation(payload.invitation);
    await loadMembers({ force: true });
    state.auditStatus = "idle";
    showToast("新邀请已生成，旧链接已失效", "success");
  } catch (error) {
    showToast(error.message, "error");
    button.disabled = false;
  }
}

async function copyInvitationLink() {
  if (!state.invitationUrl) return;
  try {
    await navigator.clipboard.writeText(state.invitationUrl);
    showToast("邀请链接已复制", "success");
  } catch {
    const input = byId("generatedInvitationUrl");
    input?.focus();
    input?.select();
    showToast("无法自动复制，链接已选中", "error");
  }
}

const auditActionLabels = {
  "auth.login": ["登录账号", "log-in"],
  "auth.logout": ["退出账号", "log-out"],
  "auth.password_changed": ["修改密码", "key-round"],
  "partner.created": ["新增往来单位", "user-plus"],
  "partner.updated": ["修改往来单位", "contact-round"],
  "order.created": ["新建订单", "file-plus-2"],
  "order.corrected": ["更正订单", "history"],
  "order.cancelled": ["取消订单", "ban"],
  "order.fulfilled": ["确认交货", "package-check"],
  "payment.created": ["登记收付款", "wallet-cards"],
  "payment.reversed": ["冲销收付款", "undo-2"],
  "reminder.created": ["生成账期提醒", "bell-plus"],
  "reminder.closed": ["结清并关闭提醒", "bell-off"],
  "reminder.acknowledged": ["确认已处理提醒", "check-check"],
  "reminder.snoozed": ["暂缓提醒", "clock-3"],
  "member.invited": ["邀请成员", "user-plus"],
  "member.reinvited": ["重新签发邀请", "send"],
  "member.invitation_accepted": ["成员接受邀请", "user-check"],
  "member.role_changed": ["修改成员角色", "shield"],
  "member.deactivated": ["停用成员", "user-x"],
  "member.reactivated": ["恢复成员", "user-check"]
};

function auditDetail(entry) {
  const metadata = entry?.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
  const details = [];
  const orderId = typeof metadata.orderId === "string"
    ? metadata.orderId
    : entry.entityType === "order" ? entry.entityId : "";
  const order = state.data.orders.find((item) => item.id === orderId);
  if (typeof metadata.orderNo === "string") details.push(`订单 ${metadata.orderNo}`);
  if (Number.isSafeInteger(Number(metadata.amountCents))) {
    details.push(order
      ? formatMoney(Number(metadata.amountCents), order.currency)
      : `金额 ${(Number(metadata.amountCents) / 100).toFixed(2)}`);
  }
  if (typeof metadata.reason === "string") details.push(metadata.reason);
  if (typeof metadata.dueAt === "string") details.push(`到期 ${formatDate(metadata.dueAt)}`);
  if (typeof metadata.nextReminderAt === "string") details.push(`下次 ${formatDate(metadata.nextReminderAt, { time: true })}`);
  if (Number.isInteger(metadata.revokedSessions)) details.push(`撤销 ${metadata.revokedSessions} 个其他会话`);
  return details.slice(0, 2).join(" · ");
}

function auditPanelMarkup() {
  let content;
  if (state.auditStatus === "loading") {
    content = `<div class="audit-empty">${icon("loader-circle", 22)}<span>正在读取安全记录</span></div>`;
  } else if (state.auditStatus === "error") {
    content = `<div class="audit-empty error">${icon("circle-alert", 22)}<span>${escapeHtml(state.auditError || "审计记录读取失败")}</span><button class="outline-button small-button" data-action="refresh-audit">重试</button></div>`;
  } else if (!state.auditEntries.length) {
    content = `<div class="audit-empty">${icon("history", 22)}<span>暂无操作记录</span></div>`;
  } else {
    content = `<div class="audit-list">${state.auditEntries.map((entry) => {
      const [label, iconName] = auditActionLabels[entry.action] || ["系统操作", "activity"];
      const detail = auditDetail(entry);
      return `<div class="audit-row"><span class="audit-icon">${icon(iconName, 16)}</span><div class="audit-copy"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(entry.actorName || "系统")} · ${escapeHtml(formatDate(entry.createdAt, { time: true }))}</span>${detail ? `<small dir="auto">${escapeHtml(detail)}</small>` : ""}</div><span class="audit-entity">${escapeHtml(entry.entityType || "record")}</span></div>`;
    }).join("")}</div>`;
  }
  return `<section class="audit-panel"><div class="panel-header"><div><h2>安全与审计记录</h2><span>最近 100 条关键操作，只允许负责人和财务查看</span></div><button class="outline-button small-button" data-action="refresh-audit" ${state.auditStatus === "loading" ? "disabled" : ""}>${icon("refresh-cw", 14)}刷新</button></div>${content}</section>`;
}

async function loadAudit({ force = false } = {}) {
  if (!state.data || !(state.data.role === "owner" || state.data.role === "finance")) return;
  if (!force && (state.auditStatus === "loading" || state.auditStatus === "ready")) return;
  state.auditStatus = "loading";
  state.auditError = "";
  if (state.view === "settings") renderSettingsView();
  try {
    const payload = await apiRequest("/api/audit?limit=100", { busyText: "正在读取审计记录" });
    state.auditEntries = Array.isArray(payload.audit) ? payload.audit : [];
    state.auditStatus = "ready";
  } catch (error) {
    state.auditEntries = [];
    state.auditStatus = "error";
    state.auditError = error.message;
  }
  if (state.view === "settings") {
    renderSettingsView();
    refreshIcons();
  }
}

function financeAccessDeniedMarkup(title) {
  return `<div class="view-heading"><div><p class="eyebrow">FINANCE</p><h1>${escapeHtml(title)}</h1><p>经营与财务数据按角色隔离。</p></div></div><section class="permission-state">${icon("shield-lock", 30)}<strong>当前角色无权查看财务账簿</strong><p>业务人员可以录入订单和确认交收；负责人、财务及只读成员可查看财务结果。</p><button class="outline-button" data-view="overview">返回经营工作台</button></section>`;
}

function renderChecksView() {
  const view = byId("view-checks");
  if (!view || !state.data) return;
  if (!roleCan(state.data.role, "readAccounting")) {
    view.innerHTML = financeAccessDeniedMarkup("智能检查");
    return;
  }
  view.innerHTML = `<div class="view-heading"><div><p class="eyebrow">SMART CHECKS</p><h1>凭证查询与智能检查</h1><p>自动发现借贷、来源、金额和外币风险，只提示或阻断，不会静默修改数据。</p></div><div class="heading-actions"><button class="outline-button" data-action="refresh-smart-checks">${icon("refresh-cw")}重新检查</button></div></div>
    <section class="integrity-principle">${icon("shield-check",20)}<div><strong>原始数据保护已开启</strong><span>检查结果必须由有权限人员确认；任何更正都通过冲销、受控更正或重新生成处理。</span></div></section>
    <div class="check-filter-row" role="group" aria-label="风险筛选"><button class="filter-pill active" data-check-filter="all">全部</button><button class="filter-pill" data-check-filter="high">高风险</button><button class="filter-pill" data-check-filter="medium">需关注</button><button class="filter-pill" data-check-filter="unavailable">待接入检查</button><button class="filter-pill" data-check-filter="passed">已通过</button></div>
    <div id="smartCheckResults" class="smart-check-results">${accountingLoadingMarkup("正在运行只读检查")}</div>`;
}

function smartCheckTone(check) {
  return check.risk === "high" ? ["高风险", "overdue", "octagon-alert"]
    : check.risk === "medium" ? ["需关注", "partial", "triangle-alert"]
      : check.risk === "unavailable" ? ["待接入", "draft", "plug-zap"]
        : ["已通过", "settled", "circle-check"];
}

function renderSmartCheckResults() {
  const target = byId("smartCheckResults");
  if (!target) return;
  const filtered = state.smartChecks.filter((check) => state.smartCheckFilter === "all" || check.risk === state.smartCheckFilter);
  const counts = state.smartChecks.reduce((result, check) => ({ ...result, [check.risk]: (result[check.risk] || 0) + 1 }), {});
  const summary = `<div class="risk-summary-grid"><div><span>高风险</span><strong class="red-text">${counts.high || 0}</strong></div><div><span>需关注</span><strong class="amber-text">${counts.medium || 0}</strong></div><div><span>待接入检查</span><strong>${counts.unavailable || 0}</strong></div><div><span>已通过</span><strong class="green-text">${counts.passed || 0}</strong></div></div>`;
  const rows = filtered.map((check) => {
    const [label, badge, iconName] = smartCheckTone(check);
    return `<article class="risk-check-row ${check.risk}"><span class="risk-check-icon">${icon(iconName,18)}</span><div><div class="risk-check-title"><strong>${escapeHtml(check.title)}</strong><span class="status-badge ${badge}">${label}</span></div><p>${escapeHtml(check.detail)}</p><small>${escapeHtml(check.suggestion)}</small></div>${check.view ? `<button class="outline-button small-button" data-view="${check.view}">查看</button>` : ""}</article>`;
  }).join("");
  target.innerHTML = `${summary}<section class="panel risk-check-list">${rows || `<div class="audit-empty">${icon("search-x",22)}<span>当前筛选没有检查项</span></div>`}</section><p class="check-source-note">数据来源：订单、商品明细、已生成凭证和科目余额 · 生成时间 ${escapeHtml(formatDate(new Date(), { time: true }))} · 最后操作人：系统只读检查</p>`;
  document.querySelectorAll("[data-check-filter]").forEach((button) => button.classList.toggle("active", button.dataset.checkFilter === state.smartCheckFilter));
  refreshIcons();
}

async function loadSmartChecks() {
  if (!roleCan(state.data?.role, "readAccounting")) return;
  const target = byId("smartCheckResults");
  if (!target) return;
  const requestVersion = ++state.financeRenderVersion;
  target.innerHTML = accountingLoadingMarkup("正在核对凭证、订单和科目余额");
  try {
    const fulfilledOrders = state.data.orders.filter((order) => order.fulfillmentStatus === "fulfilled");
    const foreignOrders = fulfilledOrders.filter((order) => order.currency !== "CNY");
    const [journalsPayload, balancePayload] = await Promise.all([
      apiRequest("/api/accounting/journals?limit=500", { busyText: "正在检查自动凭证" }),
      foreignOrders.length
        ? Promise.resolve({ balanced: null, unavailable: true })
        : apiRequest("/api/accounting/trial-balance", { busyText: "正在检查借贷平衡" })
    ]);
    if (requestVersion !== state.financeRenderVersion) return;
    const journals = Array.isArray(journalsPayload.journals) ? journalsPayload.journals : [];
    const unbalanced = journals.filter((journal) => {
      const lines = Array.isArray(journal.lines) ? journal.lines : [];
      return lines.reduce((sum, line) => sum + Number(line.debitCents || 0), 0) !== lines.reduce((sum, line) => sum + Number(line.creditCents || 0), 0);
    });
    const fulfillmentSources = new Set(journals.filter((journal) => journal.sourceType === "order.fulfillment").map((journal) => journal.sourceId));
    const missingJournals = fulfilledOrders.filter((order) => !fulfillmentSources.has(order.id));
    const orderNumbers = new Map();
    state.data.orders.forEach((order) => orderNumbers.set(order.orderNo, (orderNumbers.get(order.orderNo) || 0) + 1));
    const duplicateNumbers = [...orderNumbers.values()].filter((count) => count > 1).length;
    const mismatchedTotals = state.data.orders.filter((order) => (order.items || []).reduce((sum, item) => sum + Number(item.lineTotalCents || 0), 0) !== Number(order.totalCents || 0));
    const overdueOrders = state.data.orders.filter((order) => order.outstandingCents > 0 && dueBucket(order.dueAt) === "overdue");
    const balanceCheckRisk = foreignOrders.length ? "unavailable" : unbalanced.length || balancePayload.balanced !== true ? "high" : "passed";
    const balanceCheckDetail = foreignOrders.length
      ? "检测到外币业务，正式汇率折算前不运行跨币种科目余额混算"
      : unbalanced.length
        ? `${unbalanced.length} 张凭证借贷不平`
        : balancePayload.balanced === true
          ? `${journals.length} 张凭证及科目汇总借贷平衡`
          : "科目汇总存在借贷差额";
    state.smartChecks = [
      { risk: balanceCheckRisk, title: "凭证借贷平衡", detail: balanceCheckDetail, suggestion: foreignOrders.length ? "先完成汇率、本位币和汇兑差额配置" : balanceCheckRisk === "high" ? "停止结账并由财务逐张复核" : "无需处理，继续保留自动检查", view: "accounting" },
      { risk: missingJournals.length ? "high" : "passed", title: "交收与自动凭证完整性", detail: missingJournals.length ? `${missingJournals.length} 笔已交收订单未找到来源凭证` : `${fulfilledOrders.length} 笔已交收订单均找到自动凭证`, suggestion: missingJournals.length ? "核对交收事务和记账日志，不要手工补写原数据" : "订单到凭证链路完整", view: "orders" },
      { risk: mismatchedTotals.length ? "high" : "passed", title: "订单明细金额勾稽", detail: mismatchedTotals.length ? `${mismatchedTotals.length} 笔订单明细合计与订单总额不一致` : `${state.data.orders.length} 笔订单明细合计与总额一致`, suggestion: mismatchedTotals.length ? "使用受控更正并记录原因" : "服务端金额重算有效", view: "orders" },
      { risk: duplicateNumbers ? "medium" : "passed", title: "重复订单号", detail: duplicateNumbers ? `发现 ${duplicateNumbers} 组重复订单号` : "未发现重复订单号", suggestion: duplicateNumbers ? "核对是否重复录入，不要直接删除已流转订单" : "继续保持自动编号和重复校验", view: "orders" },
      { risk: foreignOrders.length ? "high" : "passed", title: "外币折算与本位币报表", detail: foreignOrders.length ? `${foreignOrders.length} 笔外币业务尚无正式汇率折算，不能并入 CNY 财务报表` : "当前已交收业务没有外币折算风险", suggestion: foreignOrders.length ? "商业使用前接入汇率、本位币金额和汇兑差额" : "新增外币业务时重新检查", view: "balances" },
      { risk: overdueOrders.length ? "medium" : "passed", title: "逾期应收应付", detail: overdueOrders.length ? `${overdueOrders.length} 笔账款已逾期未结` : "当前没有逾期未结账款", suggestion: overdueOrders.length ? "由负责人确认跟进人和下一次提醒" : "保持每日提醒检查", view: "reminders" },
      { risk: "unavailable", title: "原始凭证完整性", detail: "对象存储与订单附件绑定尚未接入，当前无法判断缺票、重复票号或金额不一致", suggestion: "接入 OSS、文件安全扫描和凭证版本后启用", view: "evidence" },
      { risk: "unavailable", title: "审批完整性", detail: "审批状态机尚未接入，当前无法验证付款前审批、会签或驳回记录", suggestion: "先配置简单审批模板，再将付款与过账设置为受控动作", view: "approvals" }
    ];
    renderSmartCheckResults();
  } catch (error) {
    if (requestVersion !== state.financeRenderVersion) return;
    target.innerHTML = `<div class="audit-empty error">${icon("circle-alert",22)}<span>${escapeHtml(error.message || "智能检查失败")}</span><button class="outline-button small-button" data-action="refresh-smart-checks">重试</button></div>`;
    refreshIcons();
  }
}

function renderBalancesView() {
  const view = byId("view-balances");
  if (!view || !state.data) return;
  if (!roleCan(state.data.role, "readAccounting")) {
    view.innerHTML = financeAccessDeniedMarkup("科目余额表");
    return;
  }
  const foreign = state.data.orders.filter((order) => order.currency !== "CNY" && order.fulfillmentStatus === "fulfilled").length;
  view.innerHTML = `<div class="view-heading"><div><p class="eyebrow">ACCOUNT BALANCES</p><h1>科目余额表</h1><p>由自动凭证汇总期初、本期借贷发生额和期末余额，可继续联查明细账。</p></div><div class="heading-actions"><button class="outline-button" data-action="refresh-balances">${icon("refresh-cw")}刷新余额</button></div></div>
    ${foreign ? capabilityStatusMarkup({ iconName: "circle-alert", title: `检测到 ${foreign} 笔外币业务，当前报表只展示 CNY 本位币账簿`, message: "原币、汇率、本位币折算和汇兑差额尚未完整接入。正式商业使用前，外币业务不会与人民币金额合并展示。", tone: "danger" }) : ""}
    <div id="balanceTableResult">${accountingLoadingMarkup("正在生成科目余额表")}</div>`;
}

async function loadBalanceTable() {
  if (!roleCan(state.data?.role, "readAccounting")) return;
  const target = byId("balanceTableResult");
  if (!target) return;
  const requestVersion = ++state.financeRenderVersion;
  target.innerHTML = accountingLoadingMarkup("正在生成科目余额表");
  const foreign = state.data.orders.filter((order) => order.currency !== "CNY" && order.fulfillmentStatus === "fulfilled").length;
  if (foreign) {
    target.innerHTML = `<section class="blocking-state">${icon("shield-alert",28)}<strong>已阻止生成可能错误的本位币余额表</strong><p>检测到 ${foreign} 笔已交收外币业务。汇率、本位币金额与汇兑差额接入前，系统不会把不同币种的最小单位直接相加。</p><button class="outline-button" data-view="checks">查看外币风险</button></section>`;
    refreshIcons();
    return;
  }
  try {
    const period = tenantDate(new Date()).slice(0, 7);
    const payload = await apiRequest(`/api/accounting/trial-balance?period=${encodeURIComponent(period)}`, { busyText: "正在读取科目余额" });
    if (requestVersion !== state.financeRenderVersion) return;
    const rows = (payload.accounts || []).map((account) => {
      const opening = account.normalSide === "credit" ? Number(account.openingCreditCents || 0) - Number(account.openingDebitCents || 0) : Number(account.openingDebitCents || 0) - Number(account.openingCreditCents || 0);
      const ending = Number(account.endingBalanceCents || 0);
      return `<tr><td><button class="table-link" type="button" data-action="open-account-ledger" data-account-code="${escapeAttr(account.code)}"><strong>${escapeHtml(account.code)}</strong></button></td><td>${escapeHtml(account.name)}</td><td>CNY</td><td>${account.normalSide === "credit" ? "贷" : "借"}</td><td class="amount-cell">${formatMoney(opening, "CNY")}</td><td class="amount-cell">${formatMoney(Number(account.periodDebitCents || 0), "CNY")}</td><td class="amount-cell">${formatMoney(Number(account.periodCreditCents || 0), "CNY")}</td><td class="amount-cell"><strong>${formatMoney(Math.abs(ending), "CNY")}</strong><small>${ending < 0 ? account.normalSide === "credit" ? "借方" : "贷方" : account.normalSide === "credit" ? "贷方" : "借方"}</small></td></tr>`;
    }).join("");
    target.innerHTML = `<section class="panel balance-table-panel"><div class="panel-header"><div><h2>${escapeHtml(period)} 科目余额</h2><span>数据来源：已生成凭证 · 生成规则：按科目和会计期间自动汇总</span></div><span class="status-badge ${payload.balanced ? "settled" : "overdue"}">${payload.balanced ? "借贷平衡" : "需要复核"}</span></div><div class="accounting-table-wrap"><table class="data-table finance-wide-table"><thead><tr><th>科目编码</th><th>科目名称</th><th>币种</th><th>余额方向</th><th>期初余额</th><th>本期借方</th><th>本期贷方</th><th>期末余额</th></tr></thead><tbody>${rows || `<tr><td colspan="8">暂无科目</td></tr>`}</tbody></table></div><div class="report-reconciliation ${payload.balanced ? "success" : "danger"}">${icon(payload.balanced ? "circle-check" : "triangle-alert",18)}<span>${payload.balanced ? "本期借方发生额与贷方发生额相等，可继续查看报表。" : `借贷差额 ${formatMoney(Number(payload.totals?.differenceCents || 0), "CNY")}，应停止结账并复核。`}</span></div></section>`;
    refreshIcons();
  } catch (error) {
    if (requestVersion !== state.financeRenderVersion) return;
    target.innerHTML = `<div class="audit-empty error">${icon("circle-alert",22)}<span>${escapeHtml(error.message || "科目余额读取失败")}</span><button class="outline-button small-button" data-action="refresh-balances">重试</button></div>`;
    refreshIcons();
  }
}

function renderAuxiliaryView() {
  const view = byId("view-auxiliary");
  if (!view || !state.data) return;
  if (!roleCan(state.data.role, "readAccounting")) {
    view.innerHTML = financeAccessDeniedMarkup("辅助明细账");
    return;
  }
  const rows = state.data.partners.map((partner) => {
    const orders = state.data.orders.filter((order) => order.partnerId === partner.id);
    const entries = contactBalanceEntries(partner);
    const receivables = entries.filter((entry) => entry.direction === "receivable");
    const payables = entries.filter((entry) => entry.direction === "payable");
    const grouped = (values) => values.length ? values.map((value) => moneyMarkup(value.cents, value.currency)).join("<br>") : "-";
    return `<tr><td><button class="table-link partner-link" type="button" data-action="open-aux-partner" data-partner-id="${escapeAttr(partner.id)}"><span class="mini-avatar">${escapeHtml(initial(partner.name, "往"))}</span><strong>${escapeHtml(partner.name)}</strong></button></td><td>${escapeHtml(partnerKindLabel(partner.kind))}</td><td>${orders.length}</td><td class="amount-cell green-text">${grouped(receivables)}</td><td class="amount-cell blue-text">${grouped(payables)}</td><td>${escapeHtml(partner.contactName || "-")}</td><td>${escapeHtml(partner.phone || "-")}</td></tr>`;
  }).join("");
  view.innerHTML = `<div class="view-heading"><div><p class="eyebrow">AUXILIARY LEDGER</p><h1>客户与供应商辅助明细</h1><p>由订单、收付款和自动凭证派生，无需重复登记；不同币种始终分开。</p></div><div class="heading-actions"><button class="outline-button" data-view="contacts">${icon("contact")}往来单位资料</button></div></div>
    <div class="auxiliary-dimensions" role="tablist" aria-label="辅助核算维度"><button class="filter-pill active" type="button">客户 / 供应商</button><button class="filter-pill" type="button" data-action="show-capability" data-capability="auxiliary-dimensions">部门</button><button class="filter-pill" type="button" data-action="show-capability" data-capability="auxiliary-dimensions">项目</button><button class="filter-pill" type="button" data-view="inventory">商品 / 仓库</button></div>
    <section class="panel auxiliary-table-panel"><div class="panel-header"><div><h2>往来余额与业务明细</h2><span>点击往来单位可下钻到订单和付款记录。</span></div><span class="status-badge settled">自动生成</span></div><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>往来单位</th><th>类型</th><th>订单数</th><th>应收余额</th><th>应付余额</th><th>联系人</th><th>电话</th></tr></thead><tbody>${rows || `<tr><td colspan="7">暂无往来单位</td></tr>`}</tbody></table></div></section>`;
}

const suiteReportLabels = {
  "balance-sheet": "资产负债表",
  "income-statement": "利润表",
  "cash-flow-statement": "现金流量表",
  aging: "应收应付账龄",
  "trial-balance": "试算平衡"
};

function renderReportsView() {
  const view = byId("view-reports");
  if (!view || !state.data) return;
  if (!roleCan(state.data.role, "readAccounting")) {
    view.innerHTML = financeAccessDeniedMarkup("财务报表");
    return;
  }
  view.innerHTML = `<div class="view-heading"><div><p class="eyebrow">FINANCIAL REPORTS</p><h1>财务报表</h1><p>全部基于已生成凭证自动计算，报表异常可继续下钻到科目和订单。</p></div><div class="heading-actions"><button class="outline-button" data-action="show-capability" data-capability="report-export">${icon("download")}导出设置</button></div></div>
    <div class="report-tabbar" role="tablist" aria-label="财务报表">${Object.entries(suiteReportLabels).map(([report, label]) => `<button type="button" role="tab" class="report-tab ${state.reportTab === report ? "active" : ""}" aria-selected="${state.reportTab === report}" data-action="load-suite-report" data-report="${report}">${label}</button>`).join("")}</div>
    <div id="suiteReportResult">${accountingLoadingMarkup("正在生成财务报表")}</div>`;
}

function suiteReportMeta(payload, rule) {
  return `<div class="generated-meta"><span>数据来源：已生成凭证</span><span>生成期间：${escapeHtml(payload.period || tenantDate(new Date()).slice(0,7))}</span><span>生成规则：${escapeHtml(rule)}</span><span>当前状态：只读结果</span></div>`;
}

function reportLinesTable(title, lines, valueKey = "balanceCents") {
  const rows = lines.map((line) => `<tr><td><button class="table-link" type="button" data-action="open-account-ledger" data-account-code="${escapeAttr(line.code)}">${escapeHtml(line.code)}</button></td><td>${escapeHtml(line.name)}</td><td class="amount-cell">${formatMoney(Number(line[valueKey] || 0), "CNY")}</td></tr>`).join("");
  return `<section class="report-statement-block"><h3>${title}</h3><table class="data-table compact-report-table"><thead><tr><th>科目</th><th>项目</th><th>本期金额</th></tr></thead><tbody>${rows || `<tr><td colspan="3">暂无发生额</td></tr>`}</tbody></table></section>`;
}

function renderSuiteReportPayload(report, payload) {
  const target = byId("suiteReportResult");
  if (!target) return;
  if (report === "balance-sheet") {
    const totals = payload.totals || {};
    target.innerHTML = `${suiteReportMeta(payload, "按资产、负债、权益科目余额汇总")}<div class="report-total-grid report-headline-grid"><div><span>资产合计</span><strong>${formatMoney(Number(totals.assetCents || 0), "CNY")}</strong></div><div><span>负债合计</span><strong>${formatMoney(Number(totals.liabilityCents || 0), "CNY")}</strong></div><div><span>所有者权益</span><strong>${formatMoney(Number(totals.equityCents || 0), "CNY")}</strong></div><div><span>勾稽差额</span><strong class="${payload.balanced ? "green-text" : "red-text"}">${formatMoney(Number(totals.differenceCents || 0), "CNY")}</strong></div></div><div class="report-columns">${reportLinesTable("资产", payload.assets || [])}<div>${reportLinesTable("负债", payload.liabilities || [])}${reportLinesTable("所有者权益", [...(payload.equity || []), payload.currentProfit].filter(Boolean))}</div></div><div class="report-reconciliation ${payload.balanced ? "success" : "danger"}">${icon(payload.balanced ? "circle-check" : "triangle-alert",18)}<span>${payload.balanced ? "资产 = 负债 + 所有者权益，报表勾稽平衡。" : "资产负债表不平，请从差额下钻核对科目和凭证。"}</span></div>`;
  } else if (report === "income-statement") {
    const totals = payload.totals || {};
    target.innerHTML = `${capabilityStatusMarkup({ iconName: "triangle-alert", title: "当前利润表是账面结果预览", message: "销售成本结转、费用报销、工资、折旧和税费计提尚未接入。收入来自真实凭证，但本期利润不能作为完整经营利润或纳税依据。", tone: "warning" })}${suiteReportMeta(payload, "按当前已入账收入、成本、费用科目汇总")}<div class="report-total-grid report-headline-grid"><div><span>营业收入</span><strong class="green-text">${formatMoney(Number(totals.revenueCents || 0), "CNY")}</strong></div><div><span>已入账营业成本</span><strong>${formatMoney(Number(totals.costCents || 0), "CNY")}</strong></div><div><span>已入账期间费用</span><strong>${formatMoney(Number(totals.expenseCents || 0), "CNY")}</strong></div><div><span>本期账面利润*</span><strong class="${Number(totals.profitCents || 0) >= 0 ? "green-text" : "red-text"}">${formatMoney(Number(totals.profitCents || 0), "CNY")}</strong></div></div><div class="report-columns">${reportLinesTable("收入项目", payload.revenue || [], "amountCents")}<div>${reportLinesTable("成本项目", payload.costs || [], "amountCents")}${reportLinesTable("费用项目", payload.expenses || [], "amountCents")}</div></div>`;
  } else if (report === "cash-flow-statement") {
    const currencyBlocks = (payload.currencies || []).map((currency) => `<section class="cashflow-currency"><div class="subsection-heading"><div><h3>${escapeHtml(currency.currency)} 现金流量</h3><span>逐币种列示，不跨币种合计</span></div><span class="status-badge ${currency.reconciled ? "settled" : "overdue"}">${currency.reconciled ? "已勾稽" : "需复核"}</span></div><div class="report-total-grid"><div><span>经营流入</span><strong class="green-text">${formatMoney(Number(currency.operating?.inflowCents || 0), currency.currency)}</strong></div><div><span>经营流出</span><strong>${formatMoney(Number(currency.operating?.outflowCents || 0), currency.currency)}</strong></div><div><span>经营净额</span><strong>${formatMoney(Number(currency.operating?.netCents || 0), currency.currency)}</strong></div><div><span>期末资金</span><strong>${formatMoney(Number(currency.cash?.endingBalanceCents || 0), currency.currency)}</strong></div></div><div class="cashflow-reconciliation"><span>期初 ${formatMoney(Number(currency.cash?.openingBalanceCents || 0), currency.currency)}</span><span>本期变动 ${formatMoney(Number(currency.cash?.differenceCents || 0), currency.currency)}</span><span>未分类净额 ${formatMoney(Number(currency.unclassified?.netCents || 0), currency.currency)}</span><span>勾稽差额 ${formatMoney(Number(currency.reconciliationDifferenceCents || 0), currency.currency)}</span></div></section>`).join("");
    const cashflowActions = `<div class="report-drilldown-actions"><button class="outline-button small-button" data-view="accounting" data-action="load-accounting-section" data-section="bank-journal">${icon("landmark",14)}查看银行日记账</button></div>`;
    target.innerHTML = `${suiteReportMeta(payload, "银行分录直接法，收付款及冲销归入经营活动")}${currencyBlocks || `<div class="audit-empty">${icon("landmark",22)}<span>当前期间没有银行现金流</span></div>`}${cashflowActions}<div class="report-reconciliation ${payload.reconciled ? "success" : "danger"}">${icon(payload.reconciled ? "circle-check" : "triangle-alert",18)}<span>${payload.reconciled ? "各币种现金流变动与银行账户余额勾稽一致。" : "现金流与资金余额存在差额，请检查未分类银行分录。"}</span></div>`;
  } else if (report === "aging") {
    const labels = { not_due: "未到期", "0_30": "逾期 0-30 天", "31_60": "31-60 天", "61_90": "61-90 天", "91_180": "91-180 天", "181_365": "181-365 天", over_365: "超过 365 天" };
    const rows = Object.entries(payload.buckets || {}).map(([bucket, value]) => `<tr><td>${labels[bucket] || bucket}</td><td class="amount-cell">${formatMoney(Number(value || 0), "CNY")}</td></tr>`).join("");
    const detailRows = (payload.orders || []).map((order) => `<tr><td><button class="table-link" type="button" data-action="view-detail" data-order-id="${escapeAttr(order.id)}">${escapeHtml(order.orderNo || "未编号")}</button></td><td>${escapeHtml(order.partnerName || "-")}</td><td>${order.direction === "receivable" ? "应收" : "应付"}</td><td>${labels[order.bucket] || escapeHtml(order.bucket || "-")}</td><td>${escapeHtml(order.currency || "CNY")}</td><td class="amount-cell">${formatMoney(Number(order.outstandingCents || 0), order.currency || "CNY")}</td></tr>`).join("");
    const agingDetails = detailRows ? `<section class="panel report-table-panel"><div class="panel-header"><div><h2>未结明细</h2><span>点击订单号可回到业务单据和收付款记录</span></div></div><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>订单号</th><th>往来单位</th><th>方向</th><th>账龄</th><th>币种</th><th>未结金额</th></tr></thead><tbody>${detailRows}</tbody></table></div></section>` : "";
    target.innerHTML = `${suiteReportMeta(payload, "按订单到期日和未结金额自动计算")}<section class="panel report-table-panel"><div class="panel-header"><div><h2>账龄分布</h2><span>截至 ${escapeHtml(payload.asOfDate || "当前日期")}，不同币种不合并</span></div><button class="text-button" data-view="reminders">查看提醒 ${icon("arrow-up-right", 13)}</button></div><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>账龄区间</th><th>未结金额</th></tr></thead><tbody>${rows}</tbody></table></div></section>${agingDetails}`;
  } else {
    const rows = (payload.accounts || []).map((account) => `<tr><td>${escapeHtml(account.code)}</td><td>${escapeHtml(account.name)}</td><td class="amount-cell">${formatMoney(Number(account.periodDebitCents || 0), "CNY")}</td><td class="amount-cell">${formatMoney(Number(account.periodCreditCents || 0), "CNY")}</td></tr>`).join("");
    target.innerHTML = `${suiteReportMeta(payload, "按期间汇总全部凭证借贷发生额")}<section class="panel report-table-panel"><div class="panel-header"><div><h2>试算平衡</h2><span>${payload.balanced ? "本期借贷平衡" : "存在差额"}</span></div><span class="status-badge ${payload.balanced ? "settled" : "overdue"}">${payload.balanced ? "已通过" : "需复核"}</span></div><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>科目</th><th>名称</th><th>本期借方</th><th>本期贷方</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }
  refreshIcons();
}

async function loadSuiteReport(report = state.reportTab) {
  if (!suiteReportLabels[report] || !roleCan(state.data?.role, "readAccounting")) return;
  state.reportTab = report;
  document.querySelectorAll(".report-tab").forEach((tab) => { const active = tab.dataset.report === report; tab.classList.toggle("active", active); tab.setAttribute("aria-selected", String(active)); });
  const target = byId("suiteReportResult");
  if (!target) return;
  const requestVersion = ++state.financeRenderVersion;
  target.innerHTML = accountingLoadingMarkup(`正在生成${suiteReportLabels[report]}`);
  const foreign = state.data.orders.filter((order) => order.currency !== "CNY" && order.fulfillmentStatus === "fulfilled").length;
  if (foreign && report !== "cash-flow-statement") {
    target.innerHTML = `<section class="blocking-state">${icon("shield-alert",28)}<strong>已阻止生成可能混币的${escapeHtml(suiteReportLabels[report])}</strong><p>检测到 ${foreign} 笔已交收外币业务。正式汇率折算接入前，仅现金流量表会按币种分别生成，其余财务报表不会给出误导金额。</p><div><button class="outline-button" data-view="checks">查看外币风险</button><button class="primary-button" data-action="load-suite-report" data-report="cash-flow-statement">查看分币种现金流</button></div></section>`;
    refreshIcons();
    return;
  }
  try {
    const period = tenantDate(new Date()).slice(0, 7);
    const payload = await apiRequest(`/api/accounting/${report}?period=${encodeURIComponent(period)}`, { busyText: `正在读取${suiteReportLabels[report]}` });
    if (requestVersion !== state.financeRenderVersion) return;
    renderSuiteReportPayload(report, payload);
  } catch (error) {
    if (requestVersion !== state.financeRenderVersion) return;
    target.innerHTML = `<div class="audit-empty error">${icon("circle-alert",22)}<span>${escapeHtml(error.message || "报表生成失败")}</span><button class="outline-button small-button" data-action="load-suite-report" data-report="${escapeAttr(report)}">重试</button></div>`;
    refreshIcons();
  }
}

function renderTaxView() {
  const view = byId("view-tax");
  if (!view || !state.data) return;
  if (!roleCan(state.data.role, "readAccounting")) {
    view.innerHTML = financeAccessDeniedMarkup("企业所得税草稿");
    return;
  }
  view.innerHTML = `<div class="view-heading"><div><p class="eyebrow">INCOME TAX DRAFT</p><h1>企业所得税申报草稿</h1><p>从利润表取数形成可解释草稿，税会差异和优惠必须由授权财务复核。</p></div><div class="heading-actions"><button class="outline-button" data-action="show-capability" data-capability="tax-export">${icon("file-down")}申报接口状态</button></div></div>
    ${capabilityStatusMarkup({ iconName: "circle-alert", title: "这是内部流程草稿，不是可直接提交的纳税申报表", message: "当前只读取已入账科目，销售成本结转和费用业务尚未完整接入；税会差异、弥补亏损、优惠政策、资产折旧和地区规则也待接入。页面测算不可作为申报依据，系统不会自动对外提交。", tone: "warning" })}
    <div id="taxDraftResult">${accountingLoadingMarkup("正在读取利润表并生成草稿")}</div>`;
}

function renderTaxDraftPayload(payload) {
  const target = byId("taxDraftResult");
  if (!target) return;
  const profit = Number(payload?.totals?.profitCents || 0);
  const rate = Number(state.taxRate || 0);
  const taxableIncome = Math.max(0, profit);
  const estimatedTax = Math.round(taxableIncome * rate / 100);
  target.innerHTML = `<div class="tax-draft-layout"><section class="panel tax-calculation"><div class="panel-header"><div><h2>所得税测算</h2><span>所属期间 ${escapeHtml(payload.period || tenantDate(new Date()).slice(0,7))}</span></div><span class="status-badge pending">待人工复核</span></div><div class="tax-line"><span>利润表：本期利润</span><strong>${formatMoney(profit, "CNY")}</strong><small>来源：利润表本期数</small></div><div class="tax-line pending"><span>加减：税会差异调整</span><strong>待确认</strong><small>费用扣除、折旧、优惠等规则尚未接入</small></div><div class="tax-line"><label for="taxRateInput">测算税率</label><div class="tax-rate-control"><input id="taxRateInput" type="number" min="0" max="100" step="0.01" value="${escapeAttr(rate)}" /><span>%</span></div><small>当前页面临时参数，不保存、不写死到申报规则</small></div><div class="tax-total"><span>未含税会差异的应纳税所得额</span><strong>${formatMoney(taxableIncome, "CNY")}</strong></div><div class="tax-total accent"><span>所得税测算</span><strong>${formatMoney(estimatedTax, "CNY")}</strong></div></section><section class="panel tax-trace"><div class="panel-header"><div><h2>取数与追溯</h2><span>财务数据 → 调整项目 → 草稿字段</span></div></div><div class="tax-trace-list"><button data-view="reports"><span>${icon("chart-no-axes-combined",18)}</span><strong>利润表</strong><small>本期利润 ${formatMoney(profit, "CNY")}</small>${icon("chevron-right",16)}</button><button data-view="balances"><span>${icon("scale",18)}</span><strong>科目余额</strong><small>查看收入、成本和费用来源</small>${icon("chevron-right",16)}</button><button data-action="show-capability" data-capability="tax-adjustments"><span>${icon("list-checks",18)}</span><strong>纳税调整</strong><small>规则与支持附件待接入</small>${icon("chevron-right",16)}</button><button data-action="show-capability" data-capability="tax-export"><span>${icon("file-check-2",18)}</span><strong>申报表样</strong><small>按年度和地区配置，当前未接入</small>${icon("chevron-right",16)}</button></div></section></div><div class="tax-disclaimer">系统生成的是申报草稿，须由授权财务或税务人员复核确认后方可用于申报。</div>`;
  refreshIcons();
}

async function loadTaxDraft() {
  if (!roleCan(state.data?.role, "readAccounting")) return;
  const target = byId("taxDraftResult");
  if (!target) return;
  const requestVersion = ++state.financeRenderVersion;
  target.innerHTML = accountingLoadingMarkup("正在读取利润表并生成草稿");
  const foreign = state.data.orders.filter((order) => order.currency !== "CNY" && order.fulfillmentStatus === "fulfilled").length;
  if (foreign) {
    target.innerHTML = `<section class="blocking-state">${icon("shield-alert",28)}<strong>所得税草稿已暂停生成</strong><p>检测到 ${foreign} 笔已交收外币业务，但正式汇率折算尚未接入。为避免错误申报测算，系统不会基于混币利润生成税务草稿。</p><button class="outline-button" data-view="checks">查看外币风险</button></section>`;
    refreshIcons();
    return;
  }
  try {
    const period = tenantDate(new Date()).slice(0, 7);
    const payload = await apiRequest(`/api/accounting/income-statement?period=${encodeURIComponent(period)}`, { busyText: "正在生成所得税草稿" });
    if (requestVersion !== state.financeRenderVersion) return;
    state.taxDraftPayload = payload;
    renderTaxDraftPayload(payload);
  } catch (error) {
    if (requestVersion !== state.financeRenderVersion) return;
    target.innerHTML = `<div class="audit-empty error">${icon("circle-alert",22)}<span>${escapeHtml(error.message || "所得税草稿生成失败")}</span><button class="outline-button small-button" data-action="refresh-tax-draft">重试</button></div>`;
    refreshIcons();
  }
}

function renderPeriodCloseView() {
  const view = byId("view-period-close");
  if (!view || !state.data) return;
  if (!roleCan(state.data.role, "readAccounting")) {
    view.innerHTML = financeAccessDeniedMarkup("期末处理");
    return;
  }
  view.innerHTML = `<div class="view-heading"><div><p class="eyebrow">PERIOD END</p><h1>期末检查与结账</h1><p>先检查凭证、账表、业务链和外币风险，再由负责人或财务锁定期间。</p></div><div class="heading-actions"><button class="outline-button" data-action="refresh-period-close">${icon("refresh-cw")}重新检查</button></div></div>
    ${capabilityStatusMarkup({ iconName: "lock-keyhole", title: "基础期间锁定已实现，未接入检查会阻止结账", message: "已结账期间会禁止补录并保留审计记录。原始凭证、审批、折旧、摊销、工资、税费、成本结转和汇兑损益未完成前，系统不会允许锁定有业务数据的期间。", tone: "warning" })}
    <div id="periodCloseResult">${accountingLoadingMarkup("正在运行结账前检查")}</div>`;
}

async function loadPeriodCloseView() {
  if (!roleCan(state.data?.role, "readAccounting")) return;
  const target = byId("periodCloseResult");
  if (!target) return;
  const requestVersion = ++state.financeRenderVersion;
  target.innerHTML = accountingLoadingMarkup("正在运行结账前检查");
  try {
    const periodName = tenantDate(new Date()).slice(0, 7);
    const foreign = state.data.orders.filter((order) => order.currency !== "CNY" && order.fulfillmentStatus === "fulfilled").length;
    const [periodsPayload, balancePayload] = await Promise.all([
      apiRequest("/api/accounting/periods", { busyText: "正在读取会计期间" }),
      foreign
        ? Promise.resolve(null)
        : apiRequest(`/api/accounting/trial-balance?period=${encodeURIComponent(periodName)}`, { busyText: "正在检查账表平衡" })
    ]);
    if (requestVersion !== state.financeRenderVersion) return;
    const periods = Array.isArray(periodsPayload.periods) ? periodsPayload.periods : [];
    const current = periods.find((period) => String(period.start || "").startsWith(periodName)) || periods.find((period) => period.status === "open") || periods[0];
    const checks = [
      [foreign ? "block" : balancePayload?.balanced ? "pass" : "block", "账簿借贷平衡", foreign ? "检测到外币业务，已跳过混币试算平衡请求" : balancePayload?.balanced ? "借方与贷方发生额一致" : `差额 ${formatMoney(Number(balancePayload?.totals?.differenceCents || 0), "CNY")}`],
      [foreign ? "block" : "pass", "外币折算", foreign ? `${foreign} 笔外币业务缺少正式汇率折算` : "当前无外币入账风险"],
      ["block", "原始凭证完整性", "附件存储未接入，当前无法完成必需检查"],
      ["block", "审批完整性", "审批状态机未接入，当前无法完成必需检查"],
      ["block", "折旧、摊销与成本结转", "完整期末向导未接入，当前利润和库存成本不完整"]
    ];
    const hardBlocks = checks.filter(([status]) => status === "block").length;
    const closeAction = current?.status === "open" && roleCan(state.data.role, "closePeriod")
      ? `<button class="primary-button" data-action="close-accounting-period" data-period-id="${escapeAttr(current.id)}" data-period-label="${escapeAttr(accountingPeriodLabel(current))}" ${hardBlocks ? "disabled title=\"存在高风险阻断项\"" : ""}>${icon("lock-keyhole")}确认月末结账</button>`
      : current?.status === "closed" ? `<span class="status-badge settled">本期间已结账</span>` : `<button class="outline-button" disabled>当前角色不可结账</button>`;
    target.innerHTML = `<div class="period-close-layout"><section class="panel close-check-panel"><div class="panel-header"><div><h2>结账前检查</h2><span>${escapeHtml(accountingPeriodLabel(current))} · ${hardBlocks ? `${hardBlocks} 个阻断项` : "无高风险阻断项"}</span></div><span class="status-badge ${hardBlocks ? "overdue" : "pending"}">${hardBlocks ? "暂不可结账" : "可执行基础锁期"}</span></div><div class="close-check-list">${checks.map(([status, label, detail]) => `<div class="close-check-row ${status}"><span>${icon(status === "pass" ? "circle-check" : status === "block" ? "octagon-alert" : "circle-help",18)}</span><div><strong>${label}</strong><small>${detail}</small></div><em>${status === "pass" ? "通过" : status === "block" ? "阻断" : "待接入"}</em></div>`).join("")}</div></section><section class="panel close-action-panel"><div class="panel-header"><div><h2>会计期间</h2><span>结账是受控操作，不删除历史记录。</span></div></div><div class="period-status-card"><span>当前期间</span><strong>${escapeHtml(accountingPeriodLabel(current))}</strong><em class="status-badge ${current?.status === "closed" ? "settled" : "pending"}">${current?.status === "closed" ? "已结账" : "开放"}</em></div><div class="close-impact"><strong>结账后会发生什么</strong><ul><li>该期间禁止新增交收、收付款和自动凭证</li><li>账簿和报表继续保持只读可追溯</li><li>操作人、时间和期间写入审计日志</li><li>当前页面不提供静默撤销或删除</li></ul></div><div class="close-action-footer">${closeAction}</div></section></div>`;
    refreshIcons();
  } catch (error) {
    if (requestVersion !== state.financeRenderVersion) return;
    target.innerHTML = `<div class="audit-empty error">${icon("circle-alert",22)}<span>${escapeHtml(error.message || "结账前检查失败")}</span><button class="outline-button small-button" data-action="refresh-period-close">重试</button></div>`;
    refreshIcons();
  }
}

function renderAll() {
  if (!state.data) return;
  renderOverview();
  renderLedgerView("receivable");
  renderLedgerView("payable");
  renderOrdersView();
  renderEvidenceView();
  renderApprovalsView();
  renderInventoryView();
  renderAccountingView();
  renderChecksView();
  renderBalancesView();
  renderAuxiliaryView();
  renderReportsView();
  renderTaxView();
  renderPeriodCloseView();
  renderContactsView();
  renderRemindersView();
  renderImportView();
  renderOcrView();
  renderAutomationView();
  renderSettingsView();
  updateRoleNavigation();
  updateNavigationCounts();
  setView(state.view, false);
  refreshIcons();
}

function updateRoleNavigation() {
  const financeViews = new Set(["accounting", "checks", "balances", "auxiliary", "reports", "tax", "period-close"]);
  const canReadFinance = roleCan(state.data?.role, "readAccounting");
  document.querySelectorAll(".nav-item[data-view], .mobile-nav-item[data-view]").forEach((item) => {
    item.classList.toggle("role-hidden", financeViews.has(item.dataset.view) && !canReadFinance);
  });
  document.querySelector(".period-chip")?.classList.toggle("role-hidden", !canReadFinance);
}

function renderAccountingView() {
  const view = byId("view-accounting");
  if (!view || !state.data) return;
  if (!roleCan(state.data.role, "readAccounting")) {
    view.innerHTML = financeAccessDeniedMarkup("记账凭证");
    return;
  }
  view.innerHTML = `<div class="view-heading"><div><p class="eyebrow">ACCOUNTING VOUCHERS</p><h1>记账凭证与总账</h1><p>订单交收和收付款会自动形成可审计分录，普通用户无需选择借贷科目。</p></div><div class="heading-actions"><button class="outline-button" data-action="load-accounting">${icon("refresh-cw")}刷新凭证</button></div></div><section class="panel accounting-intro"><div class="panel-header"><div><h2>基础自动记账已开启</h2><span>当前覆盖订单交收、收付款和冲销；凭证仅追加，不覆盖历史。</span></div><span class="status-badge settled">基础自动记账模板</span></div><div class="accounting-summary"><div><strong>主账币种</strong><span>CNY 人民币</span></div><div><strong>当前期间</strong><span id="accountingPeriodSummary">正在读取</span></div><div><strong>当前流程</strong><span>生成即入账 · 复核审批待接入</span></div></div></section><div class="finance-shortcuts"><button data-view="checks">${icon("shield-alert",18)}<span><strong>智能检查</strong><small>发现凭证和外币风险</small></span></button><button data-view="balances">${icon("scale",18)}<span><strong>科目余额</strong><small>期初、本期与期末</small></span></button><button data-view="auxiliary">${icon("book-user",18)}<span><strong>辅助明细</strong><small>客户和供应商往来</small></span></button><button data-view="reports">${icon("chart-no-axes-combined",18)}<span><strong>财务报表</strong><small>三大报表与账龄</small></span></button></div><section class="panel accounting-panel"><div class="panel-header"><div><h2>自动凭证与账簿</h2><span>每一笔结果保留来源类型和来源编号。</span></div></div><div class="accounting-tiles"><button type="button" class="accounting-tile" aria-controls="accountingData" aria-pressed="false" data-action="load-accounting"><span>${icon("receipt-text",22)}</span><strong>自动凭证</strong><small>查看凭证和来源</small></button><button type="button" class="accounting-tile" aria-controls="accountingData" aria-pressed="false" data-action="load-accounting-section" data-section="ledger"><span>${icon("book-open",22)}</span><strong>会计明细账</strong><small>按科目查看每笔分录</small></button><button type="button" class="accounting-tile" aria-controls="accountingData" aria-pressed="false" data-action="load-accounting-section" data-section="bank-journal"><span>${icon("landmark",22)}</span><strong>银行日记账</strong><small>收付款按资金账户留痕</small></button></div><div id="accountingData" class="accounting-data"><div class="audit-empty">${icon("loader-circle",22)}<span>正在读取凭证</span></div></div></section>`;
}

async function loadAccountingData() {
  const target = byId("accountingData");
  if (!target || !state.data) return;
  const requestVersion = ++state.accountingRenderVersion;
  document.querySelectorAll(".accounting-tile").forEach((tile) => {
    tile.classList.remove("active");
    tile.setAttribute("aria-pressed", "false");
  });
  try {
    const [journalsPayload, periodsPayload] = await Promise.all([
      apiRequest("/api/accounting/journals?limit=80", { busyText: "正在读取会计账簿" }),
      apiRequest("/api/accounting/periods", { busyText: "正在读取会计期间" })
    ]);
    const journals = Array.isArray(journalsPayload.journals) ? journalsPayload.journals : [];
    const periods = Array.isArray(periodsPayload.periods) ? periodsPayload.periods : [];
    if (requestVersion !== state.accountingRenderVersion) return;
    const current = periods[0];
    const summary = byId("accountingPeriodSummary");
    if (summary) summary.textContent = current ? `${current.start?.slice(0, 7)} · ${current.status === "closed" ? "已结账" : "开放"}` : "暂无期间";
    const accounts = state.data.accounting?.accounts || [];
    const foreignFulfilledCount = state.data.orders.filter((order) => order.fulfillmentStatus === "fulfilled" && order.currency !== "CNY").length;
    const accountRows = accounts.filter((account) => Number(account.debitCents || account.creditCents || 0) > 0).map((account) => {
      const debit = Number(account.debitCents || 0);
      const credit = Number(account.creditCents || 0);
      const normalSide = ["liability", "equity", "revenue"].includes(account.category) ? "credit" : "debit";
      const balance = normalSide === "credit" ? credit - debit : debit - credit;
      return `<tr><td><strong>${escapeHtml(account.code)}</strong></td><td>${escapeHtml(account.name)}</td><td class="amount-cell">${formatMoney(debit, "CNY")}</td><td class="amount-cell">${formatMoney(credit, "CNY")}</td><td class="amount-cell"><strong>${formatMoney(balance, "CNY")}</strong></td></tr>`;
    }).join("");
    const reportButtons = `<div class="accounting-report-links"><button class="outline-button small-button" data-view="checks">${icon("shield-alert",14)}智能检查</button><button class="outline-button small-button" data-view="balances">${icon("scale",14)}科目余额表</button><button class="outline-button small-button" data-view="reports">${icon("chart-no-axes-combined",14)}财务报表</button><button class="outline-button small-button" data-view="period-close">${icon("calendar-check",14)}期末处理</button></div>`;
    const accountTable = foreignFulfilledCount
      ? `<section class="capability-status danger accounting-currency-warning"><span class="capability-status-icon">${icon("shield-alert",22)}</span><div><strong>本位币科目汇总已暂停展示</strong><p>检测到 ${foreignFulfilledCount} 笔外币业务。下方凭证继续按原币逐张展示，但汇率和本位币折算接入前，不会把外币发生额并入 CNY 科目余额。</p></div><div class="capability-status-actions"><button class="outline-button small-button" data-view="checks">查看风险</button></div></section>`
      : accountRows ? `<section class="accounting-subsection"><div class="subsection-heading"><div><h3>科目余额</h3><span>当前企业累计借贷发生额及余额方向</span></div></div><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>科目</th><th>名称</th><th>借方发生</th><th>贷方发生</th><th>余额</th></tr></thead><tbody>${accountRows}</tbody></table></div></section>` : "";
    const journalTable = journals.length ? `<section class="accounting-subsection"><div class="subsection-heading"><div><h3>自动凭证</h3><span>点击凭证可展开分录，并反查到来源订单。</span></div><span class="status-badge settled">${journals.length} 张已入账</span></div><div class="voucher-list">${journals.map((journal) => { const lines = Array.isArray(journal.lines) ? journal.lines : []; const currency = journal.currency || lines.find((line) => line.currency)?.currency || "CNY"; const debit = lines.reduce((sum, line) => sum + Number(line.debitCents || 0), 0); const credit = lines.reduce((sum, line) => sum + Number(line.creditCents || 0), 0); const sourceOrderId = journalSourceOrderId(journal); return `<details class="voucher-details"><summary><span class="voucher-no">记-${escapeHtml(journal.voucherNo)}</span><span><strong>${escapeHtml(journal.description || accountingSourceLabel(journal.sourceType))}</strong><small>${escapeHtml(String(journal.postedAt || "").slice(0, 10))} · ${escapeHtml(accountingSourceLabel(journal.sourceType))} · ${escapeHtml(currency)}</small></span><span class="amount-cell"><strong>${formatMoney(debit, currency)}</strong><small>借贷平衡</small></span><span class="status-badge settled">已入账</span>${icon("chevron-down",16)}</summary><div class="voucher-lines"><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>科目</th><th>摘要</th><th>借方</th><th>贷方</th><th>币种</th></tr></thead><tbody>${lines.map((line) => { const lineCurrency = line.currency || currency; return `<tr><td><strong>${escapeHtml(line.accountCode || "-")}</strong><small class="table-subtext">${escapeHtml(line.accountName || "")}</small></td><td>${escapeHtml(line.description || journal.description || "-")}</td><td class="amount-cell">${Number(line.debitCents || 0) ? formatMoney(Number(line.debitCents), lineCurrency) : "-"}</td><td class="amount-cell">${Number(line.creditCents || 0) ? formatMoney(Number(line.creditCents), lineCurrency) : "-"}</td><td>${escapeHtml(lineCurrency)}</td></tr>`; }).join("")}</tbody></table></div><div class="voucher-source"><span>来源：${escapeHtml(accountingSourceLabel(journal.sourceType))} · ${escapeHtml(journal.sourceId || "-")}</span>${sourceOrderId ? `<button class="outline-button small-button" data-action="view-detail" data-order-id="${escapeAttr(sourceOrderId)}">查看来源订单</button>` : `<span class="status-badge draft">来源反查待扩展</span>`}</div></div></details>`; }).join("")}</div></section>` : `<div class="audit-empty">${icon("book-open",22)}<span>还没有自动生成的凭证。确认一笔交货或收付款后，这里会出现账务结果。</span></div>`;
    target.innerHTML = `${reportButtons}${accountTable}${journalTable}<div id="accountingReportResult"></div>`;
  } catch (error) {
    if (requestVersion !== state.accountingRenderVersion) return;
    target.innerHTML = `<div class="audit-empty error">${icon("circle-alert",22)}<span>${escapeHtml(error.message || "账簿读取失败")}</span></div>`;
  }
}

const accountingSourceLabels = {
  "order.fulfillment": "确认交货",
  payment: "收付款",
  "payment.reversal": "冲销收付款"
};

function accountingSourceLabel(sourceType) {
  return accountingSourceLabels[sourceType] || sourceType || "会计分录";
}

function journalSourceOrderId(journal) {
  if (journal.sourceType === "order.fulfillment") return journal.sourceId || "";
  if (journal.sourceType === "payment") {
    return state.data.orders.find((order) => (order.payments || []).some((payment) => payment.id === journal.sourceId))?.id || "";
  }
  return "";
}

function accountingLoadingMarkup(message) {
  return `<div class="audit-empty">${icon("loader-circle", 22)}<span>${escapeHtml(message)}</span></div>`;
}

function accountingErrorMarkup(message, retrySection = "ledger") {
  return `<div class="audit-empty error">${icon("circle-alert", 22)}<span>${escapeHtml(message || "账簿读取失败")}</span><button class="outline-button small-button" data-action="load-accounting-section" data-section="${escapeAttr(retrySection)}">重试</button></div>`;
}

function revealAccountingTarget(target, block = "nearest") {
  if (target?.isConnected) target.scrollIntoView({ behavior: "smooth", block });
}

function accountingPeriodLabel(period) {
  if (!period) return "未知期间";
  const start = String(period.start || "").slice(0, 7);
  return start || `${period.start || ""} 至 ${period.end || ""}`;
}

function renderAccountingLedgerSection(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const table = safeRows.length
    ? `<div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>日期</th><th>凭证号</th><th>科目</th><th>摘要</th><th>往来单位</th><th>借方</th><th>贷方</th><th>币种</th><th>来源</th></tr></thead><tbody>${safeRows.map((row) => { const sourceOrderId = ledgerSourceOrderId(row); const source = sourceOrderId ? `<button class="table-link" type="button" data-action="view-detail" data-order-id="${escapeAttr(sourceOrderId)}">查看订单</button>` : `<span class="table-subtext">${escapeHtml(accountingSourceLabel(row.sourceType))}</span>`; return `<tr><td>${escapeHtml(row.entryDate || "-")}</td><td><strong>${escapeHtml(String(row.entryNo ?? "-"))}</strong></td><td><strong>${escapeHtml(row.accountCode || "-")}</strong><span class="table-subtext">${escapeHtml(row.accountName || "")}</span></td><td>${escapeHtml(row.description || row.entryDescription || accountingSourceLabel(row.sourceType))}</td><td>${escapeHtml(row.partnerName || "-")}</td><td class="amount-cell">${formatMoney(Number(row.debitCents || 0), row.currency || "CNY")}</td><td class="amount-cell">${formatMoney(Number(row.creditCents || 0), row.currency || "CNY")}</td><td>${escapeHtml(row.currency || "CNY")}</td><td>${source}</td></tr>`; }).join("")}</tbody></table></div>`
    : `<div class="audit-empty">${icon("book-open", 22)}<span>当前没有明细账记录。确认交货或登记收付款后，系统会自动生成分录。</span></div>`;
  return `<section class="accounting-subsection accounting-section-result"><div class="subsection-heading"><div><h3>会计明细账</h3><span>共 ${safeRows.length} 条分录，借贷方向和币种逐笔保留</span></div><span class="status-badge settled">已同步</span></div>${table}</section>`;
}

function ledgerSourceOrderId(row) {
  if (!row) return "";
  if (row.sourceType === "order.fulfillment") return row.sourceId || "";
  if (row.sourceType === "payment") {
    return state.data.orders.find((order) => (order.payments || []).some((payment) => payment.id === row.sourceId))?.id || "";
  }
  return "";
}

function renderAccountingBankSection(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const totalsByCurrency = new Map();
  safeRows.forEach((row) => {
    const currency = row.currency || "CNY";
    const totals = totalsByCurrency.get(currency) || { debit: 0, credit: 0 };
    totals.debit += Number(row.debitCents || 0);
    totals.credit += Number(row.creditCents || 0);
    totalsByCurrency.set(currency, totals);
  });
  const table = safeRows.length
    ? `<div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>日期</th><th>银行账户</th><th>凭证号</th><th>摘要</th><th>往来单位</th><th>收入</th><th>支出</th><th>币种</th><th>来源</th></tr></thead><tbody>${safeRows.map((row) => { const sourceOrderId = ledgerSourceOrderId(row); const source = sourceOrderId ? `<button class="table-link" type="button" data-action="view-detail" data-order-id="${escapeAttr(sourceOrderId)}">查看订单</button>` : `<span class="table-subtext">${escapeHtml(accountingSourceLabel(row.sourceType))}</span>`; return `<tr><td>${escapeHtml(row.entryDate || "-")}</td><td>${escapeHtml(row.bankAccountName || "-")}</td><td><strong>${escapeHtml(String(row.entryNo ?? "-"))}</strong></td><td>${escapeHtml(row.description || row.entryDescription || accountingSourceLabel(row.sourceType))}</td><td>${escapeHtml(row.partnerName || "-")}</td><td class="amount-cell green-text">${formatMoney(Number(row.debitCents || 0), row.currency || "CNY")}</td><td class="amount-cell blue-text">${formatMoney(Number(row.creditCents || 0), row.currency || "CNY")}</td><td>${escapeHtml(row.currency || "CNY")}</td><td>${source}</td></tr>`; }).join("")}</tbody></table></div>`
    : `<div class="audit-empty">${icon("landmark", 22)}<span>当前没有银行日记账记录。登记银行收付款后，系统会自动生成流水。</span></div>`;
  const totals = safeRows.length ? `<div class="report-total-grid accounting-journal-totals">${[...totalsByCurrency.entries()].map(([currency, values]) => `<div><span>${escapeHtml(currency)} 收入合计</span><strong class="green-text">${formatMoney(values.debit, currency)}</strong></div><div><span>${escapeHtml(currency)} 支出合计</span><strong class="blue-text">${formatMoney(values.credit, currency)}</strong></div>`).join("")}<div><span>记录数</span><strong>${safeRows.length}</strong></div></div>` : "";
  return `<section class="accounting-subsection accounting-section-result"><div class="subsection-heading"><div><h3>银行日记账</h3><span>仅展示带银行账户的收付款分录，不把现金或其他币种混在一起</span></div><span class="status-badge settled">已同步</span></div>${totals}${table}</section>`;
}

function renderAccountingPeriodSection(periods) {
  const safePeriods = Array.isArray(periods) ? periods : [];
  const current = safePeriods.find((period) => period.status === "open") || safePeriods[0];
  if (!current) return `<section class="accounting-subsection accounting-section-result"><div class="audit-empty">${icon("calendar-check", 22)}<span>当前还没有会计期间。</span></div></section>`;
  const canClose = roleCan(state.data?.role, "closePeriod");
  const currentIsOpen = current.status === "open";
  const closeButton = currentIsOpen && canClose
    ? `<button class="primary-button small-button" data-action="close-accounting-period" data-period-id="${escapeAttr(current.id)}" data-period-label="${escapeAttr(accountingPeriodLabel(current))}">${icon("lock-keyhole", 14)}确认月末结账</button>`
    : currentIsOpen
      ? `<button class="outline-button small-button" type="button" disabled title="当前角色无结账权限">只读角色不可结账</button>`
      : `<span class="status-badge settled">已结账</span>`;
  const periodRows = safePeriods.map((period) => `<tr><td><strong>${escapeHtml(accountingPeriodLabel(period))}</strong></td><td>${escapeHtml(period.start || "-")} 至 ${escapeHtml(period.end || "-")}</td><td><span class="status-badge ${period.status === "closed" ? "settled" : "pending"}">${period.status === "closed" ? "已结账" : "开放"}</span></td><td>${escapeHtml(period.closedAt ? String(period.closedAt).slice(0, 16).replace("T", " ") : "-")}</td></tr>`).join("");
  return `<section class="accounting-subsection accounting-section-result"><div class="subsection-heading"><div><h3>月末结账</h3><span>结账后该期间禁止补录，历史凭证和审计记录仍可查看</span></div>${closeButton}</div><div class="pending-note ${currentIsOpen ? "important" : ""}">${icon(currentIsOpen ? "circle-alert" : "circle-check", 18)}<div><strong>${currentIsOpen ? `${escapeHtml(accountingPeriodLabel(current))} 尚未结账` : `${escapeHtml(accountingPeriodLabel(current))} 已完成结账`}</strong><span>${currentIsOpen ? "请先核对明细账、银行日记账和报表，再执行结账。结账操作不可在页面撤回。" : `结账时间：${escapeHtml(current.closedAt ? String(current.closedAt).slice(0, 16).replace("T", " ") : "记录已保存")}`}</span></div></div><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>会计期间</th><th>起止日期</th><th>状态</th><th>结账时间</th></tr></thead><tbody>${periodRows}</tbody></table></div></section>`;
}

async function loadAccountingSection(section = "ledger", accountCode = "") {
  const target = byId("accountingData");
  if (!target || !state.data) return;
  const requestVersion = ++state.accountingRenderVersion;
  const sectionName = ["ledger", "bank-journal", "period-close"].includes(section) ? section : "ledger";
  document.querySelectorAll(".accounting-tile").forEach((tile) => {
    const active = tile.dataset.section === sectionName;
    tile.classList.toggle("active", active);
    tile.setAttribute("aria-pressed", String(active));
  });
  target.innerHTML = accountingLoadingMarkup(sectionName === "ledger" ? "正在读取会计明细账" : sectionName === "bank-journal" ? "正在读取银行日记账" : "正在读取会计期间");
  try {
    if (sectionName === "ledger") {
      const query = accountCode ? `&accountCode=${encodeURIComponent(accountCode)}` : "";
      const payload = await apiRequest(`/api/accounting/ledger?limit=500${query}`, { busyText: "正在读取会计明细账" });
      if (requestVersion !== state.accountingRenderVersion) return;
      target.innerHTML = `${accountCode ? `<div class="account-ledger-filter">${icon("filter",14)}当前科目：${escapeHtml(accountCode)}<button class="text-button" data-action="load-accounting-section" data-section="ledger">查看全部</button></div>` : ""}${renderAccountingLedgerSection(payload.ledger)}`;
    } else if (sectionName === "bank-journal") {
      const payload = await apiRequest("/api/accounting/bank-journal?limit=500", { busyText: "正在读取银行日记账" });
      if (requestVersion !== state.accountingRenderVersion) return;
      target.innerHTML = renderAccountingBankSection(payload.bankJournal);
    } else {
      const payload = await apiRequest("/api/accounting/periods", { busyText: "正在读取会计期间" });
      if (requestVersion !== state.accountingRenderVersion) return;
      target.innerHTML = renderAccountingPeriodSection(payload.periods);
      const current = (payload.periods || []).find((period) => period.status === "open") || payload.periods?.[0];
      const summary = byId("accountingPeriodSummary");
      if (summary) summary.textContent = current ? `${accountingPeriodLabel(current)} · ${current.status === "closed" ? "已结账" : "开放"}` : "暂无期间";
    }
    if (requestVersion !== state.accountingRenderVersion) return;
  } catch (error) {
    if (requestVersion !== state.accountingRenderVersion) return;
    target.innerHTML = accountingErrorMarkup(error.message, sectionName);
  }
  refreshIcons();
  revealAccountingTarget(target, "start");
}

async function closeAccountingPeriod(periodId, action) {
  if (!roleCan(state.data?.role, "closePeriod")) {
    showToast("只有负责人或财务可以月末结账", "error");
    return;
  }
  const label = action?.dataset.periodLabel || "当前期间";
  if (!window.confirm(`确认关闭 ${label} 吗？\n结账后该期间禁止补录，此操作不可在页面撤回。`)) return;
  if (action) {
    action.disabled = true;
    action.setAttribute("aria-busy", "true");
    action.innerHTML = `${icon("loader-circle", 14)}正在结账`;
  }
  try {
    await apiRequest(`/api/accounting/periods/${encodeURIComponent(periodId)}/close`, { method: "POST", busyText: "正在执行月末结账" });
    showToast(`${label}已结账，本期间已关闭，后续录入需使用新会计期间`, "success");
    if (state.view === "period-close") await loadPeriodCloseView();
    else await loadAccountingSection("period-close");
  } catch (error) {
    if (action) {
      action.disabled = false;
      action.removeAttribute("aria-busy");
      action.innerHTML = `${icon("lock-keyhole", 14)}确认月末结账`;
    }
    showToast(error.message || "月末结账失败，请稍后重试", "error");
    refreshIcons();
  }
}

async function loadAccountingReport(report) {
  const target = byId("accountingReportResult");
  if (!target) return;
  target.innerHTML = `<div class="audit-empty">${icon("loader-circle", 20)}<span>正在读取报表</span></div>`;
  try {
    const payload = await apiRequest(`/api/accounting/${report}`, { busyText: "正在读取财务报表" });
    const moneyValue = (value) => formatMoney(Number(value || 0), "CNY");
    if (report === "trial-balance") {
      const rows = (payload.accounts || []).filter((account) => Number(account.debitCents || account.creditCents || 0) > 0).map((account) => `<tr><td><strong>${escapeHtml(account.code)}</strong></td><td>${escapeHtml(account.name)}</td><td class="amount-cell">${moneyValue(account.debitCents)}</td><td class="amount-cell">${moneyValue(account.creditCents)}</td><td class="amount-cell">${moneyValue(account.endingBalanceCents)}</td></tr>`).join("");
      target.innerHTML = `<section class="accounting-report-result"><div class="subsection-heading"><div><h3>试算平衡表</h3><span>${payload.balanced ? "借贷平衡" : "存在差额，请联系财务复核"}</span></div><span class="status-badge ${payload.balanced ? "settled" : "overdue"}">${payload.balanced ? "已平衡" : "需复核"}</span></div><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>科目</th><th>名称</th><th>借方</th><th>贷方</th><th>余额</th></tr></thead><tbody>${rows || `<tr><td colspan="5">暂无发生额</td></tr>`}</tbody></table></div></section>`;
      revealAccountingTarget(target);
      return;
    }
    if (report === "income-statement") {
      const totals = payload.totals || {};
      target.innerHTML = `<section class="accounting-report-result"><div class="subsection-heading"><div><h3>利润表</h3><span>收入、成本和费用按当前期间统计</span></div></div><div class="report-total-grid"><div><span>营业收入</span><strong class="green-text">${moneyValue(totals.revenueCents)}</strong></div><div><span>营业成本</span><strong>${moneyValue(totals.costCents)}</strong></div><div><span>期间费用</span><strong>${moneyValue(totals.expenseCents)}</strong></div><div><span>本期利润</span><strong class="${Number(totals.profitCents || 0) >= 0 ? "green-text" : "red-text"}">${moneyValue(totals.profitCents)}</strong></div></div></section>`;
      revealAccountingTarget(target);
      return;
    }
    if (report === "balance-sheet") {
      const totals = payload.totals || {};
      target.innerHTML = `<section class="accounting-report-result"><div class="subsection-heading"><div><h3>资产负债表</h3><span>${payload.balanced ? "资产 = 负债 + 所有者权益" : "报表暂不平衡，请复核凭证"}</span></div><span class="status-badge ${payload.balanced ? "settled" : "overdue"}">${payload.balanced ? "已平衡" : "需复核"}</span></div><div class="report-total-grid"><div><span>资产合计</span><strong>${moneyValue(totals.assetCents)}</strong></div><div><span>负债合计</span><strong>${moneyValue(totals.liabilityCents)}</strong></div><div><span>所有者权益</span><strong>${moneyValue(totals.equityCents)}</strong></div><div><span>差额</span><strong class="${Number(totals.differenceCents || 0) === 0 ? "green-text" : "red-text"}">${moneyValue(totals.differenceCents)}</strong></div></div></section>`;
      revealAccountingTarget(target);
      return;
    }
    if (report === "aging") {
      const bucketLabels = { not_due: "未到期", "0_30": "逾期 0–30 天", "31_60": "31–60 天", "61_90": "61–90 天", "91_180": "91–180 天", "181_365": "181–365 天", over_365: "超过 365 天" };
      const bucketRows = Object.entries(payload.buckets || {}).map(([bucket, value]) => `<tr><td>${bucketLabels[bucket] || bucket}</td><td class="amount-cell">${moneyValue(value)}</td></tr>`).join("");
      target.innerHTML = `<section class="accounting-report-result"><div class="subsection-heading"><div><h3>应收应付账龄</h3><span>截至 ${escapeHtml(payload.asOfDate || "当前日期")}，不同币种暂不合并</span></div></div><div class="accounting-table-wrap"><table class="data-table"><thead><tr><th>账龄区间</th><th>未结金额</th></tr></thead><tbody>${bucketRows}</tbody></table></div></section>`;
      revealAccountingTarget(target);
    }
  } catch (error) {
    target.innerHTML = `<div class="audit-empty error">${icon("circle-alert", 20)}<span>${escapeHtml(error.message || "报表读取失败")}</span></div>`;
    revealAccountingTarget(target);
  }
}

function updateNavigationCounts() {
  const counts = {
    overview: state.data.reminders.length,
    receivable: state.data.orders.filter((order) => order.direction === "receivable" && order.fulfillmentStatus === "fulfilled" && order.outstandingCents > 0).length,
    payable: state.data.orders.filter((order) => order.direction === "payable" && order.fulfillmentStatus === "fulfilled" && order.outstandingCents > 0).length,
    reminders: state.data.reminders.length
  };
  document.querySelectorAll("[data-nav-count]").forEach((element) => { element.textContent = counts[element.dataset.navCount] ?? 0; });
  document.querySelectorAll("[data-mobile-count]").forEach((element) => {
    element.textContent = counts[element.dataset.mobileCount] ?? 0;
    element.classList.toggle("hidden", !counts[element.dataset.mobileCount]);
  });
  byId("notificationDot").classList.toggle("hidden", counts.reminders === 0);
}

function setView(view, scroll = true) {
  if (!viewLabels[view]) return;
  state.financeRenderVersion += 1;
  state.view = view;
  document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${view}`));
  document.querySelectorAll(".nav-item[data-view], .mobile-nav-item[data-view]").forEach((element) => {
    const active = element.dataset.view === view;
    element.classList.toggle("active", active);
    if (active) element.setAttribute("aria-current", "page");
    else element.removeAttribute("aria-current");
  });
  byId("breadcrumbRoot").textContent = viewGroups[view] || "思燕智能财务";
  byId("breadcrumbCurrent").textContent = viewLabels[view];
  setSidebarOpen(false);
  if (scroll) window.scrollTo({ top: 0, behavior: "auto" });
  refreshIcons();
  if (view === "settings") {
    void loadNotificationSettings();
    void loadAudit();
    void loadMembers();
  }
  if (view === "accounting" && roleCan(state.data?.role, "readAccounting")) void loadAccountingData();
  if (view === "checks") void loadSmartChecks();
  if (view === "balances") void loadBalanceTable();
  if (view === "reports") void loadSuiteReport(state.reportTab);
  if (view === "tax") void loadTaxDraft();
  if (view === "period-close") void loadPeriodCloseView();
}

function setSidebarOpen(open) {
  const sidebar = byId("sidebar");
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  sidebar.classList.toggle("open", open);
  sidebar.inert = mobile && !open;
  sidebar.setAttribute("aria-hidden", String(mobile && !open));
  byId("sidebarScrim").classList.toggle("hidden", !open);
  byId("mobileMenu").setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("nav-open", open);
}

function setDesktopSidebarCollapsed(collapsed) {
  if (window.matchMedia("(max-width: 760px)").matches) return;
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const toggle = byId("desktopSidebarToggle");
  if (toggle) {
    toggle.setAttribute("aria-label", collapsed ? "展开侧边栏" : "收起侧边栏");
    toggle.setAttribute("title", collapsed ? "展开侧边栏" : "收起侧边栏");
    toggle.innerHTML = icon(collapsed ? "panel-left-open" : "panel-left-close", 17);
    refreshIcons();
  }
}

const capabilityDetails = {
  "document-storage": ["正式原始凭证上传", "需要开通对象存储、文件安全扫描和 OCR 服务，再建立订单、附件、凭证之间的版本化绑定关系。当前本地预览不会上传或保存。", "cloud-upload"],
  "approval-engine": ["审批引擎", "需要新增审批实例、节点、条件、会签、转交和审计数据模型。接入前，系统不会把任何订单伪装成已审批。", "stamp"],
  "inventory-ledger": ["库存台账", "需要商品、仓库、仓位、批次、盘点和成本计价数据模型。当前页面只按真实订单明细预览交收数量。", "warehouse"],
  "rule-editor": ["自动化规则编辑", "现有五条系统规则已经运行。在线修改需要财务权限、版本记录、影响预览、二次确认和审批后生效。", "workflow"],
  "expense-module": ["费用报销", "需要费用单、票据绑定、审批、付款和费用科目模板。当前可先用采购订单管理货款，但不会用订单冒充费用报销。", "receipt"],
  "auxiliary-dimensions": ["更多辅助核算维度", "客户和供应商维度已由真实订单生成；部门、员工、项目、自定义维度需要补充基础资料和凭证辅助字段。", "boxes"],
  "report-export": ["报表导出与打印", "需要配置导出权限、水印、审计日志和稳定的 PDF/Excel 模板。当前页面只提供在线查看与下钻。", "download"],
  "tax-export": ["税务申报接口", "当前草稿不会自动对外申报。需要企业税务基础设置、年度地区规则、授权复核和税务接口后才可导出或提交。", "landmark"],
  "tax-adjustments": ["纳税调整项目", "需要按年度配置税会差异、优惠、弥补亏损、折旧摊销和支持附件，并保留每次调整的复核记录。", "list-checks"]
};

function openCapabilityModal(key) {
  const [heading, message, iconName] = capabilityDetails[key] || ["能力接入状态", "该能力正在规划中，当前不会伪造处理结果。", "info"];
  byId("capabilityModalHeading").textContent = heading;
  byId("capabilityModalMessage").textContent = message;
  byId("capabilityModalIcon").innerHTML = icon(iconName, 24);
  openModal("capabilityModal");
  refreshIcons();
}

const focusableSelector = "button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

function visibleModals() {
  return [...document.querySelectorAll(".modal-backdrop:not(.hidden)")];
}

function syncModalAccessibility() {
  const modals = visibleModals();
  const top = modals.at(-1);
  byId("appShell").inert = Boolean(top);
  byId("loginScreen").inert = Boolean(top);
  modals.forEach((modal) => { modal.inert = modal !== top; });
  document.body.classList.toggle("modal-open", Boolean(top));
  return top;
}

function createModalFocusTarget(element = document.activeElement) {
  if (!(element instanceof HTMLElement)) return null;
  return {
    element,
    orderId: element.closest("[data-order-id]")?.dataset.orderId || ""
  };
}

function canReceiveFocus(element) {
  return element instanceof HTMLElement
    && element.isConnected
    && element.matches(focusableSelector)
    && !element.closest(".hidden")
    && !element.closest("[inert]")
    && element.getClientRects().length > 0;
}

function focusModalTarget(target) {
  if (canReceiveFocus(target?.element)) {
    target.element.focus();
    return true;
  }
  if (!target?.orderId) return false;
  const replacement = [...document.querySelectorAll("[data-order-id]")]
    .find((element) => element.dataset.orderId === target.orderId && canReceiveFocus(element));
  if (!replacement) return false;
  replacement.focus();
  return true;
}

function restoreModalFocus(target) {
  window.requestAnimationFrame(() => {
    if (focusModalTarget(target)) return;
    const top = visibleModals().at(-1);
    const fallback = top?.querySelector(focusableSelector)
      || document.querySelector(".view.active button:not([disabled]), .nav-item.active");
    if (canReceiveFocus(fallback)) fallback.focus();
  });
}

function openModal(id, { returnFocusTarget } = {}) {
  const backdrop = byId(id);
  const focusTarget = returnFocusTarget ?? createModalFocusTarget();
  state.modalReturnFocus.delete(id);
  if (focusTarget) state.modalReturnFocus.set(id, focusTarget);
  backdrop.classList.remove("hidden");
  backdrop.setAttribute("aria-hidden", "false");
  backdrop.querySelector(".modal")?.scrollTo({ top: 0 });
  syncModalAccessibility();
  refreshIcons();
  window.requestAnimationFrame(() => {
    const first = backdrop.querySelector("input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])");
    first?.focus();
  });
}

function isModalBusy(id) {
  return byId(id)?.dataset.busy === "true";
}

function setModalBusy(id, busy) {
  const backdrop = byId(id);
  if (!backdrop) return;
  backdrop.dataset.busy = String(busy);
  if (busy) backdrop.setAttribute("aria-busy", "true");
  else backdrop.removeAttribute("aria-busy");

  if (busy) {
    backdrop.querySelectorAll("button, input, select, textarea").forEach((control) => {
      if (!control.disabled) {
        control.dataset.modalBusyDisabled = "true";
        control.disabled = true;
      }
    });
    return;
  }

  backdrop.querySelectorAll('[data-modal-busy-disabled="true"]').forEach((control) => {
    control.disabled = false;
    delete control.dataset.modalBusyDisabled;
  });
}

function closeModal(id, { restoreFocus = true, force = false } = {}) {
  const backdrop = byId(id);
  if (!backdrop) return null;
  if (isModalBusy(id) && !force) {
    showToast("正在处理，请稍候");
    return null;
  }
  setModalBusy(id, false);
  backdrop.classList.add("hidden");
  backdrop.setAttribute("aria-hidden", "true");
  if (id === "passwordModal") byId("passwordForm").reset();
  if (id === "orderModal") {
    state.editingOrderId = "";
    state.editingOrderVersion = 0;
  }
  if (id === "detailModal") {
    state.detailOrderId = "";
    state.detailOrder = null;
  }
  const returnFocus = state.modalReturnFocus.get(id);
  state.modalReturnFocus.delete(id);
  syncModalAccessibility();
  if (restoreFocus) restoreModalFocus(returnFocus);
  return returnFocus;
}

function modalOptionsAfterClosingSourceModal() {
  for (const modalId of ["detailModal", "paymentQueueModal"]) {
    if (!byId(modalId).classList.contains("hidden")) {
      return { returnFocusTarget: closeModal(modalId, { restoreFocus: false }) };
    }
  }
  return {};
}

function compatiblePartners(direction) {
  return state.data.partners.filter((partner) => partner.kind === "both" || (direction === "receivable" ? partner.kind === "customer" : partner.kind === "supplier"));
}

function populatePartnerOptions() {
  const select = byId("orderPartner");
  const partners = compatiblePartners(state.orderDirection);
  select.replaceChildren(...partners.map((partner) => {
    const option = document.createElement("option");
    option.value = partner.id;
    option.textContent = partner.name;
    return option;
  }));
  return partners.length;
}

function generateOrderNo(direction) {
  const digits = toDateInputValue(new Date(), tenantTimeZone()).replaceAll("-", "");
  const stem = direction === "payable" ? `SY-P${digits}-` : `SY-${digits}-`;
  const sequences = state.data.orders.map((order) => order.orderNo).filter((orderNo) => orderNo.startsWith(stem)).map((orderNo) => Number(orderNo.slice(stem.length))).filter(Number.isInteger);
  return `${stem}${String(Math.max(0, ...sequences) + 1).padStart(3,"0")}`;
}

function openOrderModal(direction = "receivable") {
  if (!roleCan(state.data.role, "createOrder")) return showToast("当前角色没有新建订单权限", "error");
  state.editingOrderId = "";
  state.editingOrderVersion = 0;
  state.orderDirection = direction;
  byId("orderForm").reset();
  byId("correctionReasonField").classList.add("hidden");
  byId("correctionReason").required = false;
  byId("correctionWarning").classList.add("hidden");
  byId("editFulfilledAtField").classList.add("hidden");
  byId("editFulfilledAt").required = false;
  byId("orderPartner").disabled = false;
  byId("orderCurrency").disabled = false;
  byId("orderSubmitButton").querySelector("span").textContent = "保存订单";
  const orderDate = toDateInputValue(new Date(), tenantTimeZone());
  byId("orderDate").value = orderDate;
  byId("plannedDeliveryDate").value = addDaysToDateInput(orderDate, 2);
  byId("orderNumber").value = generateOrderNo(direction);
  byId("settlementCycle").value = "days:30";
  byId("customSettlementField").classList.add("hidden");
  document.querySelectorAll(".direction-tab").forEach((tab) => {
    const active = tab.dataset.direction === direction;
    tab.disabled = false;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  byId("orderModalTitle").textContent = direction === "receivable" ? "新建销售订单" : "新建采购订单";
  if (!populatePartnerOptions()) return showToast(direction === "receivable" ? "请先在后端添加客户" : "请先在后端添加供应商", "error");
  byId("lineItemsBody").replaceChildren();
  addLineItem();
  openModal("orderModal");
}

function addLineItem(item = {}) {
  const row = document.createElement("tr");
  row.innerHTML = `<td class="line-description" data-label="商品说明"><input class="line-name" maxlength="500" placeholder="商品名称、规格" dir="auto" required /></td><td data-label="数量"><input class="line-qty" type="number" min="1" step="1" value="1" required /></td><td data-label="单价"><input class="line-price" type="number" min="0.01" step="0.01" placeholder="0.00" required /></td><td class="line-subtotal amount-cell" data-label="小计">${moneyMarkup(0, byId("orderCurrency").value)}</td><td class="line-remove-cell"><button type="button" class="remove-line" aria-label="删除商品">${icon("trash-2",15)}</button></td>`;
  row.querySelector(".line-name").value = item.description || "";
  row.querySelector(".line-qty").value = item.quantity || 1;
  row.querySelector(".line-price").value = Number.isSafeInteger(item.unitPriceCents)
    ? (item.unitPriceCents / 100).toFixed(2)
    : "";
  row.querySelectorAll("input").forEach((input) => input.addEventListener("input", calculateOrderTotal));
  row.querySelector(".remove-line").addEventListener("click", () => {
    row.remove();
    calculateOrderTotal();
  });
  byId("lineItemsBody").appendChild(row);
  calculateOrderTotal();
  refreshIcons();
}

function settlementCycleForOrder(order) {
  if (order.settlementMonths > 0) {
    const value = `months:${order.settlementMonths}`;
    if (![...byId("settlementCycle").options].some((option) => option.value === value)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `交货后 ${order.settlementMonths} 个月`;
      byId("settlementCycle").add(option, byId("settlementCycle").querySelector('option[value="custom"]'));
    }
    return value;
  }
  if ([0, 7, 30].includes(order.settlementDays)) return `days:${order.settlementDays}`;
  return "custom";
}

function canCorrectOrder(order) {
  if (!order || order.fulfillmentStatus === "cancelled" || !roleCan(state.data.role, "correctOrder")) return false;
  return order.fulfillmentStatus !== "fulfilled" || state.data.role === "owner" || state.data.role === "finance";
}

async function openOrderCorrection(orderId) {
  let order = detailedOrderById(orderId);
  if (!order) {
    try {
      const payload = await apiRequest(`/api/orders/${encodeURIComponent(orderId)}`, { busyText: "正在读取订单" });
      order = normalizeOrder(payload.order);
    } catch (error) {
      showToast(error.message, "error");
      return;
    }
  }
  if (!canCorrectOrder(order)) return showToast("当前角色或订单状态不允许更正", "error");
  const modalOptions = modalOptionsAfterClosingSourceModal();
  state.editingOrderId = order.id;
  state.editingOrderVersion = order.version;
  state.orderDirection = order.direction;
  byId("orderForm").reset();
  byId("orderModalTitle").textContent = order.fulfillmentStatus === "fulfilled" ? "更正已交货订单" : "修改待交货订单";
  byId("orderSubmitButton").querySelector("span").textContent = "确认更正";
  byId("correctionReasonField").classList.remove("hidden");
  byId("correctionReason").required = true;
  byId("correctionWarning").classList.remove("hidden");
  byId("orderNumber").value = order.orderNo;
  byId("orderDate").value = order.orderDate;
  byId("plannedDeliveryDate").value = order.plannedDeliveryDate || "";
  byId("orderCurrency").value = order.currency;
  byId("orderNotes").value = order.notes || "";
  const cycle = settlementCycleForOrder(order);
  byId("settlementCycle").value = cycle;
  byId("customSettlementField").classList.toggle("hidden", cycle !== "custom");
  if (cycle === "custom") byId("customSettlementDays").value = order.settlementDays;
  document.querySelectorAll(".direction-tab").forEach((tab) => {
    const active = tab.dataset.direction === order.direction;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  populatePartnerOptions();
  byId("orderPartner").value = order.partnerId;
  const hasPaymentHistory = order.payments.length > 0;
  byId("orderPartner").disabled = hasPaymentHistory;
  byId("orderCurrency").disabled = hasPaymentHistory;
  document.querySelectorAll(".direction-tab").forEach((tab) => { tab.disabled = hasPaymentHistory; });
  const fulfilled = order.fulfillmentStatus === "fulfilled";
  byId("editFulfilledAtField").classList.toggle("hidden", !fulfilled);
  byId("editFulfilledAt").required = fulfilled;
  if (fulfilled) {
    const now = new Date();
    byId("editFulfilledAt").value = toDateTimeInputValue(new Date(order.fulfilledAt), tenantTimeZone());
    byId("editFulfilledAt").min = `${order.orderDate}T00:00`;
    byId("editFulfilledAt").max = toDateTimeInputValue(new Date(now.getTime() + 5 * 60 * 1000), tenantTimeZone());
  }
  byId("lineItemsBody").replaceChildren();
  order.items.forEach((item) => addLineItem(item));
  calculateOrderTotal();
  openModal("orderModal", modalOptions);
}

function calculateOrderTotal() {
  let totalCents = 0;
  const currency = byId("orderCurrency").value;
  document.querySelectorAll("#lineItemsBody tr").forEach((row) => {
    const quantity = Number(row.querySelector(".line-qty").value || 0);
    let unitPriceCents = 0;
    try { unitPriceCents = yuanToCents(row.querySelector(".line-price").value || "0"); } catch { unitPriceCents = 0; }
    const subtotal = Number.isInteger(quantity) && quantity > 0 ? quantity * unitPriceCents : 0;
    totalCents += Number.isSafeInteger(subtotal) ? subtotal : 0;
    row.querySelector(".line-subtotal").textContent = formatMoney(subtotal, currency);
  });
  byId("orderTotal").textContent = formatMoney(totalCents, currency);
  renderOrderImpactPreview(totalCents, currency);
}

function renderOrderImpactPreview(totalCents, currency) {
  const target = byId("orderImpactPreview");
  if (!target) return;
  const sale = state.orderDirection === "receivable";
  target.innerHTML = `<div class="order-impact-heading"><div><span class="impact-kicker">预计影响</span><strong>${sale ? "销售订单" : "采购订单"}保存后，系统下一步会做什么</strong></div><span>${formatMoney(totalCents, currency)}</span></div><div class="order-impact-steps"><div class="ready"><b>1</b><span><strong>保存业务订单</strong><small>自动编号，可人工修改</small></span></div><div class="waiting"><b>2</b><span><strong>补充原始凭证</strong><small>正式上传与绑定待接入</small></span></div><div class="waiting"><b>3</b><span><strong>业务审批</strong><small>审批引擎待接入</small></span></div><div class="ready"><b>4</b><span><strong>${sale ? "确认交货后增加应收并确认收入" : "确认收货后增加库存并形成应付"}</strong><small>${sale ? "应收账款 / 主营业务收入" : "库存商品 / 应付账款"}自动生成</small></span></div></div><p>普通用户无需选择借贷科目。交收未确认前，不会自动入账或开始账期。</p>`;
}

async function submitOrder(event) {
  event.preventDefault();
  const submit = event.submitter || byId("orderSubmitButton");
  const editingOrderId = state.editingOrderId;
  submit.disabled = true;
  setModalBusy("orderModal", true);
  try {
    const items = [...document.querySelectorAll("#lineItemsBody tr")].map((row) => ({
      description: row.querySelector(".line-name").value,
      quantity: row.querySelector(".line-qty").value,
      unitPrice: row.querySelector(".line-price").value
    }));
    const payload = buildCreateOrderPayload({
      partnerId: byId("orderPartner").value,
      orderNo: byId("orderNumber").value,
      direction: state.orderDirection,
      orderDate: byId("orderDate").value,
      plannedDeliveryDate: byId("plannedDeliveryDate").value,
      settlementCycle: byId("settlementCycle").value,
      customSettlementDays: byId("customSettlementDays").value,
      currency: byId("orderCurrency").value,
      notes: byId("orderNotes").value,
      items
    });
    if (!payload.partnerId || !payload.orderNo || !payload.orderDate) throw new Error("请补全订单必填信息");
    if (editingOrderId) {
      payload.version = state.editingOrderVersion;
      payload.reason = byId("correctionReason").value.trim();
      payload.fulfilledAt = byId("editFulfilledAtField").classList.contains("hidden")
        ? null
        : toIsoDateTime(byId("editFulfilledAt").value, tenantTimeZone());
      await apiRequest(`/api/orders/${encodeURIComponent(editingOrderId)}`, {
        method: "PATCH",
        body: payload,
        busyText: "正在保存订单更正"
      });
    } else {
      await apiRequest("/api/orders", { method: "POST", body: payload, busyText: "正在创建订单" });
    }
    closeModal("orderModal", { force: true });
    await loadBootstrap();
    setView("orders");
    if (editingOrderId) {
      await openDetail(editingOrderId);
      showToast("订单更正已保存，历史记录仍然保留", "success");
    } else {
      showToast("订单已创建，确认交货后才会进入结算");
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setModalBusy("orderModal", false);
    submit.disabled = false;
  }
}

function orderById(orderId) {
  return state.data.orders.find((order) => order.id === orderId);
}

function openFulfillModal(orderId) {
  const order = detailedOrderById(orderId) || orderById(orderId);
  if (!order || order.fulfillmentStatus !== "planned") return showToast("订单状态已变化，请刷新后重试", "error");
  if (!roleCan(state.data.role, "fulfill")) return showToast("当前角色没有确认交货权限", "error");
  const modalOptions = modalOptionsAfterClosingSourceModal();
  byId("fulfillOrderId").value = order.id;
  const fulfilledAtInput = byId("fulfilledAt");
  const now = new Date();
  fulfilledAtInput.value = toDateTimeInputValue(now, tenantTimeZone());
  fulfilledAtInput.min = `${String(order.orderDate).slice(0, 10)}T00:00`;
  fulfilledAtInput.max = toDateTimeInputValue(new Date(now.getTime() + 5 * 60 * 1000), tenantTimeZone());
  byId("fulfillContext").innerHTML = `<strong dir="auto">${escapeHtml(order.partnerName)} · ${escapeHtml(order.orderNo)}</strong><span>${moneyMarkup(order.totalCents,order.currency)} · ${escapeHtml(settlementLabel(order))}</span>`;
  openModal("fulfillModal", modalOptions);
}

async function submitFulfillment(event) {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  setModalBusy("fulfillModal", true);
  try {
    const orderId = byId("fulfillOrderId").value;
    await apiRequest(`/api/orders/${encodeURIComponent(orderId)}/fulfill`, {
      method: "POST",
      body: { fulfilledAt: toIsoDateTime(byId("fulfilledAt").value, tenantTimeZone()) },
      busyText: "正在确认交货"
    });
    await loadBootstrap();
    closeModal("fulfillModal", { force: true });
    showToast("已确认交货，订单已进入结算");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setModalBusy("fulfillModal", false);
    submit.disabled = false;
  }
}

function makeIdempotencyKey(orderId) {
  const random = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `web-payment-${orderId}-${random}`.slice(0,128);
}

function makeReversalIdempotencyKey(paymentId) {
  const random = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `web-reversal-${paymentId}-${random}`.slice(0,128);
}

function eligiblePaymentOrders() {
  const rank = { overdue: 0, today: 1, upcoming: 2, later: 3 };
  const search = state.paymentQueueSearch.toLowerCase();
  return state.data.orders
    .filter((order) => order.fulfillmentStatus === "fulfilled" && order.outstandingCents > 0)
    .filter((order) => !search || `${order.partnerName}${order.orderNo}`.toLowerCase().includes(search))
    .sort((left, right) => {
      const bucketDifference = rank[dueBucket(left.dueAt)] - rank[dueBucket(right.dueAt)];
      if (bucketDifference) return bucketDifference;
      return String(left.dueAt).localeCompare(String(right.dueAt));
    });
}

function renderPaymentQueue() {
  const orders = eligiblePaymentOrders();
  byId("paymentQueueCount").textContent = `${orders.length} 笔待结算`;
  byId("paymentQueueList").innerHTML = orders.length ? orders.map((order) => `<div class="payment-queue-row" data-order-id="${escapeAttr(order.id)}">
    <span class="feed-symbol ${order.direction}">${icon(order.direction === "receivable" ? "arrow-down-left" : "arrow-up-right", 15)}</span>
    <div class="payment-queue-copy"><strong dir="auto">${escapeHtml(order.partnerName)}</strong><span dir="auto">${escapeHtml(order.orderNo)} · ${escapeHtml(settlementLabel(order))}</span></div>
    <div class="payment-queue-due"><span>${escapeHtml(formatDate(order.dueAt))}</span><small class="${dueBucket(order.dueAt) === "overdue" ? "overdue-text" : ""}">${escapeHtml(dueBucket(order.dueAt) === "overdue" ? `已逾期 ${Math.abs(daysBetweenDateInputs(tenantDate(new Date()), tenantDate(order.dueAt)))} 天` : dueBucket(order.dueAt) === "today" ? "今天到期" : "待结算")}</small></div>
    <strong class="payment-queue-amount">${moneyMarkup(order.outstandingCents, order.currency)}</strong>
    <button class="primary-button small-button" data-action="open-payment" data-order-id="${escapeAttr(order.id)}">登记${order.direction === "receivable" ? "收款" : "付款"}</button>
  </div>`).join("") : emptyState(state.paymentQueueSearch ? "没有匹配的待结算订单" : "当前没有待结算订单", "circle-check");
  refreshIcons();
}

function openPaymentQueueModal() {
  if (!roleCan(state.data.role, "payment")) return showToast("只有负责人或财务可以登记收付款", "error");
  state.paymentQueueSearch = "";
  byId("paymentQueueSearch").value = "";
  renderPaymentQueue();
  openModal("paymentQueueModal");
  window.setTimeout(() => byId("paymentQueueSearch").focus(), 0);
}

function openPaymentModal(orderId) {
  const order = detailedOrderById(orderId) || orderById(orderId);
  if (!order || order.fulfillmentStatus !== "fulfilled" || order.outstandingCents <= 0) return showToast("这笔订单当前不能登记收付款", "error");
  if (!roleCan(state.data.role, "payment")) return showToast("只有负责人或财务可以登记收付款", "error");
  const modalOptions = modalOptionsAfterClosingSourceModal();
  byId("paymentForm").reset();
  byId("paymentOrderId").value = order.id;
  byId("paymentIdempotencyKey").value = makeIdempotencyKey(order.id);
  byId("paymentAmount").value = (order.outstandingCents / 100).toFixed(2);
  byId("paymentAmount").max = (order.outstandingCents / 100).toFixed(2);
  byId("paymentDate").value = toDateTimeInputValue(new Date(), tenantTimeZone());
  byId("paymentModalTitle").textContent = order.direction === "receivable" ? "登记收款" : "登记付款";
  byId("paymentContext").innerHTML = `<strong dir="auto">${escapeHtml(order.partnerName)} · ${escapeHtml(order.orderNo)}</strong><div class="payment-summary-grid"><span><small>订单总额</small><b>${moneyMarkup(order.totalCents,order.currency)}</b></span><span><small>已结金额</small><b>${moneyMarkup(order.paidCents,order.currency)}</b></span><span class="remaining"><small>剩余金额</small><b>${moneyMarkup(order.outstandingCents,order.currency)}</b></span></div>`;
  openModal("paymentModal", modalOptions);
}

async function submitPayment(event) {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  setModalBusy("paymentModal", true);
  try {
    const orderId = byId("paymentOrderId").value;
    const amountCents = yuanToCents(byId("paymentAmount").value);
    const displayedOutstandingCents = yuanToCents(byId("paymentAmount").max || "0");
    if (amountCents <= 0 || amountCents > displayedOutstandingCents) throw new Error("金额必须大于 0，且不能超过未结金额");
    const result = await apiRequest(`/api/orders/${encodeURIComponent(orderId)}/payments`, {
      method: "POST",
      headers: { "Idempotency-Key": byId("paymentIdempotencyKey").value },
      body: {
        amountCents,
        method: byId("paymentMethod").value,
        paidAt: toIsoDateTime(byId("paymentDate").value, tenantTimeZone()),
        note: byId("paymentNote").value.trim() || null
      },
      busyText: "正在登记收付款"
    });
    await loadBootstrap();
    closeModal("paymentModal", { force: true });
    showToast(result.idempotentReplay ? "该笔记录已存在，已返回原付款" : "收付款已登记");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setModalBusy("paymentModal", false);
    submit.disabled = false;
  }
}

function detailedOrderById(orderId) {
  return state.detailOrder?.id === orderId ? state.detailOrder : null;
}

async function refreshDetailIfOpen(orderId) {
  if (state.detailOrderId !== orderId || byId("detailModal").classList.contains("hidden")) return;
  await openDetail(orderId, { showLoading: false });
}

function openReversalModal(orderId, paymentId) {
  if (!roleCan(state.data.role, "reversePayment")) {
    return showToast("只有负责人或财务可以冲销收付款", "error");
  }
  const order = detailedOrderById(orderId);
  const payment = order?.payments.find((item) => item.id === paymentId);
  if (!order || !payment) return showToast("付款详情已变化，请刷新订单后重试", "error");
  if (payment.reversedAt) return showToast("该笔收付款已经冲销", "error");
  byId("reversalForm").reset();
  byId("reversalPaymentId").value = payment.id;
  byId("reversalOrderId").value = order.id;
  byId("reversalIdempotencyKey").value = makeReversalIdempotencyKey(payment.id);
  byId("reversalContext").innerHTML = `<strong dir="auto">${escapeHtml(order.partnerName)} · ${escapeHtml(order.orderNo)}</strong><span>${moneyMarkup(payment.amountCents, order.currency)} · ${escapeHtml(paymentMethodLabels[payment.method] || payment.method)} · ${escapeHtml(formatDate(payment.paidAt, { time: true }))}</span>`;
  openModal("reversalModal");
  window.setTimeout(() => byId("reversalReason").focus(), 0);
}

async function submitReversal(event) {
  event.preventDefault();
  const submit = event.submitter;
  const paymentId = byId("reversalPaymentId").value;
  const orderId = byId("reversalOrderId").value;
  const reason = byId("reversalReason").value.trim();
  submit.disabled = true;
  setModalBusy("reversalModal", true);
  try {
    if (!reason) throw new Error("请填写冲销原因");
    const result = await apiRequest(`/api/payments/${encodeURIComponent(paymentId)}/reverse`, {
      method: "POST",
      headers: { "Idempotency-Key": byId("reversalIdempotencyKey").value },
      body: { reason },
      busyText: "正在冲销收付款"
    });
    await loadBootstrap();
    await refreshDetailIfOpen(orderId);
    closeModal("reversalModal", { force: true });
    showToast(result.idempotentReplay ? "该笔冲销已处理，页面已刷新" : "收付款已冲销，余额与提醒已重新计算");
  } catch (error) {
    if (["PAYMENT_ALREADY_REVERSED", "NOT_FOUND"].includes(error.code)) {
      await loadBootstrap();
      await refreshDetailIfOpen(orderId);
      closeModal("reversalModal", { force: true });
    }
    showToast(error.message, "error");
  } finally {
    setModalBusy("reversalModal", false);
    submit.disabled = false;
  }
}

function openCancelOrderModal(orderId) {
  if (!roleCan(state.data.role, "cancelOrder")) return showToast("当前角色没有取消订单权限", "error");
  const order = detailedOrderById(orderId) || orderById(orderId);
  if (!order || order.fulfillmentStatus !== "planned") return showToast("只有待交货订单可以取消", "error");
  if (order.payments?.length) return showToast("已有收付款记录的订单不能取消", "error");
  byId("cancelOrderForm").reset();
  byId("cancelOrderId").value = order.id;
  byId("cancelOrderContext").innerHTML = `<strong dir="auto">${escapeHtml(order.partnerName)} · ${escapeHtml(order.orderNo)}</strong><span>${moneyMarkup(order.totalCents, order.currency)} · 计划交货 ${escapeHtml(formatDate(order.plannedDeliveryDate))}</span>`;
  openModal("cancelOrderModal");
}

async function submitOrderCancellation(event) {
  event.preventDefault();
  const submit = event.submitter;
  const orderId = byId("cancelOrderId").value;
  submit.disabled = true;
  setModalBusy("cancelOrderModal", true);
  try {
    const result = await apiRequest(`/api/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: "POST",
      busyText: "正在取消订单"
    });
    await loadBootstrap();
    await refreshDetailIfOpen(orderId);
    closeModal("cancelOrderModal", { force: true });
    showToast(result.idempotentReplay ? "订单此前已取消，页面已刷新" : "订单已取消");
  } catch (error) {
    if (["ORDER_NOT_PLANNED", "ORDER_HAS_PAYMENTS", "NOT_FOUND"].includes(error.code)) {
      await loadBootstrap();
      await refreshDetailIfOpen(orderId);
      closeModal("cancelOrderModal", { force: true });
    }
    showToast(error.message, "error");
  } finally {
    setModalBusy("cancelOrderModal", false);
    submit.disabled = false;
  }
}

async function acknowledgeReminder(reminderId, button) {
  button.disabled = true;
  try {
    await apiRequest(`/api/reminders/${encodeURIComponent(reminderId)}/ack`, { method: "POST", busyText: "正在确认提醒" });
    await loadBootstrap();
    showToast("已知晓，服务器会在明天继续提醒未结账款");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function openSnoozeModal(reminderId) {
  if (!state.data.reminders.some((reminder) => reminder.id === reminderId)) return showToast("提醒已变化，请刷新后重试", "error");
  byId("snoozeReminderId").value = reminderId;
  byId("snoozeUntil").value = tomorrowNineValue();
  openModal("snoozeModal");
}

async function submitSnooze(event) {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  setModalBusy("snoozeModal", true);
  try {
    const reminderId = byId("snoozeReminderId").value;
    await apiRequest(`/api/reminders/${encodeURIComponent(reminderId)}/snooze`, {
      method: "POST",
      body: { until: toIsoDateTime(byId("snoozeUntil").value, tenantTimeZone()) },
      busyText: "正在暂缓提醒"
    });
    closeModal("snoozeModal", { force: true });
    await loadBootstrap();
    showToast("提醒已暂缓");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setModalBusy("snoozeModal", false);
    submit.disabled = false;
  }
}

function openPartnerModal(partnerId = "") {
  if (!roleCan(state.data.role, "partner")) return showToast("当前角色没有维护往来单位的权限", "error");
  const partner = partnerId ? state.data.partners.find((item) => item.id === partnerId) : null;
  if (partnerId && !partner) return showToast("往来单位已变化，请刷新后重试", "error");
  byId("partnerForm").reset();
  byId("partnerId").value = partner?.id || "";
  byId("partnerVersion").value = partner?.version || "";
  byId("partnerName").value = partner?.name || "";
  byId("partnerKind").value = partner?.kind || "customer";
  byId("partnerContactName").value = partner?.contactName || "";
  byId("partnerPhone").value = partner?.phone || "";
  byId("partnerModalTitle").textContent = partner ? "编辑往来单位" : "新增往来单位";
  openModal("partnerModal");
  window.setTimeout(() => byId("partnerName").focus(), 0);
}

async function submitPartner(event) {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  setModalBusy("partnerModal", true);
  const partnerId = byId("partnerId").value;
  const basePayload = {
    name: byId("partnerName").value.trim(),
    kind: byId("partnerKind").value,
    contactName: byId("partnerContactName").value.trim() || null,
    phone: byId("partnerPhone").value.trim() || null
  };
  try {
    if (!basePayload.name) throw new Error("请填写往来单位名称");
    if (partnerId) {
      await apiRequest(`/api/partners/${encodeURIComponent(partnerId)}`, {
        method: "PATCH",
        body: { version: Number(byId("partnerVersion").value), ...basePayload },
        busyText: "正在更新往来单位"
      });
    } else {
      await apiRequest("/api/partners", { method: "POST", body: basePayload, busyText: "正在新增往来单位" });
    }
    closeModal("partnerModal", { force: true });
    await loadBootstrap();
    setView("contacts", false);
    showToast(partnerId ? "往来单位已更新" : "往来单位已新增，现在可以创建订单");
  } catch (error) {
    if (error.code === "PARTNER_VERSION_CONFLICT") {
      closeModal("partnerModal", { force: true });
      await loadBootstrap();
      setView("contacts", false);
      showToast("该往来单位已被其他成员更新，页面已刷新", "error");
    } else {
      showToast(error.message, "error");
    }
  } finally {
    setModalBusy("partnerModal", false);
    submit.disabled = false;
  }
}

function openPasswordModal() {
  byId("passwordForm").reset();
  openModal("passwordModal");
  window.setTimeout(() => byId("currentPassword").focus(), 0);
}

async function submitPasswordChange(event) {
  event.preventDefault();
  const submit = event.submitter;
  const currentPassword = byId("currentPassword").value;
  const newPassword = byId("newPassword").value;
  const confirmPassword = byId("confirmPassword").value;
  submit.disabled = true;
  setModalBusy("passwordModal", true);
  try {
    if (newPassword.length < 12) throw new Error("新密码至少需要 12 位");
    if (newPassword !== confirmPassword) throw new Error("两次输入的新密码不一致");
    await apiRequest("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword, newPassword },
      busyText: "正在修改密码"
    });
    byId("passwordForm").reset();
    closeModal("passwordModal", { force: true });
    showToast("密码已修改，其他设备会话已撤销");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setModalBusy("passwordModal", false);
    submit.disabled = false;
  }
}

function detailActionMarkup(order) {
  const safeOrderId = escapeAttr(order.id);
  const actions = [statusBadge(order)];
  if (canCorrectOrder(order)) {
    actions.push(`<button class="outline-button small-button" data-action="correct-order" data-order-id="${safeOrderId}">${icon("history", 14)}更正订单</button>`);
  }
  if (order.fulfillmentStatus === "planned" && roleCan(state.data.role, "fulfill")) {
    actions.push(`<button class="primary-button small-button" data-action="open-fulfill" data-order-id="${safeOrderId}">${icon("package-check", 14)}确认交货</button>`);
  }
  if (order.fulfillmentStatus === "planned" && roleCan(state.data.role, "cancelOrder")) {
    actions.push(order.payments.length
      ? `<button class="outline-button small-button cancel-detail-button" type="button" disabled title="已有收付款记录，不能取消">${icon("ban", 14)}取消订单</button>`
      : `<button class="outline-button small-button cancel-detail-button" type="button" data-action="open-cancel-order" data-order-id="${safeOrderId}">${icon("ban", 14)}取消订单</button>`);
  }
  if (order.fulfillmentStatus === "fulfilled" && order.outstandingCents > 0 && roleCan(state.data.role, "payment")) {
    actions.push(`<button class="primary-button small-button" data-action="open-payment" data-order-id="${safeOrderId}">${icon("wallet-cards", 14)}${order.direction === "receivable" ? "登记收款" : "登记付款"}</button>`);
  }
  return actions.join("");
}

const correctionFieldLabels = {
  partnerId: "往来单位",
  orderNo: "订单编号",
  direction: "收付方向",
  orderDate: "订货日期",
  plannedDeliveryDate: "计划交货日期",
  fulfilledAt: "实际交货时间",
  settlementDays: "账期天数",
  settlementMonths: "账期月数",
  dueAt: "到期时间",
  currency: "币种",
  totalCents: "订单金额",
  notes: "备注",
  items: "商品明细"
};

function correctionHistoryMarkup(order) {
  if (!order.corrections.length) return "";
  return `<section class="correction-history"><div class="line-items-heading"><div><h3>订单更正记录</h3><span>${order.corrections.length} 次 · 更正前后快照不可修改</span></div></div><div class="correction-list">${order.corrections.map((correction) => `<div class="correction-row"><span class="correction-symbol">${icon("history", 15)}</span><div><strong dir="auto">${escapeHtml(correction.reason)}</strong><span>${escapeHtml(correction.correctedByName)} · ${escapeHtml(formatDate(correction.createdAt, { time: true }))} · 版本 ${correction.fromVersion} → ${correction.toVersion}</span><small>${correction.changedFields.map((field) => escapeHtml(correctionFieldLabels[field] || field)).join("、")}</small></div></div>`).join("")}</div></section>`;
}

function paymentHistoryMarkup(order) {
  if (!order.payments.length) return emptyState("尚未登记收付款", "wallet-cards");
  return order.payments.map((payment) => {
    const reversed = Boolean(payment.reversedAt);
    const safePaymentId = escapeAttr(payment.id);
    const safeOrderId = escapeAttr(order.id);
    const reversalDetail = reversed
      ? `<div class="payment-reversal-detail"><strong>已于 ${escapeHtml(formatDate(payment.reversedAt, { time: true }))} 冲销</strong><p dir="auto">${escapeHtml(payment.reversalReason || "未填写冲销原因")}</p></div>`
      : "";
    const reverseAction = !reversed && roleCan(state.data.role, "reversePayment")
      ? `<button class="reverse-payment-button" type="button" data-action="open-reversal" data-order-id="${safeOrderId}" data-payment-id="${safePaymentId}">${icon("undo-2", 14)}冲销</button>`
      : "";
    return `<div class="payment-history-row ${reversed ? "is-reversed" : ""}"><div><div class="payment-amount-line"><strong>${moneyMarkup(payment.amountCents, order.currency)}</strong>${reversed ? `<span class="status-badge overdue">已冲销</span>` : ""}</div><span>${escapeHtml(paymentMethodLabels[payment.method] || payment.method || "未记录方式")} · ${escapeHtml(formatDate(payment.paidAt, { time: true }))}</span></div><div class="payment-note"><p dir="auto">${escapeHtml(payment.note || "无备注")}</p>${reversalDetail}</div><div class="payment-row-actions">${reverseAction}</div></div>`;
  }).join("");
}

function orderBusinessChainMarkup(order) {
  const delivered = order.fulfillmentStatus === "fulfilled";
  const cancelled = order.fulfillmentStatus === "cancelled";
  const settled = order.settlementStatus === "settled";
  const partial = order.settlementStatus === "partial";
  const deliveryAction = !cancelled && !delivered && roleCan(state.data.role, "fulfill")
    ? `data-action="open-fulfill" data-order-id="${escapeAttr(order.id)}"`
    : `data-view="inventory"`;
  const paymentAction = delivered && order.outstandingCents > 0 && roleCan(state.data.role, "payment")
    ? `data-action="open-payment" data-order-id="${escapeAttr(order.id)}"`
    : `data-view="${order.direction}"`;
  const steps = [
    { state: "complete", icon: "notebook-check", label: "订单", detail: "已录入", action: `data-view="orders"` },
    { state: "unavailable", icon: "paperclip", label: "原始凭证", detail: "待接入", action: `data-view="evidence"` },
    { state: "unavailable", icon: "stamp", label: "审批", detail: "待接入", action: `data-view="approvals"` },
    { state: cancelled ? "blocked" : delivered ? "complete" : "pending", icon: delivered ? "package-check" : "package-open", label: order.direction === "receivable" ? "交货" : "收货", detail: cancelled ? "已取消" : delivered ? "已确认" : "待确认", action: deliveryAction },
    { state: delivered ? "complete" : "pending", icon: "receipt-text", label: "自动凭证", detail: delivered ? "已生成" : "等待交收", action: `data-view="accounting"` },
    { state: settled ? "complete" : partial ? "partial" : "pending", icon: "wallet-cards", label: order.direction === "receivable" ? "收款" : "付款", detail: settled ? "已结清" : partial ? "部分结算" : delivered ? "待登记" : "等待交收", action: paymentAction },
    { state: delivered ? "complete" : "pending", icon: "chart-no-axes-combined", label: "账簿报表", detail: delivered ? "已更新" : "等待凭证", action: `data-view="reports"` }
  ];
  return `<section class="business-chain"><div class="business-chain-heading"><div><h3>业务到财务全链路</h3><span>点击节点可查看对应来源或结果</span></div><span class="status-badge ${delivered ? "settled" : "pending"}">${delivered ? "财务链已触发" : "等待交收"}</span></div><div class="business-chain-track">${steps.map((step, index) => `<button type="button" class="business-chain-step ${step.state}" ${step.action}><span class="chain-icon">${icon(step.icon,17)}</span><span><strong>${index + 1}. ${step.label}</strong><small>${step.detail}</small></span>${icon("chevron-right",14)}</button>`).join("")}</div><p class="business-chain-note">现阶段“确认交收”会真实触发应收/应付和自动凭证；附件、审批和正式库存仍明确标记为待接入。</p></section>`;
}

function renderOrderDetail(order) {
  const fulfillmentMeta = order.fulfillmentStatus === "fulfilled"
    ? `实际交货 ${escapeHtml(formatDate(order.fulfilledAt, { time: true }))}`
    : order.fulfillmentStatus === "cancelled"
      ? `订单已取消 · 原计划交货 ${escapeHtml(formatDate(order.plannedDeliveryDate))}`
      : `计划交货 ${escapeHtml(formatDate(order.plannedDeliveryDate))}`;
  byId("detailTitle").textContent = order.partnerName;
  byId("detailContent").innerHTML = `
    <div class="detail-summary">
      <div class="detail-stat"><span>订单编号</span><strong dir="auto">${escapeHtml(order.orderNo)}</strong></div>
      <div class="detail-stat"><span>订单总额</span><strong>${moneyMarkup(order.totalCents, order.currency)}</strong></div>
      <div class="detail-stat"><span>有效结算</span><strong>${moneyMarkup(order.paidCents, order.currency)}</strong></div>
      <div class="detail-stat"><span>未结金额</span><strong class="${order.outstandingCents ? "danger-text" : "accent-text"}">${moneyMarkup(order.outstandingCents, order.currency)}</strong></div>
    </div>
    <div class="detail-body">
      <div class="table-toolbar"><div><h3>${order.direction === "receivable" ? "客户应收订单" : "供应商应付订单"}</h3><div class="ledger-meta">${escapeHtml(settlementLabel(order))} · ${fulfillmentMeta}</div></div><div class="heading-actions">${detailActionMarkup(order)}</div></div>
      ${orderBusinessChainMarkup(order)}
      ${order.notes ? `<div class="order-notes"><span>订单备注</span><p dir="auto">${escapeHtml(order.notes)}</p></div>` : ""}
      <div class="data-table-wrap"><table class="data-table detail-items-table"><thead><tr><th>商品说明</th><th>数量</th><th>单价</th><th>小计</th></tr></thead><tbody>${order.items.length ? order.items.map((item) => `<tr><td class="detail-item-name" data-label="商品说明" dir="auto">${escapeHtml(item.description)}</td><td data-label="数量">${item.quantity}</td><td class="amount-cell" data-label="单价">${moneyMarkup(item.unitPriceCents, order.currency)}</td><td class="amount-cell detail-item-subtotal" data-label="小计">${moneyMarkup(item.lineTotalCents, order.currency)}</td></tr>`).join("") : `<tr><td colspan="4">${emptyState("没有商品明细")}</td></tr>`}</tbody></table></div>
      ${correctionHistoryMarkup(order)}
      <section class="payment-history"><div class="line-items-heading"><div><h3>收付款记录</h3><span>${order.payments.length} 笔 · 原付款与冲销记录均保留</span></div></div>${paymentHistoryMarkup(order)}</section>
    </div>`;
}

async function openDetail(orderId, { showLoading = true } = {}) {
  const summary = orderById(orderId);
  if (!summary) return;
  state.detailOrderId = orderId;
  byId("detailTitle").textContent = summary.partnerName;
  if (showLoading) byId("detailContent").innerHTML = `<div class="detail-loading">${icon("loader-circle",24)}<span>正在读取订单详情</span></div>`;
  if (byId("detailModal").classList.contains("hidden")) openModal("detailModal");
  try {
    const payload = await apiRequest(`/api/orders/${encodeURIComponent(orderId)}`, { busyText: "正在读取订单详情" });
    const order = normalizeOrder(payload.order);
    if (byId("detailModal").classList.contains("hidden") || state.detailOrderId !== orderId) return;
    state.detailOrder = order;
    renderOrderDetail(order);
    refreshIcons();
  } catch (error) {
    byId("detailContent").replaceChildren();
    const errorBox = document.createElement("div");
    errorBox.className = "empty-state";
    errorBox.textContent = error.message;
    byId("detailContent").appendChild(errorBox);
  }
}

function rerenderOrderTables() {
  const ordersRows = byId("ordersRows");
  if (ordersRows) ordersRows.innerHTML = renderOrderRows(filteredAllOrders());
  for (const direction of ["receivable","payable"]) {
    const rows = byId(`${direction}Rows`);
    if (rows) rows.innerHTML = renderOrderRows(filteredLedgerOrders(direction));
  }
  refreshIcons();
}

function bindEvents() {
  byId("loginForm").addEventListener("submit", login);
  byId("smsLoginForm").addEventListener("submit", loginWithSms);
  byId("smsCodeSend").addEventListener("click", requestSmsCode);
  byId("smsLoginPhone").addEventListener("input", (event) => {
    if (state.smsChallengeId && event.currentTarget.value.trim() !== state.smsChallengePhone) {
      resetSmsChallenge("手机号已更改，请重新获取验证码");
    }
  });
  for (const tab of [byId("passwordLoginTab"), byId("smsLoginTab")]) {
    tab.addEventListener("click", () => setAuthMode(tab.id === "smsLoginTab" ? "sms" : "password"));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const smsMode = event.key === "ArrowRight" || event.key === "End";
      setAuthMode(smsMode ? "sms" : "password", { focus: false });
      byId(smsMode ? "smsLoginTab" : "passwordLoginTab").focus();
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.smsCountdownEndsAt) updateSmsCountdown();
  });
  byId("logoutButton").addEventListener("click", (event) => logout(event.currentTarget));
  byId("mobileMenu").addEventListener("click", () => setSidebarOpen(!byId("sidebar").classList.contains("open")));
  byId("desktopSidebarToggle")?.addEventListener("click", () => setDesktopSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed")));
  byId("sidebarClose").addEventListener("click", () => setSidebarOpen(false));
  byId("sidebarScrim").addEventListener("click", () => setSidebarOpen(false));
  byId("globalSearchButton").addEventListener("click", () => { setView("orders"); byId("ordersSearch")?.focus(); });
  byId("refreshButton").addEventListener("click", async () => {
    try { await loadBootstrap({ announce: true }); } catch (error) { showToast(error.message,"error"); }
  });
  byId("orderForm").addEventListener("submit", submitOrder);
  byId("fulfillForm").addEventListener("submit", submitFulfillment);
  byId("paymentForm").addEventListener("submit", submitPayment);
  byId("reversalForm").addEventListener("submit", submitReversal);
  byId("cancelOrderForm").addEventListener("submit", submitOrderCancellation);
  byId("snoozeForm").addEventListener("submit", submitSnooze);
  byId("partnerForm").addEventListener("submit", submitPartner);
  byId("passwordForm").addEventListener("submit", submitPasswordChange);
  byId("memberForm").addEventListener("submit", submitMember);
  byId("invitationForm").addEventListener("submit", acceptInvitation);
  byId("addLineItem").addEventListener("click", addLineItem);
  byId("orderCurrency").addEventListener("change", calculateOrderTotal);
  byId("settlementCycle").addEventListener("change", (event) => byId("customSettlementField").classList.toggle("hidden", event.target.value !== "custom"));
  byId("paymentForm").addEventListener("input", (event) => {
    if (event.target.id === "paymentIdempotencyKey" || !byId("paymentOrderId").value) return;
    byId("paymentIdempotencyKey").value = makeIdempotencyKey(byId("paymentOrderId").value);
  });
  document.querySelectorAll(".direction-tab").forEach((button) => button.addEventListener("click", () => {
    state.orderDirection = button.dataset.direction;
    document.querySelectorAll(".direction-tab").forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-pressed", String(active));
    });
    byId("orderModalTitle").textContent = state.editingOrderId
      ? byId("editFulfilledAtField").classList.contains("hidden") ? "修改待交货订单" : "更正已交货订单"
      : state.orderDirection === "receivable" ? "新建销售订单" : "新建采购订单";
    if (!state.editingOrderId) byId("orderNumber").value = generateOrderNo(state.orderDirection);
    populatePartnerOptions();
    calculateOrderTotal();
  }));

  document.addEventListener("click", async (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      event.preventDefault();
      const fromDetail = Boolean(viewButton.closest("#detailModal"));
      setView(viewButton.dataset.view);
      if (fromDetail) closeModal("detailModal");
    }
    const closeButton = event.target.closest("[data-close]");
    if (closeButton) closeModal(closeButton.dataset.close);
    if (event.target.classList.contains("modal-backdrop")) closeModal(event.target.id);

    const action = event.target.closest("[data-action]");
    if (action) {
      const type = action.dataset.action;
      if (type === "fill-test-account") { byId("loginPhone").value = "13800000000"; byId("loginPassword").value = "demo1234"; }
      if (type === "new-order") openOrderModal(action.dataset.direction || "receivable");
      if (type === "new-partner") openPartnerModal();
      if (type === "edit-partner") openPartnerModal(action.dataset.partnerId);
      if (type === "contact-back") {
        state.contactDetailOpen = false;
        renderContactsView();
        window.requestAnimationFrame(() => document.querySelector(".contact-list-row.active")?.focus());
      }
      if (type === "choose-import-file") byId("importFileInput")?.click();
      if (type === "download-import-template") downloadImportTemplate();
      if (type === "start-import-preview") await requestImportPreview(1);
      if (type === "validate-import-mapping") await validateImportMapping();
      if (type === "import-back-upload") {
        state.importStage = 0;
        state.importError = "";
        state.importIdempotencyKey = "";
        renderImportView();
      }
      if (type === "import-back-mapping") {
        state.importStage = 1;
        state.importError = "";
        state.importIdempotencyKey = "";
        renderImportView();
      }
      if (type === "open-import-preview") {
        state.importStage = 3;
        state.importError = "";
        renderImportView();
      }
      if (type === "import-back-validation") {
        state.importStage = 2;
        state.importError = "";
        renderImportView();
      }
      if (type === "commit-import") await commitOrderImport();
      if (type === "reset-import") {
        resetImportWorkflow();
        renderImportView();
      }
      if (type === "view-imported-orders") setView("orders");
      if (type === "choose-ocr-file") byId("ocrFileInput")?.click();
      if (type === "ocr-manual-order") openOrderModal("receivable");
      if (type === "go-local-evidence") { setView("ocr"); showToast("当前为本地预览，文件不会上传或写入账务"); }
      if (type === "open-expense-capability") openCapabilityModal("expense-module");
      if (type === "open-smart-checks") setView("checks");
      if (type === "show-capability") openCapabilityModal(action.dataset.capability);
      if (type === "open-payment-queue") openPaymentQueueModal();
      if (type === "open-fulfill") openFulfillModal(action.dataset.orderId);
      if (type === "open-payment") openPaymentModal(action.dataset.orderId);
      if (type === "open-reversal") openReversalModal(action.dataset.orderId, action.dataset.paymentId);
      if (type === "open-cancel-order") openCancelOrderModal(action.dataset.orderId);
      if (type === "correct-order") await openOrderCorrection(action.dataset.orderId);
      if (type === "view-detail") openDetail(action.dataset.orderId);
      if (type === "ack-reminder") await acknowledgeReminder(action.dataset.reminderId, action);
      if (type === "open-snooze") openSnoozeModal(action.dataset.reminderId);
      if (type === "pending-notifications") showToast("微信、短信和电话通知服务待接入，不会模拟发送");
      if (type === "account-menu") setView("settings");
      if (type === "load-accounting") await loadAccountingData();
      if (type === "load-accounting-section") await loadAccountingSection(action.dataset.section);
      if (type === "close-accounting-period") await closeAccountingPeriod(action.dataset.periodId, action);
      if (type === "load-accounting-report") await loadAccountingReport(action.dataset.report);
      if (type === "refresh-smart-checks") await loadSmartChecks();
      if (type === "refresh-balances") await loadBalanceTable();
      if (type === "load-suite-report") await loadSuiteReport(action.dataset.report);
      if (type === "refresh-tax-draft") await loadTaxDraft();
      if (type === "refresh-period-close") await loadPeriodCloseView();
      if (type === "open-account-ledger") {
        setView("accounting");
        await loadAccountingSection("ledger", action.dataset.accountCode || "");
      }
      if (type === "open-aux-partner") {
        setView("contacts");
        selectContact(action.dataset.partnerId);
      }
      if (type === "change-password") openPasswordModal();
      if (type === "refresh-audit") await loadAudit({ force: true });
      if (type === "refresh-members") await loadMembers({ force: true });
      if (type === "refresh-notification-settings") await loadNotificationSettings({ force: true });
      if (type === "invite-member") openMemberModal();
      if (type === "toggle-member") await toggleMember(action.dataset.memberId, action.dataset.active === "true", action);
      if (type === "reinvite-member") await reinviteMember(action.dataset.memberId, action);
      if (type === "copy-invitation-link") await copyInvitationLink();
      if (type === "dismiss-invitation-link") {
        state.invitationUrl = "";
        state.invitationExpiresAt = "";
        renderSettingsView();
        refreshIcons();
      }
      if (type === "logout") await logout(action);
    }

    const contactRow = event.target.closest("[data-contact-select]");
    if (contactRow && !event.target.closest("button")) selectContact(contactRow.dataset.contactSelect);

    const row = event.target.closest("[data-order-id]");
    if (row && !event.target.closest("button") && !event.target.closest("input")) openDetail(row.dataset.orderId);

    const ledgerFilter = event.target.closest("[data-ledger-filter]");
    if (ledgerFilter) { state.ledgerFilters[ledgerFilter.dataset.direction] = ledgerFilter.dataset.ledgerFilter; renderLedgerView(ledgerFilter.dataset.direction); setView(ledgerFilter.dataset.direction,false); refreshIcons(); }

    const checkFilter = event.target.closest("[data-check-filter]");
    if (checkFilter) {
      state.smartCheckFilter = checkFilter.dataset.checkFilter || "all";
      renderSmartCheckResults();
    }

    const contactKind = event.target.closest("[data-contact-kind]");
    if (contactKind) {
      state.contactKind = contactKind.dataset.contactKind;
      state.contactDetailOpen = false;
      renderContactsView();
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "ordersSearch") { state.orderSearch = event.target.value.trim(); rerenderOrderTables(); }
    if (event.target.id === "paymentQueueSearch") { state.paymentQueueSearch = event.target.value.trim(); renderPaymentQueue(); }
    if (event.target.matches(".ledger-search")) { state.ledgerSearch[event.target.dataset.direction] = event.target.value.trim(); rerenderOrderTables(); }
    if (event.target.id === "inventorySearch") {
      state.inventorySearch = event.target.value;
      renderInventoryView({ restoreSearchFocus: true });
    }
    if (event.target.id === "contactSearch") {
      state.contactSearch = event.target.value;
      state.contactDetailOpen = false;
      renderContactsView({ restoreSearchFocus: true });
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.id === "taxRateInput") {
      const value = Number(event.target.value);
      state.taxRate = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 25;
      if (state.taxDraftPayload) renderTaxDraftPayload(state.taxDraftPayload);
      return;
    }
    const mappingSelect = event.target.closest("[data-import-mapping]");
    if (mappingSelect) {
      const columnNumber = Number(mappingSelect.value);
      if (Number.isInteger(columnNumber) && columnNumber > 0) state.importMapping[mappingSelect.dataset.importMapping] = columnNumber;
      else delete state.importMapping[mappingSelect.dataset.importMapping];
      state.importError = "";
      state.importIdempotencyKey = "";
      return;
    }
    const selectAll = event.target.closest("[data-import-select-all]");
    if (selectAll) {
      state.importSelectedRows = selectAll.checked
        ? state.importPreview.rows.filter((row) => row.valid).map((row) => Number(row.rowNumber))
        : [];
      state.importIdempotencyKey = "";
      updateImportSelectionControls();
      return;
    }
    const importRow = event.target.closest("[data-import-row]");
    if (importRow) {
      const rowNumber = Number(importRow.dataset.importRow);
      const selected = new Set(state.importSelectedRows);
      if (importRow.checked) selected.add(rowNumber);
      else selected.delete(rowNumber);
      state.importSelectedRows = [...selected].sort((left, right) => left - right);
      state.importIdempotencyKey = "";
      updateImportSelectionControls();
      return;
    }
    const memberRole = event.target.closest("[data-member-role]");
    if (memberRole) {
      void changeMemberRole(memberRole.dataset.memberRole, memberRole.value, memberRole);
      return;
    }
    const localFileInput = event.target.closest("[data-local-file]");
    if (localFileInput) {
      const file = localFileInput.files?.[0];
      if (file) handleLocalFile(file, localFileInput.dataset.localFile);
      localFileInput.value = "";
      return;
    }
    const filter = event.target.closest("[data-order-filter]");
    if (!filter) return;
    state.orderFilters[filter.dataset.orderFilter] = filter.value;
    renderOrdersView();
    setView("orders", false);
  });

  document.addEventListener("keydown", (event) => {
    const modal = visibleModals().at(-1);
    if (event.key === "Tab" && modal) {
      const focusable = [...modal.querySelectorAll(focusableSelector)].filter((element) => !element.closest(".hidden"));
      if (!focusable.length) return event.preventDefault();
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && !modal) {
      const contactRow = event.target.closest("[data-contact-select]");
      if (contactRow && event.target === contactRow) {
        event.preventDefault();
        selectContact(contactRow.dataset.contactSelect);
        return;
      }
      const row = event.target.closest("[data-order-id]");
      if (row && event.target === row) {
        event.preventDefault();
        openDetail(row.dataset.orderId);
        return;
      }
    }
    if (event.key !== "Escape") return;
    if (modal) closeModal(modal.id);
    else setSidebarOpen(false);
  });
  document.addEventListener("dragover", (event) => {
    const zone = event.target.closest("[data-local-drop]");
    if (!zone) return;
    event.preventDefault();
    zone.classList.add("dragging");
  });
  document.addEventListener("dragleave", (event) => {
    const zone = event.target.closest("[data-local-drop]");
    if (!zone || zone.contains(event.relatedTarget)) return;
    zone.classList.remove("dragging");
  });
  document.addEventListener("drop", (event) => {
    const zone = event.target.closest("[data-local-drop]");
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove("dragging");
    const file = event.dataTransfer?.files?.[0];
    if (file) handleLocalFile(file, zone.dataset.localDrop);
  });
  window.addEventListener("resize", () => setSidebarOpen(false));
}

document.addEventListener("DOMContentLoaded", () => {
  configureEnvironmentUi();
  bindEvents();
  refreshIcons();
  const invitationToken = new URLSearchParams(window.location.search).get("invite") || "";
  if (/^[A-Za-z0-9_-]{43}$/.test(invitationToken)) showInvitationAcceptance(invitationToken);
  else initializeSession();
});
