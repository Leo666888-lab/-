import { newId } from "./lib/security.js";
import type { Queryable } from "./db/types.js";
import { ApiError } from "./lib/errors.js";

type Direction = "receivable" | "payable";

function periodStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Ensure a posting date has an open monthly period. Accounts are seeded by migration. */
export async function ensureAccountingDefaults(tx: Queryable, tenantId: string, date: string): Promise<void> {
  await tx.query(
    `INSERT INTO accounting_periods (id, tenant_id, period_start, period_end)
     VALUES ($1, $2, $3::date, ($3::date + interval '1 month - 1 day')::date)
     ON CONFLICT (tenant_id, period_start) DO NOTHING`,
    [newId(), tenantId, periodStart(date)],
  );
}

async function accountId(tx: Queryable, tenantId: string, code: string): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM accounting_accounts
     WHERE tenant_id = $1 AND code = $2 AND is_active = true`,
    [tenantId, code],
  );
  if (!result.rows[0]) throw new ApiError(500, "ACCOUNTING_ACCOUNT_NOT_FOUND", `会计科目 ${code} 未配置`);
  return result.rows[0].id;
}

async function defaultBankAccountId(tx: Queryable, tenantId: string, currency: string): Promise<string | null> {
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM bank_accounts
     WHERE tenant_id = $1 AND is_active = true AND currency = $2
     ORDER BY is_default DESC, name, id LIMIT 1`,
    [tenantId, currency],
  );
  return result.rows[0]?.id ?? null;
}

async function validateBankAccount(
  tx: Queryable,
  tenantId: string,
  bankAccountId: string,
  currency: string,
): Promise<void> {
  const result = await tx.query<{ currency: string; is_active: boolean }>(
    `SELECT currency, is_active FROM bank_accounts
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, bankAccountId],
  );
  const account = result.rows[0];
  if (!account) throw new ApiError(409, "BANK_ACCOUNT_NOT_FOUND", "指定的银行账户不存在或不属于当前企业");
  if (!account.is_active) throw new ApiError(409, "BANK_ACCOUNT_INACTIVE", "指定的银行账户已停用");
  if (String(account.currency).trim() !== currency) {
    throw new ApiError(409, "BANK_ACCOUNT_CURRENCY_MISMATCH", "银行账户币种与凭证币种不一致");
  }
}

export async function postJournal(tx: Queryable, input: {
  tenantId: string;
  postedAt: string;
  sourceType: string;
  sourceId: string;
  description: string;
  createdBy: string;
  currency?: string;
  lines: Array<{
    accountCode: string;
    debitCents?: number;
    creditCents?: number;
    description?: string;
    partnerId?: string;
    bankAccountId?: string;
  }>;
}): Promise<{ id: string; replayed: boolean }> {
  await ensureAccountingDefaults(tx, input.tenantId, input.postedAt.slice(0, 10));
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM journal_entries
     WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3`,
    [input.tenantId, input.sourceType, input.sourceId],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, replayed: true };

  const period = await tx.query<{ id: string; status: string }>(
    `SELECT id, status FROM accounting_periods
     WHERE tenant_id = $1 AND period_start = $2::date FOR UPDATE`,
    [input.tenantId, periodStart(input.postedAt.slice(0, 10))],
  );
  const periodRow = period.rows[0];
  if (!periodRow) throw new ApiError(409, "ACCOUNTING_PERIOD_NOT_FOUND", "会计期间不存在");
  if (periodRow.status === "closed") throw new ApiError(409, "ACCOUNTING_PERIOD_CLOSED", "会计期间已结账，不能生成新的账务记录");

  const totalDebit = input.lines.reduce((sum, line) => sum + (line.debitCents ?? 0), 0);
  const totalCredit = input.lines.reduce((sum, line) => sum + (line.creditCents ?? 0), 0);
  if (!Number.isSafeInteger(totalDebit) || totalDebit <= 0 || totalDebit !== totalCredit) {
    throw new Error("unbalanced accounting journal");
  }

  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`accounting-entry-number:${input.tenantId}`]);
  const entryNoResult = await tx.query<{ entry_no: string }>(
    `SELECT COALESCE(MAX(entry_no), 0)::text AS entry_no
     FROM journal_entries WHERE tenant_id = $1`,
    [input.tenantId],
  );
  const entryNo = Number(entryNoResult.rows[0]?.entry_no ?? 0) + 1;
  const entryId = newId();
  const entryDate = input.postedAt.slice(0, 10);
  const currency = String(input.currency ?? "CNY").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApiError(400, "INVALID_CURRENCY", "凭证币种必须是三位字母代码");
  }
  const fallbackBankId = input.lines.some((line) => line.accountCode === "1002" && line.bankAccountId === undefined)
    ? await defaultBankAccountId(tx, input.tenantId, currency)
    : null;
  if (input.lines.some((line) => line.accountCode === "1002" && !line.bankAccountId) && !fallbackBankId) {
    throw new ApiError(409, "BANK_ACCOUNT_CURRENCY_UNAVAILABLE", `没有可用的 ${currency} 银行账户，无法登记收付款`);
  }
  for (const line of input.lines) {
    const lineBankId = line.bankAccountId ?? (line.accountCode === "1002" ? fallbackBankId : null);
    if (lineBankId) await validateBankAccount(tx, input.tenantId, lineBankId, currency);
  }
  await tx.query(
    `INSERT INTO journal_entries
       (id, tenant_id, period_id, entry_no, entry_date, source_type, source_id,
        description, currency, total_debit_cents, total_credit_cents, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [entryId, input.tenantId, periodRow.id, entryNo, entryDate, input.sourceType, input.sourceId,
      input.description, currency, totalDebit, totalCredit, input.createdBy],
  );
  let lineNo = 1;
  for (const line of input.lines) {
    const lineBankId = line.bankAccountId ?? (line.accountCode === "1002" ? fallbackBankId : null);
    await tx.query(
      `INSERT INTO journal_lines
         (id, tenant_id, journal_entry_id, line_no, account_id, partner_id,
          bank_account_id, description, debit_cents, credit_cents, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId(), input.tenantId, entryId, lineNo++, await accountId(tx, input.tenantId, line.accountCode),
        line.partnerId ?? null, lineBankId, line.description ?? null,
        line.debitCents ?? 0, line.creditCents ?? 0, currency],
    );
  }
  return { id: entryId, replayed: false };
}

