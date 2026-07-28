import type { Queryable } from "./db/types.js";
import { ApiError } from "./lib/errors.js";

export interface AccountingPeriodBounds {
  period: string | null;
  startDate: string | null;
  endDate: string | null;
  endExclusive: string | null;
  asOfDate: string;
}

interface AccountMovement extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  category: string;
  normal_side: "debit" | "credit";
  opening_debit_cents: string;
  opening_credit_cents: string;
  period_debit_cents: string;
  period_credit_cents: string;
  ending_debit_cents: string;
  ending_credit_cents: string;
}

interface CashOpeningRow extends Record<string, unknown> {
  currency: string;
  opening_balance_cents: string;
}

interface CashMovementRow extends Record<string, unknown> {
  currency: string;
  prior_debit_cents: string;
  prior_credit_cents: string;
  period_debit_cents: string;
  period_credit_cents: string;
  operating_inflow_cents: string;
  operating_outflow_cents: string;
}

const BASE_CURRENCY = "CNY";

interface CurrencyRow extends Record<string, unknown> {
  currency: string;
}

/**
 * The first-stage ledger stores original cents but does not yet store an FX
 * rate/base-currency amount. Aggregating a non-CNY journal with CNY would be
 * mathematically valid JavaScript but financially wrong, so the report APIs
 * fail closed until the currency conversion layer is configured.
 */
async function ensureBaseCurrencyReportSafe(
  database: Queryable,
  tenantId: string,
  bounds: AccountingPeriodBounds,
): Promise<string> {
  await ensureEntryCurrencyConsistency(database, tenantId, bounds);

  const result = await database.query<CurrencyRow>(
    `SELECT DISTINCT currency
       FROM (
         SELECT btrim(entry.currency)::text AS currency
           FROM journal_entries entry
          WHERE entry.tenant_id = $1
            AND ($2::date IS NULL OR entry.entry_date <= $2::date)
         UNION
         SELECT btrim(line.currency)::text AS currency
           FROM journal_entries entry
           JOIN journal_lines line
             ON line.tenant_id = entry.tenant_id AND line.journal_entry_id = entry.id
          WHERE entry.tenant_id = $1
            AND ($2::date IS NULL OR entry.entry_date <= $2::date)
         UNION
         SELECT btrim(o.currency)::text AS currency
           FROM orders o
          WHERE o.tenant_id = $1
            AND o.fulfillment_status = 'fulfilled'
            AND ($2::date IS NULL OR o.fulfilled_at < ($2::date + interval '1 day'))
         UNION
         SELECT btrim(bank.currency)::text AS currency
           FROM bank_accounts bank
          WHERE bank.tenant_id = $1 AND bank.opening_balance_cents <> 0
       ) currencies
      WHERE currency <> ''
      ORDER BY currency`,
    [tenantId, bounds.endDate],
  );
  const currencies = result.rows.map((row) => String(row.currency).trim()).filter(Boolean);
  const unsupported = currencies.filter((currency) => currency !== BASE_CURRENCY);
  if (unsupported.length) {
    throw new ApiError(409, "FOREIGN_CURRENCY_REPORT_UNAVAILABLE", "外币尚未完成汇率和本位币折算，已阻止生成可能混币的报表", {
      currencyUnsafe: true,
      baseCurrency: BASE_CURRENCY,
      currencies,
      unsupportedCurrencies: unsupported,
    });
  }
  return BASE_CURRENCY;
}

