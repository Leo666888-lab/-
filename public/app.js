import {
  addDaysToDateInput,
  buildCreateOrderPayload,
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
  yuanToCents
} from "./frontend-core.js";

const state = {
  view: "overview",
  token: null,
  data: null,
  orderDirection: "receivable",
  orderFilter: "all",
  orderSearch: "",
  ledgerFilters: { receivable: "all", payable: "all" },
  ledgerSearch: { receivable: "", payable: "" },
  detailOrderId: "",
  detailOrder: null,
  pendingRequests: 0
};

const viewLabels = {
  overview: "结算总览",
  receivable: "客户应收",
  payable: "供应商应付",
  orders: "全部订单",
  contacts: "客户/供应商",
  reminders: "提醒中心",
  imports: "导入数据",
  ocr: "纸单识别",
  settings: "工作区设置"
};

const roleLabels = { owner: "负责人", finance: "财务", sales: "业务", viewer: "只读成员" };
const paymentMethodLabels = {
  bank_transfer: "银行转账",
  wechat: "微信",
  cash: "现金",
  alipay: "支付宝"
};

class ApiClientError extends Error {
  constructor(status, code, message, details) {
    super(message || "请求失败，请稍后重试");
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
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
        payload?.error?.details
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

function showLogin(errorMessage = "") {
  byId("appShell").classList.add("hidden");
  byId("loginScreen").classList.remove("hidden");
  const error = byId("loginError");
  error.textContent = errorMessage;
  error.classList.toggle("hidden", !errorMessage);
  byId("loginSubmit").disabled = false;
}

function showApplication() {
  byId("loginScreen").classList.add("hidden");
  byId("appShell").classList.remove("hidden");
}

function applyBootstrap(payload) {
  state.data = normalizeBootstrap(payload);
  const { tenant, user, role } = state.data;
  byId("workspaceName").textContent = tenant.name;
  byId("workspaceMeta").textContent = `${tenant.timezone} · ${roleLabels[role]}`;
  byId("workspaceAvatar").textContent = initial(tenant.name, "企");
  byId("userName").textContent = user.displayName;
  byId("userAvatar").textContent = initial(user.displayName, "用");
  document.querySelector(".user-menu").setAttribute("aria-label", `当前账号：${user.displayName}`);
  showApplication();
  renderAll();
}

async function loadBootstrap({ announce = false } = {}) {
  const payload = await apiRequest("/api/bootstrap", { busyText: "正在读取企业账本" });
  applyBootstrap(payload);
  if (announce) showToast("数据已刷新");
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
  errorElement.classList.add("hidden");
  errorElement.textContent = "";
  submit.disabled = true;
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

    const fallbackToken = typeof loginPayload.token === "string" ? loginPayload.token : null;
    state.token = null;
    try {
      await loadBootstrap();
    } catch (cookieError) {
      if (cookieError.status !== 401 || !fallbackToken) throw cookieError;
      state.token = fallbackToken;
      await loadBootstrap();
    }
    byId("loginPassword").value = "";
    showToast("登录成功");
  } catch (error) {
    showLogin(error.message);
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
  const status = orderStatus(order);
  return `<span class="status-badge ${status.className}">${status.label}</span>`;
}

function moneyMarkup(cents, currency) {
  return escapeHtml(formatMoney(cents, currency));
}

function groupedMoneyMarkup(groups, emptyText = "暂无") {
  if (!groups.length) return `<span class="muted-value">${escapeHtml(emptyText)}</span>`;
  return `<span class="currency-stack">${groups.map((group) => `<strong>${moneyMarkup(group.cents, group.currency)}</strong>`).join("")}</span>`;
}

function dueMarkup(order) {
  if (order.fulfillmentStatus !== "fulfilled") {
    return `${escapeHtml(formatDate(order.plannedDeliveryDate))}<small>计划交货</small>`;
  }
  if (!order.dueAt) return `未设置<small>等待到期日</small>`;
  const dueTime = new Date(order.dueAt).getTime();
  const days = Math.ceil((dueTime - Date.now()) / 86_400_000);
  const detail = order.outstandingCents === 0 ? "已结清" : days < 0 ? `已逾期 ${Math.abs(days)} 天` : days === 0 ? "今天到期" : `还有 ${days} 天`;
  return `${escapeHtml(formatDate(order.dueAt))}<small class="${days < 0 && order.outstandingCents > 0 ? "overdue-text" : ""}">${escapeHtml(detail)}</small>`;
}

function emptyState(message, iconName = "inbox") {
  return `<div class="empty-state">${icon(iconName, 28)}<div>${escapeHtml(message)}</div></div>`;
}

function actionButtons(order, compact = false) {
  const buttons = [];
  if (order.fulfillmentStatus === "planned" && roleCan(state.data.role, "fulfill")) {
    buttons.push(`<button class="fulfill-action" data-action="open-fulfill" data-order-id="${escapeAttr(order.id)}">确认交货</button>`);
  }
  if (order.fulfillmentStatus === "planned" && roleCan(state.data.role, "cancelOrder")) {
    buttons.push(`<button class="cancel-action" data-action="open-cancel-order" data-order-id="${escapeAttr(order.id)}">取消订单</button>`);
  }
  if (order.fulfillmentStatus === "fulfilled" && order.outstandingCents > 0 && roleCan(state.data.role, "payment")) {
    buttons.push(`<button class="payment-action" data-action="open-payment" data-order-id="${escapeAttr(order.id)}">${order.direction === "receivable" ? "登记收款" : "登记付款"}</button>`);
  }
  if (!compact) buttons.push(`<button data-action="view-detail" data-order-id="${escapeAttr(order.id)}">详情</button>`);
  return buttons.join("");
}

function renderOrderRows(orders, columns = 9) {
  if (!orders.length) return `<tr class="empty-table-row"><td class="empty-table-cell" colspan="${columns}">${emptyState("没有符合条件的订单", "search-x")}</td></tr>`;
  return orders.map((order) => `<tr data-order-id="${escapeAttr(order.id)}">
    <td class="partner-cell" data-label="订单 / 对象"><div class="table-partner"><span class="mini-avatar">${escapeHtml(initial(order.partnerName, "客"))}</span><div><strong dir="auto">${escapeHtml(order.partnerName)}</strong><div class="ledger-meta" dir="auto">${escapeHtml(order.orderNo)}</div></div></div></td>
    <td data-label="类型">${order.direction === "receivable" ? "客户应收" : "供应商应付"}</td>
    <td class="due-cell" data-label="到期日">${dueMarkup(order)}</td>
    <td data-label="结算周期">${escapeHtml(settlementLabel(order))}</td>
    <td class="amount-cell" data-label="订单金额">${moneyMarkup(order.totalCents, order.currency)}<small>已结 ${moneyMarkup(order.paidCents, order.currency)}</small></td>
    <td class="amount-cell balance-cell" data-label="未结金额"><strong>${moneyMarkup(order.outstandingCents, order.currency)}</strong></td>
    <td data-label="状态">${statusBadge(order)}</td>
    <td data-label="操作人">${escapeHtml(roleLabels[state.data.role])}</td>
    <td class="actions-cell"><div class="row-actions">${actionButtons(order)}</div></td>
  </tr>`).join("");
}

function renderLedgerRows(direction, limit = null) {
  let orders = state.data.orders.filter((order) => order.direction === direction && order.fulfillmentStatus === "fulfilled" && order.outstandingCents > 0);
  if (limit) orders = orders.slice(0, limit);
  if (!orders.length) return emptyState("没有待结算订单", "circle-check");
  return orders.map((order) => `<div class="ledger-row" data-order-id="${escapeAttr(order.id)}"><div class="ledger-main"><div class="ledger-name"><span dir="auto">${escapeHtml(order.partnerName)}</span>${statusBadge(order)}</div><div class="ledger-meta" dir="auto">${escapeHtml(order.orderNo)} · ${escapeHtml(settlementLabel(order))}</div></div><div class="ledger-money"><strong>${moneyMarkup(order.outstandingCents, order.currency)}</strong><small>总额 ${moneyMarkup(order.totalCents, order.currency)}</small></div></div>`).join("");
}

function renderOverview() {
  const orders = state.data.orders;
  const reminders = state.data.reminders;
  const planned = orders.filter((order) => order.fulfillmentStatus === "planned");
  const receivable = groupOutstanding(orders, "receivable");
  const payable = groupOutstanding(orders, "payable");
  const view = byId("view-overview");
  view.innerHTML = `
    <div class="view-heading"><div><p class="eyebrow">SETTLEMENT OVERVIEW</p><h1>结算总览</h1><p>${escapeHtml(state.data.tenant.name)} · 数据已与服务器同步</p></div><div class="heading-actions">${roleCan(state.data.role, "createOrder") ? `<button class="primary-button" data-action="new-order">${icon("plus")}新建订单</button>` : ""}</div></div>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-top"><span>待收款</span><span class="kpi-icon green">${icon("arrow-down-left")}</span></div>${groupedMoneyMarkup(receivable, "暂无应收")}<small>${orders.filter((order) => order.direction === "receivable" && order.fulfillmentStatus === "fulfilled" && order.outstandingCents > 0).length} 笔未结</small></div>
      <div class="kpi"><div class="kpi-top"><span>待付款</span><span class="kpi-icon blue">${icon("arrow-up-right")}</span></div>${groupedMoneyMarkup(payable, "暂无应付")}<small>${orders.filter((order) => order.direction === "payable" && order.fulfillmentStatus === "fulfilled" && order.outstandingCents > 0).length} 笔未结</small></div>
      <div class="kpi"><div class="kpi-top"><span>待确认交货</span><span class="kpi-icon amber">${icon("package-open")}</span></div><strong>${planned.length}</strong><small>确认后才进入结算</small></div>
      <div class="kpi"><div class="kpi-top"><span>今日提醒</span><span class="kpi-icon red">${icon("bell-ring")}</span></div><strong>${reminders.length}</strong><small>来自真实提醒队列</small></div>
    </div>
    <div class="alert-banner ${reminders.length ? "" : "cleared"}"><div class="alert-banner-content">${icon(reminders.length ? "bell-ring" : "circle-check", 18)}<div><strong>${reminders.length ? `有 ${reminders.length} 笔账款需要处理` : "当前提醒已处理完成"}</strong><span>${reminders.length ? "确认或暂缓后由服务器安排下一次提醒，结清后永久关闭。" : "系统会在账款进入提醒窗口时自动显示。"}</span></div></div>${reminders.length ? `<button class="text-button" data-view="reminders">去处理 ${icon("arrow-up-right", 13)}</button>` : ""}</div>
    ${planned.length ? `<section class="pending-deliveries"><div class="panel-header"><div><h2>待确认交货</h2><span>计划日期不会自动触发结算</span></div><button class="text-button" data-view="orders">查看全部</button></div><div class="compact-order-list">${planned.slice(0, 4).map((order) => `<div class="compact-order"><div><strong dir="auto">${escapeHtml(order.partnerName)}</strong><span dir="auto">${escapeHtml(order.orderNo)} · 计划 ${escapeHtml(formatDate(order.plannedDeliveryDate))}</span></div><div class="compact-order-actions"><b>${moneyMarkup(order.totalCents, order.currency)}</b>${actionButtons(order, true)}</div></div>`).join("")}</div></section>` : ""}
    <div class="panel-grid"><section class="panel"><div class="panel-header"><div><h2>客户应收</h2><span>已交货且尚未收清</span></div><button class="text-button" data-view="receivable">查看全部 ${icon("arrow-up-right", 13)}</button></div><div class="ledger-list">${renderLedgerRows("receivable", 4)}</div></section><section class="panel"><div class="panel-header"><div><h2>供应商应付</h2><span>已收货且尚未付清</span></div><button class="text-button" data-view="payable">查看全部 ${icon("arrow-up-right", 13)}</button></div><div class="ledger-list">${renderLedgerRows("payable", 4)}</div></section></div>`;
}

function filteredLedgerOrders(direction) {
  const search = state.ledgerSearch[direction].toLowerCase();
  const filter = state.ledgerFilters[direction];
  return state.data.orders.filter((order) => {
    if (order.direction !== direction || order.fulfillmentStatus !== "fulfilled" || order.outstandingCents <= 0) return false;
    if (search && !`${order.partnerName}${order.orderNo}`.toLowerCase().includes(search)) return false;
    const status = orderStatus(order);
    return filter === "all" || (filter === "overdue" && status.className === "overdue") || (filter === "partial" && order.settlementStatus === "partial") || (filter === "pending" && order.paidCents === 0);
  });
}

function renderLedgerView(direction) {
  const isReceivable = direction === "receivable";
  const orders = filteredLedgerOrders(direction);
  const allDirectionOrders = state.data.orders.filter((order) => order.direction === direction);
  byId(`view-${direction}`).innerHTML = `<div class="view-heading"><div><p class="eyebrow">${isReceivable ? "RECEIVABLES" : "PAYABLES"}</p><h1>${isReceivable ? "客户应收" : "供应商应付"}</h1><p>${isReceivable ? "登记客户每一次付款，余额由服务器自动派生。" : "安排供应商货款，完整保留每次付款记录。"}</p></div><div class="heading-actions">${roleCan(state.data.role, "createOrder") ? `<button class="primary-button" data-action="new-order" data-direction="${direction}">${icon("plus")}新建${isReceivable ? "应收" : "应付"}</button>` : ""}</div></div>
    <div class="kpi-grid compact-kpis"><div class="kpi"><div class="kpi-top"><span>${isReceivable ? "待收余额" : "待付余额"}</span><span class="kpi-icon ${isReceivable ? "green" : "blue"}">${icon(isReceivable ? "arrow-down-left" : "arrow-up-right")}</span></div>${groupedMoneyMarkup(groupOutstanding(state.data.orders, direction))}<small>不同币种分开统计</small></div><div class="kpi"><div class="kpi-top"><span>部分结算</span><span class="kpi-icon amber">${icon("circle-dot")}</span></div><strong>${allDirectionOrders.filter((order) => order.settlementStatus === "partial").length}</strong><small>可继续分批登记</small></div><div class="kpi"><div class="kpi-top"><span>已结清</span><span class="kpi-icon green">${icon("circle-check")}</span></div><strong>${allDirectionOrders.filter((order) => order.settlementStatus === "settled").length}</strong><small>历史订单</small></div><div class="kpi"><div class="kpi-top"><span>待交货</span><span class="kpi-icon blue">${icon("package-open")}</span></div><strong>${allDirectionOrders.filter((order) => order.fulfillmentStatus === "planned").length}</strong><small>尚未进入结算</small></div></div>
    <div class="table-toolbar"><div class="filter-row"><button class="filter-pill ${state.ledgerFilters[direction] === "all" ? "active" : ""}" data-ledger-filter="all" data-direction="${direction}">全部</button><button class="filter-pill ${state.ledgerFilters[direction] === "overdue" ? "active" : ""}" data-ledger-filter="overdue" data-direction="${direction}">已逾期</button><button class="filter-pill ${state.ledgerFilters[direction] === "partial" ? "active" : ""}" data-ledger-filter="partial" data-direction="${direction}">部分结算</button><button class="filter-pill ${state.ledgerFilters[direction] === "pending" ? "active" : ""}" data-ledger-filter="pending" data-direction="${direction}">未开始</button></div><div class="search-box">${icon("search")}<input class="ledger-search" data-direction="${direction}" value="${escapeAttr(state.ledgerSearch[direction])}" placeholder="搜索往来单位、订单号" /></div></div>
    <div class="data-table-wrap"><table class="data-table"><thead><tr><th>订单 / 对象</th><th>类型</th><th>到期日</th><th>结算周期</th><th>订单金额</th><th>未结金额</th><th>状态</th><th>权限</th><th></th></tr></thead><tbody id="${direction}Rows">${renderOrderRows(orders)}</tbody></table></div>`;
}

function filteredAllOrders() {
  const search = state.orderSearch.toLowerCase();
  return state.data.orders.filter((order) => {
    if (search && !`${order.partnerName}${order.orderNo}`.toLowerCase().includes(search)) return false;
    if (state.orderFilter === "all") return true;
    if (state.orderFilter === "planned") return order.fulfillmentStatus === "planned";
    if (state.orderFilter === "receivable" || state.orderFilter === "payable") return order.direction === state.orderFilter;
    if (state.orderFilter === "settled") return order.settlementStatus === "settled";
    return true;
  });
}

function renderOrdersView() {
  const orders = filteredAllOrders();
  byId("view-orders").innerHTML = `<div class="view-heading"><div><p class="eyebrow">ALL ORDERS</p><h1>全部订单</h1><p>计划、交货、结算状态均以服务器记录为准。</p></div><div class="heading-actions">${roleCan(state.data.role, "createOrder") ? `<button class="primary-button" data-action="new-order">${icon("plus")}新建订单</button>` : ""}</div></div><div class="table-toolbar"><div class="filter-row">${[["all","全部"],["planned","待交货"],["receivable","客户应收"],["payable","供应商应付"],["settled","已结清"]].map(([value,label]) => `<button class="filter-pill ${state.orderFilter === value ? "active" : ""}" data-orders-filter="${value}">${label}</button>`).join("")}</div><div class="search-box">${icon("search")}<input id="ordersSearch" value="${escapeAttr(state.orderSearch)}" placeholder="搜索订单号、客户或供应商" /></div></div><div class="data-table-wrap"><table class="data-table"><thead><tr><th>订单 / 对象</th><th>类型</th><th>到期日</th><th>结算周期</th><th>订单金额</th><th>未结金额</th><th>状态</th><th>权限</th><th></th></tr></thead><tbody id="ordersRows">${renderOrderRows(orders)}</tbody></table></div>`;
}

function renderContactsView() {
  const partners = state.data.partners;
  byId("view-contacts").innerHTML = `<div class="view-heading"><div><p class="eyebrow">PARTNERS</p><h1>客户 / 供应商</h1><p>往来单位与余额来自当前企业，金额按币种分开。</p></div><div class="heading-actions">${roleCan(state.data.role,"partner") ? `<button class="primary-button" data-action="new-partner">${icon("user-plus")}新增往来单位</button>` : ""}</div></div><div class="contact-grid">${partners.length ? partners.map((partner) => {
    const kind = partner.kind === "customer" ? "客户" : partner.kind === "supplier" ? "供应商" : "客户 / 供应商";
    const balances = partner.balances.filter((balance) => balance.receivableCents > 0 || balance.payableCents > 0);
    return `<article class="contact-card"><div class="contact-card-header"><span class="mini-avatar">${escapeHtml(initial(partner.name,"客"))}</span><div class="contact-heading-copy"><strong dir="auto">${escapeHtml(partner.name)}</strong><span>${kind}</span></div><span class="status-badge ${balances.length ? "partial" : "settled"}">${balances.length ? "有余额" : "已结清"}</span>${roleCan(state.data.role,"partner") ? `<button class="icon-button contact-edit" data-action="edit-partner" data-partner-id="${escapeAttr(partner.id)}" aria-label="编辑 ${escapeAttr(partner.name)}" title="编辑往来单位">${icon("pencil",15)}</button>` : ""}</div><dl class="contact-details"><div class="contact-detail"><dt>联系人</dt><dd dir="auto">${escapeHtml(partner.contactName || "未填写")}</dd></div><div class="contact-detail"><dt>联系电话</dt><dd dir="auto">${escapeHtml(partner.phone || "未填写")}</dd></div><div class="contact-detail full-contact-detail"><dt>当前余额</dt><dd>${balances.length ? `<span class="partner-balances">${balances.map((balance) => `${balance.receivableCents ? `<span><b>应收</b>${moneyMarkup(balance.receivableCents,balance.currency)}</span>` : ""}${balance.payableCents ? `<span><b>应付</b>${moneyMarkup(balance.payableCents,balance.currency)}</span>` : ""}`).join("")}</span>` : "暂无未结余额"}</dd></div></dl></article>`;
  }).join("") : emptyState("还没有客户或供应商", "contact")}</div>`;
}

function renderRemindersView() {
  const reminders = state.data.reminders;
  const overdueCount = reminders.filter((reminder) => reminder.dueAt && new Date(reminder.dueAt).getTime() < Date.now()).length;
  byId("view-reminders").innerHTML = `<div class="view-heading"><div><p class="eyebrow">REMINDER CENTER</p><h1>提醒中心</h1><p>确认后次日继续提醒，只有订单结清才永久关闭。</p></div><div class="heading-actions"><button class="outline-button" data-action="pending-notifications">${icon("radio")}外部通知待接入</button></div></div><div class="reminder-grid"><div class="reminder-stat"><span>当前待处理</span><strong>${reminders.length}</strong></div><div class="reminder-stat"><span>已逾期</span><strong class="danger-text">${overdueCount}</strong></div><div class="reminder-stat"><span>提醒规则</span><strong class="small-stat">到期前 7 天</strong></div></div><section class="panel"><div class="panel-header"><div><h2>待处理提醒</h2><span>当前仅系统内提醒；微信、短信、电话待接入</span></div></div><div class="reminder-list">${reminders.length ? reminders.map((reminder) => {
    const overdue = reminder.dueAt && new Date(reminder.dueAt).getTime() < Date.now();
    return `<div class="reminder-item" data-order-id="${escapeAttr(reminder.orderId)}"><span class="reminder-icon ${overdue ? "" : "warn"}">${icon(overdue ? "alarm-clock" : "clock-3",16)}</span><div class="reminder-copy"><div class="reminder-title" dir="auto">${escapeHtml(reminder.partnerName)} · ${escapeHtml(reminder.orderNo)}</div><div class="reminder-detail">${reminder.direction === "receivable" ? "应收" : "应付"} ${moneyMarkup(reminder.outstandingCents, state.data.orders.find((order) => order.id === reminder.orderId)?.currency || "CNY")} · 到期 ${escapeHtml(formatDate(reminder.dueAt))}</div></div><div class="reminder-actions">${roleCan(state.data.role,"payment") ? `<button class="reminder-primary" data-action="open-payment" data-order-id="${escapeAttr(reminder.orderId)}">${reminder.direction === "receivable" ? "去收款" : "去付款"}</button>` : ""}${roleCan(state.data.role,"reminder") ? `<button data-action="ack-reminder" data-reminder-id="${escapeAttr(reminder.id)}">已知晓</button><button data-action="open-snooze" data-reminder-id="${escapeAttr(reminder.id)}">暂缓</button>` : ""}<button data-action="view-detail" data-order-id="${escapeAttr(reminder.orderId)}">详情</button></div></div>`;
  }).join("") : emptyState("当前没有待处理提醒", "circle-check")}</div></section>`;
}

function renderPendingTool(viewId, type) {
  const isImport = type === "import";
  const title = isImport ? "导入数据" : "纸单识别";
  const label = isImport ? "EXCEL IMPORT" : "PAPER ORDER OCR";
  const description = isImport ? "Excel 字段映射、预览校验和批量入账接口尚未接入。" : "中文、英文和阿拉伯语 OCR 服务及人工确认接口尚未接入。";
  byId(viewId).innerHTML = `<div class="view-heading"><div><p class="eyebrow">${label}</p><h1>${title}</h1><p>测试入口 · 当前不会生成订单或修改账务数据。</p></div></div><section class="integration-panel"><div class="integration-visual">${icon(isImport ? "file-spreadsheet" : "scan-line",34)}</div><div><span class="integration-tag">待接入</span><h2>${title}尚未开放</h2><p>${description}</p><div class="integration-checks"><span>${icon("check",14)}页面不会伪造入账</span><span>${icon("check",14)}上线前需接真实服务与审计</span><span>${icon("check",14)}导入结果必须人工确认</span></div></div><button class="outline-button" type="button" disabled>${isImport ? "选择文件" : "上传纸单"}</button></section>`;
}

function renderSettingsView() {
  const { tenant, user, role } = state.data;
  byId("view-settings").innerHTML = `<div class="view-heading"><div><p class="eyebrow">WORKSPACE SETTINGS</p><h1>工作区设置</h1><p>企业与成员信息来自当前登录会话。</p></div></div><div class="settings-grid"><section class="settings-list"><div class="setting-row"><div><strong>企业</strong><span dir="auto">${escapeHtml(tenant.name)}</span></div><span class="settings-value">${escapeHtml(tenant.timezone)}</span></div><div class="setting-row"><div><strong>当前成员</strong><span dir="auto">${escapeHtml(user.displayName)} · ${escapeHtml(user.phone)}</span></div><span class="status-badge pending">${escapeHtml(roleLabels[role])}</span></div><div class="setting-row"><div><strong>账号密码</strong><span>修改后撤销其他设备上的登录会话</span></div><button class="outline-button small-button" data-action="change-password">修改密码</button></div><div class="setting-row"><div><strong>会话安全</strong><span>优先同源 HttpOnly cookie；兼容令牌仅保存在页面内存</span></div>${icon("shield-check",20)}</div></section><section class="settings-list"><div class="setting-row"><div><strong>微信 / 短信 / 电话</strong><span>发送服务、模板审核和失败重试待接入</span></div><span class="integration-tag">待接入</span></div><div class="setting-row"><div><strong>Excel / OCR</strong><span>解析、字段映射、文件扫描待接入</span></div><span class="integration-tag">测试入口</span></div><div class="setting-row"><div><strong>退出登录</strong><span>撤销当前服务端会话并清除安全 cookie</span></div><button class="outline-button small-button" data-action="logout">安全退出</button></div></section></div>`;
}

function renderAll() {
  if (!state.data) return;
  renderOverview();
  renderLedgerView("receivable");
  renderLedgerView("payable");
  renderOrdersView();
  renderContactsView();
  renderRemindersView();
  renderPendingTool("view-imports", "import");
  renderPendingTool("view-ocr", "ocr");
  renderSettingsView();
  updateNavigationCounts();
  setView(state.view, false);
  refreshIcons();
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
  state.view = view;
  document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${view}`));
  document.querySelectorAll(".nav-item[data-view], .mobile-nav-item[data-view]").forEach((element) => element.classList.toggle("active", element.dataset.view === view));
  byId("breadcrumbCurrent").textContent = viewLabels[view];
  setSidebarOpen(false);
  if (scroll) window.scrollTo({ top: 0, behavior: "auto" });
  refreshIcons();
}

function setSidebarOpen(open) {
  byId("sidebar").classList.toggle("open", open);
  byId("sidebarScrim").classList.toggle("hidden", !open);
  byId("mobileMenu").setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("nav-open", open);
}

function openModal(id) {
  const backdrop = byId(id);
  backdrop.classList.remove("hidden");
  backdrop.setAttribute("aria-hidden", "false");
  backdrop.querySelector(".modal")?.scrollTo({ top: 0 });
  document.body.classList.add("modal-open");
  refreshIcons();
}

function closeModal(id) {
  const backdrop = byId(id);
  if (!backdrop) return;
  backdrop.classList.add("hidden");
  backdrop.setAttribute("aria-hidden", "true");
  if (id === "passwordModal") byId("passwordForm").reset();
  if (id === "detailModal") {
    state.detailOrderId = "";
    state.detailOrder = null;
  }
  if (!document.querySelector(".modal-backdrop:not(.hidden)")) document.body.classList.remove("modal-open");
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
  state.orderDirection = direction;
  byId("orderForm").reset();
  const orderDate = toDateInputValue(new Date(), tenantTimeZone());
  byId("orderDate").value = orderDate;
  byId("plannedDeliveryDate").value = addDaysToDateInput(orderDate, 2);
  byId("orderNumber").value = generateOrderNo(direction);
  byId("settlementCycle").value = "days:30";
  byId("customSettlementField").classList.add("hidden");
  document.querySelectorAll(".direction-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.direction === direction));
  byId("orderModalTitle").textContent = direction === "receivable" ? "新建客户应收订单" : "新建供应商应付订单";
  if (!populatePartnerOptions()) return showToast(direction === "receivable" ? "请先在后端添加客户" : "请先在后端添加供应商", "error");
  byId("lineItemsBody").replaceChildren();
  addLineItem();
  openModal("orderModal");
}

function addLineItem() {
  const row = document.createElement("tr");
  row.innerHTML = `<td class="line-description" data-label="商品说明"><input class="line-name" maxlength="500" placeholder="商品名称、规格" dir="auto" required /></td><td data-label="数量"><input class="line-qty" type="number" min="1" step="1" value="1" required /></td><td data-label="单价"><input class="line-price" type="number" min="0.01" step="0.01" placeholder="0.00" required /></td><td class="line-subtotal amount-cell" data-label="小计">${moneyMarkup(0, byId("orderCurrency").value)}</td><td class="line-remove-cell"><button type="button" class="remove-line" aria-label="删除商品">${icon("trash-2",15)}</button></td>`;
  row.querySelectorAll("input").forEach((input) => input.addEventListener("input", calculateOrderTotal));
  row.querySelector(".remove-line").addEventListener("click", () => {
    row.remove();
    calculateOrderTotal();
  });
  byId("lineItemsBody").appendChild(row);
  calculateOrderTotal();
  refreshIcons();
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
}

async function submitOrder(event) {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
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
    await apiRequest("/api/orders", { method: "POST", body: payload, busyText: "正在创建订单" });
    closeModal("orderModal");
    await loadBootstrap();
    setView("orders");
    showToast("订单已创建，确认交货后才会进入结算");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    submit.disabled = false;
  }
}

function orderById(orderId) {
  return state.data.orders.find((order) => order.id === orderId);
}

function openFulfillModal(orderId) {
  const order = orderById(orderId);
  if (!order || order.fulfillmentStatus !== "planned") return showToast("订单状态已变化，请刷新后重试", "error");
  if (!roleCan(state.data.role, "fulfill")) return showToast("当前角色没有确认交货权限", "error");
  byId("fulfillOrderId").value = order.id;
  byId("fulfilledAt").value = toDateTimeInputValue(new Date(), tenantTimeZone());
  byId("fulfillContext").innerHTML = `<strong dir="auto">${escapeHtml(order.partnerName)} · ${escapeHtml(order.orderNo)}</strong><span>${moneyMarkup(order.totalCents,order.currency)} · ${escapeHtml(settlementLabel(order))}</span>`;
  openModal("fulfillModal");
}

async function submitFulfillment(event) {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const orderId = byId("fulfillOrderId").value;
    await apiRequest(`/api/orders/${encodeURIComponent(orderId)}/fulfill`, {
      method: "POST",
      body: { fulfilledAt: toIsoDateTime(byId("fulfilledAt").value, tenantTimeZone()) },
      busyText: "正在确认交货"
    });
    closeModal("fulfillModal");
    await loadBootstrap();
    showToast("已确认交货，订单已进入结算");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
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

function openPaymentModal(orderId) {
  const order = orderById(orderId);
  if (!order || order.fulfillmentStatus !== "fulfilled" || order.outstandingCents <= 0) return showToast("这笔订单当前不能登记收付款", "error");
  if (!roleCan(state.data.role, "payment")) return showToast("只有负责人或财务可以登记收付款", "error");
  byId("paymentForm").reset();
  byId("paymentOrderId").value = order.id;
  byId("paymentIdempotencyKey").value = makeIdempotencyKey(order.id);
  byId("paymentAmount").value = (order.outstandingCents / 100).toFixed(2);
  byId("paymentAmount").max = (order.outstandingCents / 100).toFixed(2);
  byId("paymentDate").value = toDateTimeInputValue(new Date(), tenantTimeZone());
  byId("paymentModalTitle").textContent = order.direction === "receivable" ? "登记收款" : "登记付款";
  byId("paymentContext").innerHTML = `<strong dir="auto">${escapeHtml(order.partnerName)} · ${escapeHtml(order.orderNo)}</strong><span>未结 ${moneyMarkup(order.outstandingCents,order.currency)} · 本次不能超额</span>`;
  openModal("paymentModal");
}

async function submitPayment(event) {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const orderId = byId("paymentOrderId").value;
    const order = orderById(orderId);
    if (!order) throw new Error("订单不存在，请刷新后重试");
    const amountCents = yuanToCents(byId("paymentAmount").value);
    if (amountCents <= 0 || amountCents > order.outstandingCents) throw new Error("金额必须大于 0，且不能超过未结金额");
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
    closeModal("paymentModal");
    await loadBootstrap();
    showToast(result.idempotentReplay ? "该笔记录已存在，已返回原付款" : "收付款已登记");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
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
  try {
    if (!reason) throw new Error("请填写冲销原因");
    const result = await apiRequest(`/api/payments/${encodeURIComponent(paymentId)}/reverse`, {
      method: "POST",
      headers: { "Idempotency-Key": byId("reversalIdempotencyKey").value },
      body: { reason },
      busyText: "正在冲销收付款"
    });
    closeModal("reversalModal");
    await loadBootstrap();
    await refreshDetailIfOpen(orderId);
    showToast(result.idempotentReplay ? "该笔冲销已处理，页面已刷新" : "收付款已冲销，余额与提醒已重新计算");
  } catch (error) {
    if (["PAYMENT_ALREADY_REVERSED", "NOT_FOUND"].includes(error.code)) {
      closeModal("reversalModal");
      await loadBootstrap();
      await refreshDetailIfOpen(orderId);
    }
    showToast(error.message, "error");
  } finally {
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
  try {
    const result = await apiRequest(`/api/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: "POST",
      busyText: "正在取消订单"
    });
    closeModal("cancelOrderModal");
    await loadBootstrap();
    await refreshDetailIfOpen(orderId);
    showToast(result.idempotentReplay ? "订单此前已取消，页面已刷新" : "订单已取消");
  } catch (error) {
    if (["ORDER_NOT_PLANNED", "ORDER_HAS_PAYMENTS", "NOT_FOUND"].includes(error.code)) {
      closeModal("cancelOrderModal");
      await loadBootstrap();
      await refreshDetailIfOpen(orderId);
    }
    showToast(error.message, "error");
  } finally {
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
  try {
    const reminderId = byId("snoozeReminderId").value;
    await apiRequest(`/api/reminders/${encodeURIComponent(reminderId)}/snooze`, {
      method: "POST",
      body: { until: toIsoDateTime(byId("snoozeUntil").value, tenantTimeZone()) },
      busyText: "正在暂缓提醒"
    });
    closeModal("snoozeModal");
    await loadBootstrap();
    showToast("提醒已暂缓");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
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
    closeModal("partnerModal");
    await loadBootstrap();
    setView("contacts", false);
    showToast(partnerId ? "往来单位已更新" : "往来单位已新增，现在可以创建订单");
  } catch (error) {
    if (error.code === "PARTNER_VERSION_CONFLICT") {
      closeModal("partnerModal");
      await loadBootstrap();
      setView("contacts", false);
      showToast("该往来单位已被其他成员更新，页面已刷新", "error");
    } else {
      showToast(error.message, "error");
    }
  } finally {
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
  try {
    if (newPassword.length < 12) throw new Error("新密码至少需要 12 位");
    if (newPassword !== confirmPassword) throw new Error("两次输入的新密码不一致");
    await apiRequest("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword, newPassword },
      busyText: "正在修改密码"
    });
    byId("passwordForm").reset();
    closeModal("passwordModal");
    showToast("密码已修改，其他设备会话已撤销");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    submit.disabled = false;
  }
}

