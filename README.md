# 结算管理商业版服务

独立的 TypeScript 后端工程，面向多企业的应收、应付、分次结算和到期提醒。现有
`settlement-demo` 只是界面原型，本工程不依赖也不修改它。

## 技术栈

- Fastify + Zod + TypeScript
- 本地和自动化测试：PGlite（真实 PostgreSQL 引擎，免安装服务）
- 生产环境：PostgreSQL，通过 `pg` 连接池访问
- 纯 SQL 迁移，迁移文件位于 `migrations/`
- 迁移使用事务级 advisory lock 与 SHA-256 checksum，已执行的 SQL 文件不得修改或删除
- bcryptjs 密码散列；随机会话令牌只在登录响应出现一次，数据库只存 SHA-256 摘要
- 金额统一使用整数分，订单总额由服务端逐项计算
- 同源托管 `public/` 商业前端，非 API 页面路由回退到 SPA 首页
- HttpOnly、SameSite=Strict 会话 Cookie；生产环境自动增加 Secure，并对写请求严格校验 Origin
- 所有 `/api` 响应（包括错误）发送 `Cache-Control: no-store`，避免敏感财务数据被缓存

需要 Node.js 22 或更高版本。

## 本地运行

```bash
npm install
cp .env.example .env
npm run migrate
npm run seed
npm run dev
```

默认地址为 `http://127.0.0.1:666`。执行 `npm run seed` 后可使用演示账号：

```text
手机号：13800000000
密码：demo1234
```

不设置 `DATABASE_URL` 时使用 `.pglite` 本地数据库。连接生产 PostgreSQL 时设置：

```bash
DATABASE_URL=postgres://settlement:strong-password@db-host:5432/settlement
NODE_ENV=production
PORT=666
PUBLIC_ORIGIN=https://123.56.254.236:666
SEED_DEMO=false
npm run migrate
npm start
```

`NODE_ENV=production` 时服务和数据库层都会拒绝 PGlite、非 PostgreSQL URL、
缺失或非 HTTPS 的 `PUBLIC_ORIGIN` 及 `SEED_DEMO=true`，防止把本地演示配置带入生产。
`PUBLIC_ORIGIN` 必须是浏览器实际访问的完整来源（协议、主机和端口）；当前部署值为
`https://123.56.254.236:666`。PostgreSQL 的 `DATE` 类型保持为
`YYYY-MM-DD` 字符串，不会因服务器或上海时区转换而前移一天。

## 初始化首个 Owner

生产环境不使用 Demo seed。通过部署平台的 secret manager 设置以下变量，或在受控终端中
交互读取密码后执行一次 provisioning：

```bash
export PROVISION_TENANT_NAME="义乌示例贸易"
export PROVISION_TENANT_TIMEZONE="Asia/Shanghai"
export PROVISION_OWNER_PHONE="13800000000"
export PROVISION_OWNER_NAME="企业负责人"
read -s PROVISION_OWNER_PASSWORD && export PROVISION_OWNER_PASSWORD
npm run provision-owner
unset PROVISION_OWNER_PASSWORD
```

密码至少 12 位。命令会执行迁移，并在一个事务中创建企业、owner 用户、owner membership
和审计记录。重复企业名或手机号会整笔回滚；输出只包含新建 ID，不打印密码。

## 迁移规则

只允许新增按序编号的 SQL 文件，禁止修改或删除已发布的 `001/002/003/004`。首次从旧版
`schema_migrations` 升级时，系统会增加 `checksum` 并以当前文件建立基线；此后任何历史
文件变化都会阻止迁移。迁移在同一数据库事务中持有 advisory lock，避免多个实例同时执行。
`003` 为旧版 `001` 数据库补齐企业时区、联系人版本及交货日期约束；`004` 新增只追加的
付款冲销记录与数据库防修改/删除触发器。若旧库已有违反约束的数据，迁移会失败并要求
人工核实，不会自动伪造或覆盖历史记录。

生产构建：

```bash
npm run build
npm start
```

## 测试

```bash
npm test
```

测试使用 Fastify `inject` 和独立的内存 PGlite，覆盖：正确/错误登录、会话摘要、租户
隔离、viewer 禁止写、重复订单号、服务端金额计算、显式交货、交货前禁付款、三个月
日历账期、付款时间校验、完整请求幂等、并发付款、超额拒绝、部分结算、结清关闭提醒、
付款全额冲销、净额余额、冲销后重开提醒、替代付款、计划订单取消、提醒提前 7 天/次日重现、
分币种余额、联系人版本冲突、Cookie 登录/登出、修改密码、
手机号规范化登录限流、可信代理边界、Cookie Origin 防护、用户行锁、API 禁止缓存、
SPA 回退、安全响应头、请求体上限、UTF-8 中英阿文本和审计记录。

## 核心规则

- 每个请求通过 session 固定到一个 `tenant_id`；业务 SQL 必须同时按该值过滤。
- 每个企业保存 IANA 时区（演示企业为 `Asia/Shanghai`）；按月账期在企业本地日历计算，
  能正确处理 UTC 跨日、月底、闰年和跨年。