async function ensureEntryCurrencyConsistency(
  database: Queryable,
  tenantId: string,
  bounds: AccountingPeriodBounds,
): Promise<void> {
  const mismatch = await database.query(
    `SELECT entry.currency AS entry_currency, line.currency AS line_currency,
            bank.currency AS bank_currency
       FROM journal_entries entry
       JOIN journal_lines line
         ON line.tenant_id = entry.tenant_id AND line.journal_entry_id = entry.id
       LEFT JOIN bank_accounts bank
         ON bank.tenant_id = line.tenant_id AND bank.id = line.bank_account_id
      WHERE entry.tenant_id = $1
        AND ($2::date IS NULL OR entry.entry_date <= $2::date)
        AND (btrim(entry.currency) <> btrim(line.currency)
             OR (bank.id IS NOT NULL AND btrim(bank.currency) <> btrim(line.currency)))
      LIMIT 1`,
    [tenantId, bounds.endDate],
  );
  if (mismatch.rowCount) {
    const row = mismatch.rows[0];
    if (!row) throw new ApiError(409, "ACCOUNTING_CURRENCY_MISMATCH", "凭证币种数据异常，已阻止生成报表", { currencyUnsafe: true });
    throw new ApiError(409, "ACCOUNTING_CURRENCY_MISMATCH", "凭证、分录与资金账户的币种不一致，已阻止生成报表", {
      currencyUnsafe: true,
      entryCurrency: String(row.entry_currency ?? "").trim(),
      lineCurrency: String(row.line_currency ?? "").trim(),
      bankCurrency: row.bank_currency ? String(row.bank_currency).trim() : null,
    });
  }
}

async function ensureJournalSourceCurrenciesSafe(
  database: Queryable,
  tenantId: string,
  bounds: AccountingPeriodBounds,
): Promise<void> {
  const result = await database.query(
    `SELECT entry.currency AS entry_currency,
            COALESCE(fulfillment_order.currency, payment_order.currency, reversal_order.currency) AS source_currency,
            entry.source_type
       FROM journal_entries entry
       LEFT JOIN orders fulfillment_order
         ON entry.source_type = 'order.fulfillment'
        AND fulfillment_order.tenant_id = entry.tenant_id
        AND fulfillment_order.id = entry.source_id
       LEFT JOIN payments payment
         ON entry.source_type = 'payment'
        AND payment.tenant_id = entry.tenant_id
        AND payment.id = entry.source_id
       LEFT JOIN orders payment_order
         ON payment_order.tenant_id = payment.tenant_id AND payment_order.id = payment.order_id
       LEFT JOIN payment_reversals reversal
         ON entry.source_type = 'payment.reversal'
        AND reversal.tenant_id = entry.tenant_id
        AND reversal.id = entry.source_id
       LEFT JOIN orders reversal_order
         ON reversal_order.tenant_id = reversal.tenant_id AND reversal_order.id = reversal.order_id
      WHERE entry.tenant_id = $1
        AND ($2::date IS NULL OR entry.entry_date <= $2::date)
        AND COALESCE(fulfillment_order.currency, payment_order.currency, reversal_order.currency) IS NOT NULL
        AND btrim(entry.currency) <> btrim(COALESCE(
          fulfillment_order.currency, payment_order.currency, reversal_order.currency
        ))
      LIMIT 1`,
    [tenantId, bounds.endDate],
  );
  if (result.rowCount) {
    const row = result.rows[0];
    if (!row) return;
    throw new ApiError(409, "ACCOUNTING_SOURCE_CURRENCY_MISMATCH", "自动凭证与来源订单币种不一致，已阻止生成报表", {
      currencyUnsafe: true,
      sourceType: row.source_type,
      entryCurrency: String(row.entry_currency ?? "").trim(),
      sourceCurrency: String(row.source_currency ?? "").trim(),
    });
  }
}

function cents(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) throw new ApiError(500, "UNSAFE_MONEY_VALUE", "报表金额超出安全范围");
  return parsed;
}

function add(values: number[]): number {
  return values.reduce((sum, value) => {
    const result = sum + value;
    if (!Number.isSafeInteger(result)) throw new ApiError(500, "UNSAFE_MONEY_VALUE", "报表金额超出安全范围");
    return result;
  }, 0);
}

function isoDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Resolve a YYYY-MM filter into inclusive and exclusive calendar dates. */
export function resolveAccountingPeriod(period?: string): AccountingPeriodBounds {
  if (period === undefined || period === "") {
    const today = isoDateUtc(new Date());
    return { period: null, startDate: null, endDate: null, endExclusive: null, asOfDate: today };
  }
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new ApiError(400, "INVALID_ACCOUNTING_PERIOD", "会计期间必须是 YYYY-MM 格式");
  }
  const [yearText, monthText] = period.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || year < 1900 || year > 2200 || month < 1 || month > 12) {
    throw new ApiError(400, "INVALID_ACCOUNTING_PERIOD", "会计期间无效");
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const next = new Date(Date.UTC(year, month, 1));
  const end = new Date(next.getTime() - 86_400_000);
  return {
    period,
    startDate: isoDateUtc(start),
    endDate: isoDateUtc(end),
    endExclusive: isoDateUtc(next),
    asOfDate: isoDateUtc(end),
  };
}

async function accountMovements(
  database: Queryable,
  tenantId: string,
  bounds: AccountingPeriodBounds,
): Promise<AccountMovement[]> {
  const result = await database.query<AccountMovement>(
    `SELECT account.id, account.code, account.name, account.category, account.normal_side,
            COALESCE(SUM(CASE WHEN entry.entry_date < COALESCE($3::date, entry.entry_date)
                              THEN line.debit_cents ELSE 0 END), 0)::text AS opening_debit_cents,
            COALESCE(SUM(CASE WHEN entry.entry_date < COALESCE($3::date, entry.entry_date)
                              THEN line.credit_cents ELSE 0 END), 0)::text AS opening_credit_cents,
            COALESCE(SUM(CASE WHEN $3::date IS NULL OR entry.entry_date >= $3::date
                              THEN line.debit_cents ELSE 0 END), 0)::text AS period_debit_cents,
            COALESCE(SUM(CASE WHEN $3::date IS NULL OR entry.entry_date >= $3::date
                              THEN line.credit_cents ELSE 0 END), 0)::text AS period_credit_cents,
            COALESCE(SUM(CASE WHEN $2::date IS NULL OR entry.entry_date <= $2::date
                              THEN line.debit_cents ELSE 0 END), 0)::text AS ending_debit_cents,
            COALESCE(SUM(CASE WHEN $2::date IS NULL OR entry.entry_date <= $2::date
                              THEN line.credit_cents ELSE 0 END), 0)::text AS ending_credit_cents
       FROM accounting_accounts account
       LEFT JOIN journal_lines line
         ON line.tenant_id = account.tenant_id AND line.account_id = account.id
       LEFT JOIN journal_entries entry
         ON entry.tenant_id = line.tenant_id AND entry.id = line.journal_entry_id
        AND ($2::date IS NULL OR entry.entry_date <= $2::date)
      WHERE account.tenant_id = $1
      GROUP BY account.id, account.code, account.name, account.category, account.normal_side
      ORDER BY account.code`,
    [tenantId, bounds.endDate, bounds.startDate],
  );
  return result.rows;
}

function accountBalance(row: AccountMovement, ending = true): number {
  const debit = cents(ending ? row.ending_debit_cents : row.period_debit_cents);
  const credit = cents(ending ? row.ending_credit_cents : row.period_credit_cents);
  return row.normal_side === "debit" ? debit - credit : credit - debit;
}

function mapMovement(row: AccountMovement) {
  const openingDebitCents = cents(row.opening_debit_cents);
  const openingCreditCents = cents(row.opening_credit_cents);
  const periodDebitCents = cents(row.period_debit_cents);
  const periodCreditCents = cents(row.period_credit_cents);
  const endingDebitCents = cents(row.ending_debit_cents);
  const endingCreditCents = cents(row.ending_credit_cents);
  const endingBalanceCents = row.normal_side === "debit"
    ? endingDebitCents - endingCreditCents
    : endingCreditCents - endingDebitCents;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    normalSide: row.normal_side,
    openingDebitCents,
    openingCreditCents,
    periodDebitCents,
    periodCreditCents,
    debitCents: endingDebitCents,
    creditCents: endingCreditCents,
    endingBalanceCents,
    balanceSide: endingBalanceCents < 0
      ? (row.normal_side === "debit" ? "credit" : "debit")
      : row.normal_side,
  };
}

