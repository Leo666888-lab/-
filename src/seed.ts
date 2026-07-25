import bcrypt from "bcryptjs";
import type { Database } from "./db/types.js";

export const DEMO_IDS = {
  tenant: "11111111-1111-4111-8111-111111111111",
  user: "22222222-2222-4222-8222-222222222222",
  customer: "33333333-3333-4333-8333-333333333333",
  supplier: "44444444-4444-4444-8444-444444444444",
  receivableOrder: "55555555-5555-4555-8555-555555555555",
  payableOrder: "66666666-6666-4666-8666-666666666666",
  payment: "77777777-7777-4777-8777-777777777777",
  reminder: "88888888-8888-4888-8888-888888888888",
} as const;

export async function seedDemo(database: Database): Promise<void> {
  const passwordHash = await bcrypt.hash("demo1234", 12);
  await database.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO tenants (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [DEMO_IDS.tenant, "义乌市糖安贸易有限公司"],
    );
    await tx.query(
      `INSERT INTO users (id, phone, display_name, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone) DO UPDATE
       SET display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash, is_active = true, updated_at = now()`,
      [DEMO_IDS.user, "13800000000", "超级管理员", passwordHash],
    );
    await tx.query(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'owner', is_active = true`,
      [DEMO_IDS.tenant, DEMO_IDS.user],
    );
    await tx.query(
      `INSERT INTO partners (id, tenant_id, name, kind, contact_name, phone)
       VALUES ($1, $2, $3, 'customer', $4, $5)
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [DEMO_IDS.customer, DEMO_IDS.tenant, "迪拜星光百货", "Ahmed", "+971500000001"],
    );
    await tx.query(
      `INSERT INTO partners (id, tenant_id, name, kind, contact_name, phone)
       VALUES ($1, $2, $3, 'supplier', $4, $5)
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [DEMO_IDS.supplier, DEMO_IDS.tenant, "浦江锦程袜业", "陈经理", "13800000001"],
    );

    await tx.query(
      `INSERT INTO orders (
         id, tenant_id, partner_id, order_no, direction, order_date, planned_delivery_date,
         fulfillment_status, fulfilled_at, settlement_days, settlement_months, due_at, currency, total_cents, notes, created_by
       ) VALUES ($1, $2, $3, 'SY-20260724-001', 'receivable', '2026-07-01', '2026-07-10',
         'fulfilled', '2026-07-10T02:00:00Z', 7, 0, '2026-07-17T02:00:00Z', 'CNY', 1280000, '演示应收订单', $4)
       ON CONFLICT (tenant_id, order_no) DO NOTHING`,
      [DEMO_IDS.receivableOrder, DEMO_IDS.tenant, DEMO_IDS.customer, DEMO_IDS.user],
    );
    await tx.query(
      `INSERT INTO order_items (id, tenant_id, order_id, description, quantity, unit_price_cents, line_total_cents)
       VALUES
         ('99999999-9999-4999-8999-999999999991', $1, $2, '儿童袜 24双/箱', 200, 2400, 480000),
         ('99999999-9999-4999-8999-999999999992', $1, $2, '运动袜 40双/箱', 200, 4000, 800000)
       ON CONFLICT (id) DO NOTHING`,
      [DEMO_IDS.tenant, DEMO_IDS.receivableOrder],
    );
    await tx.query(
      `INSERT INTO payments (id, tenant_id, order_id, amount_cents, method, paid_at, note, idempotency_key, request_hash, created_by)
       VALUES ($1, $2, $3, 300000, 'bank_transfer', '2026-07-18T03:00:00Z', '演示首款', 'seed-payment-001', repeat('0', 64), $4)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
      [DEMO_IDS.payment, DEMO_IDS.tenant, DEMO_IDS.receivableOrder, DEMO_IDS.user],
    );
    await tx.query(
      `INSERT INTO reminders (id, tenant_id, order_id, due_at, status)
       VALUES ($1, $2, $3, '2026-07-17T02:00:00Z', 'open')
       ON CONFLICT (id) DO NOTHING`,
      [DEMO_IDS.reminder, DEMO_IDS.tenant, DEMO_IDS.receivableOrder],
    );

    await tx.query(
      `INSERT INTO orders (
         id, tenant_id, partner_id, order_no, direction, order_date, planned_delivery_date,
         fulfillment_status, settlement_days, settlement_months, currency, total_cents, notes, created_by
       ) VALUES ($1, $2, $3, 'SY-P20260724-001', 'payable', '2026-07-20', '2026-08-01',
         'planned', 0, 3, 'CNY', 1760000, '待交货演示订单', $4)
       ON CONFLICT (tenant_id, order_no) DO NOTHING`,
      [DEMO_IDS.payableOrder, DEMO_IDS.tenant, DEMO_IDS.supplier, DEMO_IDS.user],
    );
    await tx.query(
      `INSERT INTO order_items (id, tenant_id, order_id, description, quantity, unit_price_cents, line_total_cents)
       VALUES ('99999999-9999-4999-8999-999999999993', $1, $2, '中筒袜', 400, 4400, 1760000)
       ON CONFLICT (id) DO NOTHING`,
      [DEMO_IDS.tenant, DEMO_IDS.payableOrder],
    );
  });
}