function detailActionMarkup(order) {
  const safeOrderId = escapeAttr(order.id);
  const actions = [statusBadge(order)];
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
      ${order.notes ? `<div class="order-notes"><span>订单备注</span><p dir="auto">${escapeHtml(order.notes)}</p></div>` : ""}
      <div class="data-table-wrap"><table class="data-table detail-items-table"><thead><tr><th>商品说明</th><th>数量</th><th>单价</th><th>小计</th></tr></thead><tbody>${order.items.length ? order.items.map((item) => `<tr><td class="detail-item-name" data-label="商品说明" dir="auto">${escapeHtml(item.description)}</td><td data-label="数量">${item.quantity}</td><td class="amount-cell" data-label="单价">${moneyMarkup(item.unitPriceCents, order.currency)}</td><td class="amount-cell detail-item-subtotal" data-label="小计">${moneyMarkup(item.lineTotalCents, order.currency)}</td></tr>`).join("") : `<tr><td colspan="4">${emptyState("没有商品明细")}</td></tr>`}</tbody></table></div>
      <section class="payment-history"><div class="line-items-heading"><div><h3>收付款记录</h3><span>${order.payments.length} 笔 · 原付款与冲销记录均保留</span></div></div>${paymentHistoryMarkup(order)}</section>
    </div>`;
}

async function openDetail(orderId, { showLoading = true } = {}) {
  const summary = orderById(orderId);
  if (!summary) return;
  state.detailOrderId = orderId;
  byId("detailTitle").textContent = summary.partnerName;
  if (showLoading) byId("detailContent").innerHTML = `<div class="detail-loading">${icon("loader-circle",24)}<span>正在读取订单详情</span></div>`;
  openModal("detailModal");
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
  byId("logoutButton").addEventListener("click", (event) => logout(event.currentTarget));
  byId("mobileMenu").addEventListener("click", () => setSidebarOpen(!byId("sidebar").classList.contains("open")));
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
  byId("addLineItem").addEventListener("click", addLineItem);
  byId("orderCurrency").addEventListener("change", calculateOrderTotal);
  byId("settlementCycle").addEventListener("change", (event) => byId("customSettlementField").classList.toggle("hidden", event.target.value !== "custom"));
  byId("paymentForm").addEventListener("input", (event) => {
    if (event.target.id === "paymentIdempotencyKey" || !byId("paymentOrderId").value) return;
    byId("paymentIdempotencyKey").value = makeIdempotencyKey(byId("paymentOrderId").value);
  });
  document.querySelectorAll(".direction-tab").forEach((button) => button.addEventListener("click", () => {
    state.orderDirection = button.dataset.direction;
    document.querySelectorAll(".direction-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    byId("orderModalTitle").textContent = state.orderDirection === "receivable" ? "新建客户应收订单" : "新建供应商应付订单";
    byId("orderNumber").value = generateOrderNo(state.orderDirection);
    populatePartnerOptions();
  }));

  document.addEventListener("click", async (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) { event.preventDefault(); setView(viewButton.dataset.view); }
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
      if (type === "open-fulfill") { closeModal("detailModal"); openFulfillModal(action.dataset.orderId); }
      if (type === "open-payment") { closeModal("detailModal"); openPaymentModal(action.dataset.orderId); }
      if (type === "open-reversal") openReversalModal(action.dataset.orderId, action.dataset.paymentId);
      if (type === "open-cancel-order") openCancelOrderModal(action.dataset.orderId);
      if (type === "view-detail") openDetail(action.dataset.orderId);
      if (type === "ack-reminder") await acknowledgeReminder(action.dataset.reminderId, action);
      if (type === "open-snooze") openSnoozeModal(action.dataset.reminderId);
      if (type === "pending-notifications") showToast("微信、短信和电话通知服务待接入，不会模拟发送");
      if (type === "account-menu") setView("settings");
      if (type === "change-password") openPasswordModal();
      if (type === "logout") await logout(action);
    }

    const row = event.target.closest("[data-order-id]");
    if (row && !event.target.closest("button") && !event.target.closest("input")) openDetail(row.dataset.orderId);

    const orderFilter = event.target.closest("[data-orders-filter]");
    if (orderFilter) { state.orderFilter = orderFilter.dataset.ordersFilter; renderOrdersView(); setView("orders",false); refreshIcons(); }
    const ledgerFilter = event.target.closest("[data-ledger-filter]");
    if (ledgerFilter) { state.ledgerFilters[ledgerFilter.dataset.direction] = ledgerFilter.dataset.ledgerFilter; renderLedgerView(ledgerFilter.dataset.direction); setView(ledgerFilter.dataset.direction,false); refreshIcons(); }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "ordersSearch") { state.orderSearch = event.target.value.trim(); rerenderOrderTables(); }
    if (event.target.matches(".ledger-search")) { state.ledgerSearch[event.target.dataset.direction] = event.target.value.trim(); rerenderOrderTables(); }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const modal = [...document.querySelectorAll(".modal-backdrop:not(.hidden)")].pop();
    if (modal) closeModal(modal.id);
    else setSidebarOpen(false);
  });
  window.addEventListener("resize", () => { if (window.innerWidth > 760) setSidebarOpen(false); });
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  refreshIcons();
  initializeSession();
});