export async function getTrialBalance(
  database: Queryable,
  tenantId: string,
  period?: string,
) {
  const bounds = resolveAccountingPeriod(period);
  const currency = await ensureBaseCurrencyReportSafe(database, tenantId, bounds);
  await ensureJournalSourceCurrenciesSafe(database, tenantId, bounds);
  const movements = await accountMovements(database, tenantId, bounds);
  const accounts = movements.map(mapMovement);
  const totals = {
    openingDebitCents: add(accounts.map((account) => account.openingDebitCents)),
    openingCreditCents: add(accounts.map((account) => account.openingCreditCents)),
    periodDebitCents: add(accounts.map((account) => account.periodDebitCents)),
    periodCreditCents: add(accounts.map((account) => account.periodCreditCents)),
    debitCents: add(accounts.map((account) => account.debitCents)),
    creditCents: add(accounts.map((account) => account.creditCents)),
  };
  return {
    period: bounds.period,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    currency,
    currencyUnsafe: false,
    accounts,
    totals: {
      ...totals,
      differenceCents: totals.debitCents - totals.creditCents,
    },
    balanced: totals.debitCents === totals.creditCents,
  };
}

function incomeAmount(row: AccountMovement): number {
  const debit = cents(row.period_debit_cents);
  const credit = cents(row.period_credit_cents);
  return row.category === "revenue" ? credit - debit : debit - credit;
}

export async function getIncomeStatement(
  database: Queryable,
  tenantId: string,
  period?: string,
) {
  const bounds = resolveAccountingPeriod(period);
  const currency = await ensureBaseCurrencyReportSafe(database, tenantId, bounds);
  await ensureJournalSourceCurrenciesSafe(database, tenantId, bounds);
  const movements = await accountMovements(database, tenantId, bounds);
  const lines = movements
    .filter((row) => row.category === "revenue" || row.category === "cost" || row.category === "expense")
    .map((row) => ({
      code: row.code,
      name: row.name,
      category: row.category,
      amountCents: incomeAmount(row),
      debitCents: cents(row.period_debit_cents),
      creditCents: cents(row.period_credit_cents),
    }));
  const revenueCents = add(lines.filter((line) => line.category === "revenue").map((line) => line.amountCents));
  const costCents = add(lines.filter((line) => line.category === "cost").map((line) => line.amountCents));
  const expenseCents = add(lines.filter((line) => line.category === "expense").map((line) => line.amountCents));
  return {
    period: bounds.period,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    currency,
    currencyUnsafe: false,
    lines,
    revenue: lines.filter((line) => line.category === "revenue"),
    costs: lines.filter((line) => line.category === "cost"),
    expenses: lines.filter((line) => line.category === "expense"),
    totals: { revenueCents, costCents, expenseCents, profitCents: revenueCents - costCents - expenseCents },
  };
}

