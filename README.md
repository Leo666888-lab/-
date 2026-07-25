# 结算管理商业版服务

独立的 TypeScript 后端工程，面向多企业的应收、应付、分次结算和到期提醒。现有
`settlement-demo` 只是界面原型，本工程不依赖也不修改它。

## 技术栈

- Fastify + Zod + TypeScript
- 本地和自动化测试：PGlite（真实 PostgreSQL 引擎，免安装服务）
- 生产环境：PostgreSQL，通过 `pg` 连接池访问
- 生产临时状态：Tair/Redis，通过 TLS 私网连接；账务事实不写入 Redis
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
REDIS_URL=rediss://settlement-app:strong-password@tair-private-host:6379/0
REDIS_KEY_PREFIX=siyan-settlement-666:production:
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

只允许新增按序编号的 SQL 文件，禁止修改或删除已发布的 `001` 至 `008`。首次从旧版
`schema_migrations` 升级时，系统会增加 `checksum` 并以当前文件建立基线；此后任何历史
文件变化都会阻止迁移。迁移在同一数据库事务中持有 advisory lock，避免多个实例同时执行。
`003` 为旧版 `001` 数据库补齐企业时区、联系人版本及交货日期约束；`004` 新增只追加的
付款冲销记录；`005` 为付款与审计记录增加数据库防修改/删除触发器；`006` 增加只存摘要、
可过期和可撤销的成员邀请；`007` 增加只追加的订单更正快照；`008` 增加导入批次和订单来源关联。
若旧库已有违反约束的数据，迁移会失败并要求
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

CI 还会把 `tests/app.test.ts` 在一个名称以 `_ci` 结尾的空 PostgreSQL 数据库上再运行一次，
覆盖真实行锁、事务、幂等、租户隔离和只追加触发器语义。`TEST_DATABASE_URL` 会拒绝非
`_ci` / `_test` 数据库或已有企业数据的数据库，避免误连生产环境。

测试使用 Fastify `inject` 和独立的内存 PGlite，覆盖：正确/错误登录、会话摘要、租户
隔离、viewer 禁止写、重复订单号、服务端金额计算、显式交货、交货前禁付款、三个月
日历账期、付款时间校验、完整请求幂等、并发付款、超额拒绝、部分结算、结清关闭提醒、
付款全额冲销、付款与审计记录防修改、净额余额、冲销后重开提醒、替代付款、计划订单取消、提醒提前 7 天/次日重现、
分币种余额、联系人版本冲突、成员邀请/重发/角色/启停/最后 owner 并发保护、Cookie 登录/登出、修改密码、
手机号规范化登录限流、可信代理边界、Cookie Origin 防护、用户行锁、API 禁止缓存、
SPA 回退、安全响应头、请求体上限、UTF-8 中英阿文本、受控订单更正、CSV/XLSX 安全解析、
人工字段映射、导入幂等与租户隔离、发布工件、加密备份及恢复演练守卫。

## 核心规则

- 每个请求通过 session 固定到一个 `tenant_id`；业务 SQL 必须同时按该值过滤。
- 每个企业保存 IANA 时区（演示企业为 `Asia/Shanghai`）；按月账期在企业本地日历计算，
  能正确处理 UTC 跨日、月底、闰年和跨年。
- 角色为 `owner`、`finance`、`sales`、`viewer`。viewer 只读；sales 不能记收付款或读取审计。
- 只有 owner 可以查看和管理成员。邀请令牌使用 256 位随机值、数据库只保存 SHA-256 摘要，
  72 小时后过期且只能接受一次；重发会立即作废旧令牌。邀请设置至少 12 位密码后成员才启用。
- 停用成员会立即撤销该企业内的全部会话。角色降级和停用按企业串行执行，始终保留至少一名
  启用中的 owner。
- 联系人修改必须携带当前 `version`；成功后版本加一，旧版本返回 409，避免覆盖并发修改。
- 订单更正必须携带当前 `version` 和原因，并保存不可修改的更正前后快照。已有付款时不能更换
  往来单位、应收应付方向或币种，新金额不能低于已结金额。
- 修改密码需验证当前密码且新密码至少 12 位；成功后保留当前会话并撤销其他会话。
- 新订单固定为 `planned`。计划交货日期只是计划，不会自动变为实际交货。
- 只有调用 `POST /api/orders/:id/fulfill` 后，订单才进入应收/应付并创建提醒。
- 实际交货日期不得早于订货日期，且不能晚于服务器当前时间 5 分钟以上。
- `paidCents` 和 `settlementStatus` 始终由未冲销付款净额聚合派生，客户端不能直接写入。
- 付款在数据库事务内锁定订单；超出未结金额会被拒绝。
- 付款时间最多允许比服务器时间快 5 分钟；更晚的未来付款会被拒绝。
- `Idempotency-Key` 必填。服务端锁定租户与幂等键，并校验完整请求指纹。
- 幂等重试稳定返回同一个 `paymentId` 和查询当时的最新订单视图；当前不保存首次响应快照。
- 最后一笔款结清时，同一事务会关闭该订单的全部未关闭提醒。
- 付款不能修改或删除；owner / finance 只能用带原因和 `Idempotency-Key` 的全额冲销纠错。
  付款、冲销和审计记录均由数据库触发器禁止修改和删除，订单详情仍保留原付款及冲销原因。
- 已结清订单发生冲销时保留旧的已关闭提醒，并按原到期日创建新的未关闭提醒。
- `planned` 且从未出现任何付款记录的订单可由 owner / finance / sales 取消；重复取消不会
  重复写审计，已交货或有历史付款的订单不能取消。