- 角色为 `owner`、`finance`、`sales`、`viewer`。viewer 只读；sales 不能记收付款或读取审计。
- 联系人修改必须携带当前 `version`；成功后版本加一，旧版本返回 409，避免覆盖并发修改。
- 修改密码需验证当前密码且新密码至少 12 位；成功后保留当前会话并撤销其他会话。
- 新订单固定为 `planned`。计划交货日期只是计划，不会自动变为实际交货。
- 只有调用 `POST /api/orders/:id/fulfill` 后，订单才进入应收/应付并创建提醒。
- `paidCents` 和 `settlementStatus` 始终由未冲销付款净额聚合派生，客户端不能直接写入。
- 付款在数据库事务内锁定订单；超出未结金额会被拒绝。
- 付款时间最多允许比服务器时间快 5 分钟；更晚的未来付款会被拒绝。
- `Idempotency-Key` 必填。服务端锁定租户与幂等键，并校验完整请求指纹。
- 幂等重试稳定返回同一个 `paymentId` 和查询当时的最新订单视图；当前不保存首次响应快照。
- 最后一笔款结清时，同一事务会关闭该订单的全部未关闭提醒。
- 付款不能修改或删除；owner / finance 只能用带原因和 `Idempotency-Key` 的全额冲销纠错。
  冲销记录由数据库触发器禁止修改和删除，订单详情仍保留原付款及冲销原因。
- 已结清订单发生冲销时保留旧的已关闭提醒，并按原到期日创建新的未关闭提醒。
- `planned` 且从未出现任何付款记录的订单可由 owner / finance / sales 取消；重复取消不会
  重复写审计，已交货或有历史付款的订单不能取消。
- 普通提醒在到期前 7 天进入列表；确认后安排到企业本地次日 09:00 再次出现，逾期后
  可每天处理，只有结清才永久关闭。
- 联系人余额通过 `balances: [{ currency, receivableCents, payableCents }]` 分币种返回，
  不会把 CNY、USD 等不同币种直接相加。
- 创建订单、确认交货、付款、提醒确认/暂缓和登录均写入只追加的审计记录。

## API

同源浏览器会自动使用 HttpOnly Cookie。脚本和既有集成也可继续使用请求头：

```text
Authorization: Bearer <token>
```

Cookie 会话执行 `POST`、`PUT`、`PATCH` 或 `DELETE` 时必须携带与 `PUBLIC_ORIGIN`
完全一致的 `Origin` 请求头；Bearer 集成不受该浏览器来源校验影响。

| 方法 | 路径 | 权限/说明 |
| --- | --- | --- |
| GET | `/api/health` | 数据库健康检查 |
| POST | `/api/auth/login` | 手机号密码登录 |
| POST | `/api/auth/logout` | 撤销当前 session 并清除 Cookie |
| POST | `/api/auth/change-password` | 当前密码 + 至少 12 位新密码 |
| GET | `/api/bootstrap` | 当前租户初始化数据 |
| GET | `/api/partners` | 当前租户往来单位与分币种余额 |
| POST | `/api/partners` | owner / finance / sales；创建往来单位 |
| PATCH | `/api/partners/:id` | owner / finance / sales；必须携带 `version` |
| GET | `/api/orders` | 订单列表，可按方向和交货状态过滤 |
| POST | `/api/orders` | owner / finance / sales；服务端计算总额 |
| GET | `/api/orders/:id` | 单语句快照返回订单、明细及付款/冲销详情 |
| POST | `/api/orders/:id/cancel` | owner / finance / sales；仅无付款的 planned 订单 |
| POST | `/api/orders/:id/fulfill` | 显式确认实际交货 |
| POST | `/api/orders/:id/payments` | owner / finance；必须带 `Idempotency-Key` |
| POST | `/api/payments/:id/reverse` | owner / finance；全额冲销，原因和 `Idempotency-Key` 必填 |
| POST | `/api/reminders/:id/ack` | 确认提醒 |
| POST | `/api/reminders/:id/snooze` | 暂缓提醒 |
| GET | `/api/audit` | owner / finance；审计记录 |

创建三个月账期订单示例：

```json
{
  "partnerId": "33333333-3333-4333-8333-333333333333",
  "orderNo": "YW-2026-0001",
  "direction": "receivable",
  "orderDate": "2026-07-24",
  "plannedDeliveryDate": "2026-07-31",
  "settlementMonths": 3,
  "currency": "CNY",
  "items": [
    { "description": "运动袜", "quantity": 100, "unitPriceCents": 1250 }
  ]
}
```

确认交货后登记部分付款：

```bash
curl -X POST http://127.0.0.1:666/api/orders/ORDER_ID/payments \
  -H "Authorization: Bearer TOKEN" \
  -H "Idempotency-Key: payment-ORDER_ID-001" \
  -H "Content-Type: application/json" \
  -d '{"amountCents":50000,"method":"bank_transfer"}'
```

## 上线边界

本阶段完成的是账务 API 基础。正式连接互联网前仍需在其上增加对象存储直传与文件扫描、
短信/微信服务、定时通知 worker、分布式登录限流存储与验证码、备份恢复演练、集中日志监控。
当前基础登录限流为单进程内存实现，多应用实例上线前应迁移到 Redis。通用
`idempotency_records` 响应快照、数据库 RLS 租户隔离和可校验
防篡改审计链也应在公开上线前完成。不能把演示密码或 `SEED_DEMO=true` 带到生产环境。