export async function getBalanceSheet(
  database: Queryable,
  tenantId: string,
  period?: string,
) {
  const bounds = resolveAccountingPeriod(period);
  const currency = await ensureBaseCurrencyReportSafe(database, tenantId, bounds);
  await ensureJournalSourceCurrenciesSafe(database, tenantId, bounds);
  const movements = await accountMovements(database, tenantId, bounds);
  const lines = movements
    .filter((row) => row.category === "asset" || row.category === "liability" || row.category === "equity")
    .map((row) => ({
      code: row.code,
      name: row.name,
      category: row.category,
      balanceCents: accountBalance(row),
      debitCents: cents(row.ending_debit_cents),
      creditCents: cents(row.ending_credit_cents),
    }));
  const assets = lines.filter((line) => line.category === "asset");
  const liabilities = lines.filter((line) => line.category === "liability");
  const equity = lines.filter((line) => line.category === "equity");
  const profit = add(movements
    .filter((row) => row.category === "revenue" || row.category === "cost" || row.category === "expense")
    .map((row) => {
      const debit = cents(row.ending_debit_cents);
      const credit = cents(row.ending_credit_cents);
      return row.category === "revenue" ? credit - debit : debit - credit;
    }));
  const assetTotalCents = add(assets.map((line) => line.balanceCents));
  const liabilityTotalCents = add(liabilities.map((line) => line.balanceCents));
  const equityAccountTotalCents = add(equity.map((line) => line.balanceCents));
  const totalEquityCents = equityAccountTotalCents + profit;
  return {
    period: bounds.period,
    asOfDate: bounds.asOfDate,
    currency,
    currencyUnsafe: false,
    assets,
    liabilities,
    equity,
    currentProfit: { code: "CURRENT_PROFIT", name: "本年利润（未结转）", balanceCents: profit },
    totals: {
      assetCents: assetTotalCents,
      liabilityCents: liabilityTotalCents,
      equityCents: totalEquityCents,
      liabilitiesAndEquityCents: liabilityTotalCents + totalEquityCents,
      differenceCents: assetTotalCents - liabilityTotalCents - totalEquityCents,
    },
    balanced: assetTotalCents === liabilityTotalCents + totalEquityCents,
  };
}

/**
 * Build a direct-method cash flow statement from posted bank journal lines.
 * Payment and payment-reversal journals are operating flows; any other bank
 * journal source is kept visible as unclassified until a mapping rule exists.
 */