export async function postFulfillmentJournal(tx: Queryable, input: {
  tenantId: string; orderId: string; direction: Direction; amountCents: number; postedAt: string; createdBy: string;
  /** Currency is optional for backwards-compatible internal callers; API paths always pass the order currency. */
  currency?: string;
}) {
  const isReceivable = input.direction === "receivable";
  return postJournal(tx, {
    tenantId: input.tenantId,
    postedAt: input.postedAt,
    sourceType: "order.fulfillment",
    sourceId: input.orderId,
    description: isReceivable ? "确认销售收入及应收账款" : "确认采购入库及应付账款",
    createdBy: input.createdBy,
    currency: input.currency,
    lines: isReceivable
      ? [{ accountCode: "1122", debitCents: input.amountCents }, { accountCode: "5001", creditCents: input.amountCents }]
      : [{ accountCode: "1405", debitCents: input.amountCents }, { accountCode: "2202", creditCents: input.amountCents }],
  });
}

export async function postPaymentJournal(tx: Queryable, input: {
  tenantId: string; paymentId: string; orderId: string; direction: Direction; amountCents: number; postedAt: string; createdBy: string;
  /** Currency is optional for backwards-compatible internal callers; API paths always pass the order currency. */
  currency?: string;
}) {
  const isReceivable = input.direction === "receivable";
  return postJournal(tx, {
    tenantId: input.tenantId,
    postedAt: input.postedAt,
    sourceType: "payment",
    sourceId: input.paymentId,
    description: isReceivable ? "收到客户货款" : "支付供应商货款",
    createdBy: input.createdBy,
    currency: input.currency,
    lines: isReceivable
      ? [{ accountCode: "1002", debitCents: input.amountCents }, { accountCode: "1122", creditCents: input.amountCents }]
      : [{ accountCode: "2202", debitCents: input.amountCents }, { accountCode: "1002", creditCents: input.amountCents }],
  });
}

export async function postPaymentReversalJournal(tx: Queryable, input: {
  tenantId: string; reversalId: string; paymentId: string; direction: Direction; amountCents: number; postedAt: string; createdBy: string;
  /** Currency is optional for backwards-compatible internal callers; API paths always pass the order currency. */
  currency?: string;
}) {
  const isReceivable = input.direction === "receivable";
  return postJournal(tx, {
    tenantId: input.tenantId,
    postedAt: input.postedAt,
    sourceType: "payment.reversal",
    sourceId: input.reversalId,
    description: isReceivable ? "冲销客户收款" : "冲销供应商付款",
    createdBy: input.createdBy,
    currency: input.currency,
    lines: isReceivable
      ? [{ accountCode: "1122", debitCents: input.amountCents }, { accountCode: "1002", creditCents: input.amountCents }]
      : [{ accountCode: "1002", debitCents: input.amountCents }, { accountCode: "2202", creditCents: input.amountCents }],
  });
}