- 普通提醒在到期前 7 天进入列表；确认后安排到企业本地次日 09:00 再次出现，逾期后
  可每天处理，只有结清才永久关闭。
- 联系人余额通过 `balances: [{ currency, receivableCents, payableCents }]` 分币种返回，
  不会把 CNY、USD 等不同币种直接相加。
- CSV/XLSX 首次预览可以只读取未知商家表头供人工映射；真正校验和提交仍要求完整必填映射。
  导入会拦截公式、宏、ActiveX、异常路径和异常压缩包，限制为 10 MB、1000 行。
- 导入提交必须携带 `Idempotency-Key`，只写入人工选择且校验通过的行；新订单保持 `planned`，
  不会因为导入而伪造实际交货或提前产生应收应付。
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
| GET | `/api/health` | 数据库与 Redis 健康状态；Redis 故障返回 HTTP 200 + `degraded`，数据库故障返回 503 |
| POST | `/api/auth/login` | 手机号密码登录 |
| POST | `/api/auth/accept-invitation` | 邀请令牌 + 至少 12 位密码；令牌只能使用一次 |
| POST | `/api/auth/logout` | 撤销当前 session 并清除 Cookie |
| POST | `/api/auth/change-password` | 当前密码 + 至少 12 位新密码 |
| GET | `/api/bootstrap` | 当前租户初始化数据 |
| GET | `/api/members` | owner；列出当前企业成员与邀请状态 |
| POST | `/api/members` | owner；创建未启用成员并返回一次性 72 小时邀请令牌 |
| POST | `/api/members/:id/reinvite` | owner；为未接受邀请的成员轮换并重发邀请令牌 |
| PATCH | `/api/members/:id/role` | owner；修改角色，禁止降级最后一个启用 owner |
| PATCH | `/api/members/:id/status` | owner；撤销待接受邀请，或停用/恢复已激活成员 |
| GET | `/api/partners` | 当前租户往来单位与分币种余额 |
| POST | `/api/partners` | owner / finance / sales；创建往来单位 |
| PATCH | `/api/partners/:id` | owner / finance / sales；必须携带 `version` |
| POST | `/api/order-imports/preview` | owner / finance / sales；安全解析、表头映射和逐行校验，不写账 |
| POST | `/api/order-imports/commit` | owner / finance / sales；必须带 `Idempotency-Key`，写入选中的有效行 |
| GET | `/api/orders` | 订单列表，可按方向和交货状态过滤 |
| POST | `/api/orders` | owner / finance / sales；服务端计算总额 |
| GET | `/api/orders/:id` | 单语句快照返回订单、明细及付款/冲销详情 |
| PATCH | `/api/orders/:id` | owner / finance / sales；携带版本、原因和完整修正内容，保留更正快照 |
| POST | `/api/orders/:id/cancel` | owner / finance / sales；仅无付款的 planned 订单 |
| POST | `/api/orders/:id/fulfill` | 显式确认实际交货 |
| POST | `/api/orders/:id/payments` | owner / finance；必须带 `Idempotency-Key` |
| POST | `/api/payments/:id/reverse` | owner / finance；全额冲销，原因和 `Idempotency-Key` 必填 |
| POST | `/api/reminders/:id/ack` | 确认提醒 |
| POST | `/api/reminders/:id/snooze` | 暂缓提醒 |
| GET | `/api/audit` | owner / finance；审计记录 |

`POST /api/members` 和重发接口返回的 `invitation.token` 只会出现一次，服务端无法找回明文。
应通过当面、企业密码管理器等受控渠道交给成员，不得写入日志或普通聊天记录。成员使用：

```json
POST /api/auth/accept-invitation
{
  "token": "一次性邀请令牌",
  "password": "至少12位的新密码"
}
```

邀请过期、被撤销或首次响应丢失时，由 owner 调用 `POST /api/members/:id/reinvite`；新令牌签发后，
旧令牌立即失效。已接受邀请的成员不能重发邀请，应使用停用/恢复和修改密码流程。

导入页面支持下载标准 CSV 模板。其他商家的 CSV/XLSX 可以在首次预览后人工匹配列；预览不会写账，
提交后会自动创建缺少的往来单位、待交货订单、商品明细、导入批次和审计记录。旧版 `.xls` 不接受，
应先在表格软件中另存为 `.xlsx` 或 `.csv`。

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

账务、成员、审计、订单更正和 Excel 导入已经形成服务端闭环；部署目录也提供隔离 systemd 服务、
发布工件校验、健康/TLS 检查、失败告警、age 加密异地备份及恢复演练守卫。但自动化脚本不能代替
真实环境证据：正式连接互联网前仍必须在目标 ECS 验证端口和目录无冲突、PostgreSQL 应用/备份
双角色、OSS 对象锁和最小权限、Webhook 到达、IP 证书续期链路、阿里云安全组，以及从异地备份
下载后在独立主机完成恢复演练。

仍未接入的产品服务包括付款凭证 OSS 直传与文件扫描、阿里云短信/语音/OCR、微信通知、定时通知
worker、短信验证码、集中日志平台，以及完整阿拉伯语 UI/RTL。登录限流已经使用 Redis 原子脚本，
并按 IP、手机号及两者组合做哈希后的跨实例限制；Redis 故障时登录失败关闭，已登录账务请求仍以
PostgreSQL 为准继续处理。数据库 RLS、通用幂等响应快照和可校验的
密码学审计链属于公开大规模上线前的进一步加固。生产环境不得使用演示密码或 `SEED_DEMO=true`。