export async function getCashFlowStatement(
  database: Queryable,
  tenantId: string,
  period?: string,
) {
  const bounds = resolveAccountingPeriod(period);
  await ensureEntryCurrencyConsistency(database, tenantId, bounds);
  await ensureJournalSourceCurrenciesSafe(database, tenantId, bounds);
  const openingResult = await database.query<CashOpeningRow>(
    `SELECT currency, COALESCE(SUM(opening_balance_cents), 0)::text AS opening_balance_cents
       FROM bank_accounts
      WHERE tenant_id = $1
      GROUP BY currency
      ORDER BY currency`,
    [tenantId],
  );
  const movementResult = await database.query<CashMovementRow>(
    `SELECT bank.currency,
            COALESCE(SUM(CASE WHEN $2::date IS NOT NULL AND entry.entry_date < $2::date
                              THEN line.debit_cents ELSE 0 END), 0)::text AS prior_debit_cents,
            COALESCE(SUM(CASE WHEN $2::date IS NOT NULL AND entry.entry_date < $2::date
                              THEN line.credit_cents ELSE 0 END), 0)::text AS prior_credit_cents,
            COALESCE(SUM(CASE WHEN ($2::date IS NULL OR entry.entry_date >= $2::date)
                                   AND ($3::date IS NULL OR entry.entry_date < $3::date)
                              THEN line.debit_cents ELSE 0 END), 0)::text AS period_debit_cents,
            COALESCE(SUM(CASE WHEN ($2::date IS NULL OR entry.entry_date >= $2::date)
                                   AND ($3::date IS NULL OR entry.entry_date < $3::date)
                              THEN line.credit_cents ELSE 0 END), 0)::text AS period_credit_cents,
            COALESCE(SUM(CASE WHEN ($2::date IS NULL OR entry.entry_date >= $2::date)
                                   AND ($3::date IS NULL OR entry.entry_date < $3::date)
                                   AND entry.source_type IN ('payment', 'payment.reversal')
                              THEN line.debit_cents ELSE 0 END), 0)::text AS operating_inflow_cents,
            COALESCE(SUM(CASE WHEN ($2::date IS NULL OR entry.entry_date >= $2::date)
                                   AND ($3::date IS NULL OR entry.entry_date < $3::date)
                                   AND entry.source_type IN ('payment', 'payment.reversal')
                              THEN line.credit_cents ELSE 0 END), 0)::text AS operating_outflow_cents
       FROM journal_entries entry
       JOIN journal_lines line
         ON line.tenant_id = entry.tenant_id AND line.journal_entry_id = entry.id
       JOIN bank_accounts bank
         ON bank.tenant_id = line.tenant_id AND bank.id = line.bank_account_id
      WHERE entry.tenant_id = $1
        AND ($3::date IS NULL OR entry.entry_date < $3::date)
      GROUP BY bank.currency
      ORDER BY bank.currency`,
    [tenantId, bounds.startDate, bounds.endExclusive],
  );

  const openingByCurrency = new Map(openingResult.rows.map((row) => [row.currency, row]));
  const movementByCurrency = new Map(movementResult.rows.map((row) => [row.currency, row]));
  const currencyCodes = [...new Set([...openingByCurrency.keys(), ...movementByCurrency.keys()])].sort();
  const currencies = currencyCodes.map((currency) => {
    const opening = openingByCurrency.get(currency);
    const movement = movementByCurrency.get(currency);
    const configuredOpeningCents = cents(opening?.opening_balance_cents);
    const priorInflowCents = cents(movement?.prior_debit_cents);
    const priorOutflowCents = cents(movement?.prior_credit_cents);
    const periodInflowCents = cents(movement?.period_debit_cents);
    const periodOutflowCents = cents(movement?.period_credit_cents);
    const operatingInflowCents = cents(movement?.operating_inflow_cents);
    const operatingOutflowCents = cents(movement?.operating_outflow_cents);
    const operatingNetCents = add([operatingInflowCents, -operatingOutflowCents]);
    const unclassifiedInflowCents = add([periodInflowCents, -operatingInflowCents]);
    const unclassifiedOutflowCents = add([periodOutflowCents, -operatingOutflowCents]);
    const unclassifiedNetCents = add([unclassifiedInflowCents, -unclassifiedOutflowCents]);
    const openingBalanceCents = add([configuredOpeningCents, priorInflowCents, -priorOutflowCents]);
    const cashDifferenceCents = add([periodInflowCents, -periodOutflowCents]);
    const endingBalanceCents = add([openingBalanceCents, cashDifferenceCents]);
    const reconciliationDifferenceCents = add([
      cashDifferenceCents,
      -operatingNetCents,
      -unclassifiedNetCents,
    ]);
    return {
      currency,
      operating: {
        inflowCents: operatingInflowCents,
        outflowCents: operatingOutflowCents,
        netCents: operatingNetCents,
      },
      unclassified: {
        inflowCents: unclassifiedInflowCents,
        outflowCents: unclassifiedOutflowCents,
        netCents: unclassifiedNetCents,
      },
      cash: {
        openingBalanceCents,
        endingBalanceCents,
        differenceCents: cashDifferenceCents,
      },
      reconciliationDifferenceCents,
      reconciled: reconciliationDifferenceCents === 0,
    };
  });
  return {
    period: bounds.period,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    currencies,
    currencyUnsafe: false,
    reconciled: currencies.every((currency) => currency.reconciled),
  };
}

type AgingBucket = "not_due" | "0_30" | "31_60" | "61_90" | "91_180" | "181_365" | "over_365";

interface AgingOrderRow extends Record<string, unknown> {
  id: string;
  order_no: string;
  direction: "receivable" | "payable";
  partner_id: string;
  partner_name: string;
  due_date: string;
  outstanding_cents: string;
  bucket: AgingBucket;
  currency: string;
}

function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue < 0) return "not_due";
  if (daysOverdue <= 30) return "0_30";
  if (daysOverdue <= 60) return "31_60";
  if (daysOverdue <= 90) return "61_90";
  if (daysOverdue <= 180) return "91_180";
  if (daysOverdue <= 365) return "181_365";
  return "over_365";
}

export async function getAgingReport(
  database: Queryable,
  tenantId: string,
  period?: string,
) {
  const bounds = resolveAccountingPeriod(period);
  const currency = await ensureBaseCurrencyReportSafe(database, tenantId, bounds);
  await ensureJournalSourceCurrenciesSafe(database, tenantId, bounds);
  const cutoff = bounds.endDate;
  const result = await database.query<AgingOrderRow>(
    `WITH paid AS (
       SELECT pay.order_id,
              COALESCE(SUM(pay.amount_cents) FILTER (
                WHERE ($2::date IS NULL OR pay.paid_at < ($2::date + interval '1 day'))
                  AND NOT EXISTS (
                    SELECT 1 FROM payment_reversals reversal
                     WHERE reversal.tenant_id = pay.tenant_id
                       AND reversal.payment_id = pay.id
                       AND reversal.order_id = pay.order_id
                       AND ($2::date IS NULL OR reversal.reversed_at < ($2::date + interval '1 day'))
                  )
              ), 0)::text AS paid_cents
         FROM payments pay
        WHERE pay.tenant_id = $1
        GROUP BY pay.order_id
     )
     SELECT o.id, o.order_no, o.direction, o.partner_id, partner.name AS partner_name,
            o.due_at::date::text AS due_date, o.currency,
            GREATEST(o.total_cents - COALESCE(paid.paid_cents::bigint, 0), 0)::text AS outstanding_cents,
            CASE
              WHEN o.due_at::date > COALESCE($2::date, CURRENT_DATE) THEN 'not_due'
              WHEN (COALESCE($2::date, CURRENT_DATE) - o.due_at::date) <= 30 THEN '0_30'
              WHEN (COALESCE($2::date, CURRENT_DATE) - o.due_at::date) <= 60 THEN '31_60'
              WHEN (COALESCE($2::date, CURRENT_DATE) - o.due_at::date) <= 90 THEN '61_90'
              WHEN (COALESCE($2::date, CURRENT_DATE) - o.due_at::date) <= 180 THEN '91_180'
              WHEN (COALESCE($2::date, CURRENT_DATE) - o.due_at::date) <= 365 THEN '181_365'
              ELSE 'over_365'
            END AS bucket
       FROM orders o
       JOIN partners partner ON partner.tenant_id = o.tenant_id AND partner.id = o.partner_id
       LEFT JOIN paid ON paid.order_id = o.id
      WHERE o.tenant_id = $1
        AND o.fulfillment_status = 'fulfilled'
        AND o.due_at IS NOT NULL
        AND ($2::date IS NULL OR o.fulfilled_at < ($2::date + interval '1 day'))
        AND GREATEST(o.total_cents - COALESCE(paid.paid_cents::bigint, 0), 0) > 0
      ORDER BY o.due_at, o.order_no, o.id`,
    [tenantId, cutoff],
  );
  const orders = result.rows.map((row) => ({
    id: row.id,
    orderNo: row.order_no,
    direction: row.direction,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    dueDate: row.due_date,
    currency: row.currency,
    outstandingCents: cents(row.outstanding_cents),
    bucket: row.bucket,
  }));
  const bucketNames: AgingBucket[] = ["not_due", "0_30", "31_60", "61_90", "91_180", "181_365", "over_365"];
  const byDirection = (["receivable", "payable"] as const).map((direction) => ({
    direction,
    totalCents: add(orders.filter((order) => order.direction === direction).map((order) => order.outstandingCents)),
    buckets: Object.fromEntries(bucketNames.map((bucket) => [
      bucket,
      add(orders.filter((order) => order.direction === direction && order.bucket === bucket)
        .map((order) => order.outstandingCents)),
    ])),
  }));
  const buckets = Object.fromEntries(bucketNames.map((bucket) => [
    bucket,
    add(orders.filter((order) => order.bucket === bucket).map((order) => order.outstandingCents)),
  ]));
  return {
    period: bounds.period,
    asOfDate: bounds.asOfDate,
    currency,
    currencyUnsafe: false,
    buckets,
    byDirection,
    totalCents: add(orders.map((order) => order.outstandingCents)),
    orders,
  };
}
