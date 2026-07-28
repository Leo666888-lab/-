# 阿里云生产资源开通清单

适用项目：思燕智能财务（义乌市糖安贸易有限公司 / 思燕家居）。

> 本清单全部是待开通、待配置、待验证事项，不代表任何资源已经购买或通过验收。第一次操作建议由
> 熟悉阿里云网络和数据库的人员陪同复核。密码、验证码、AccessKey 和完整连接串不得发到聊天中。

## 0. 企业认证等待期：现在可以完成什么

企业实名认证通常需要 2–3 个工作日。等待期间不需要停工，以下事项可以先完成，而且不依赖短信
签名或企业主体资质：

- [ ] 在本地和 CI 跑完 TypeScript、后端、Worker、导入、响应式前端和安全回归测试。
- [ ] 用 `fake` 短信/提醒 provider 验收验证码过期、限流、重复提交、分次收付款和提醒重试；生产环境仍必须保持 `SMS_ENABLED=false`，提醒 worker 保持 disabled。
- [ ] 准备正式业务参数：企业时区、提醒发送时间、提前天数、应收/应付负责人、成员角色、账期规则和备份保留期。
- [ ] 选择正式域名并确认备案路径；域名、ICP 备案和证书是公网商业入口的独立工作，不应和本地 `127.0.0.1` 验收混淆。
- [ ] 先完成专用 VPC、交换机、安全组、ECS、RDS、Tair 的网络规划；实际购买前再次核对地域、VPC、私网和端口隔离。
- [ ] 在独立测试环境做一次发布包校验、迁移、备份恢复演练和桌面/手机端验收。

以下事项通常要等企业主体认证或服务审核，当前不要用个人测试配置冒充生产完成：

- [ ] 阿里云短信签名、登录验证码模板和每日结算摘要模板审核通过。
- [ ] ECS RAM 角色、短信余额/日发送量告警和真实手机闭环验收。
- [ ] MNS 回执消费者、真实提醒去重和失败告警闭环验收。
- [ ] OSS 异地不可变备份、OCR、微信通知等增值服务的资质、费用和权限验收。

可以回传给开发人员的只有非敏感信息：地域、VPC/交换机/安全组 ID、ECS/RDS/Tair 实例 ID、私网
主机名、端口、数据库名和账号名。密码、AccessKey、短信密钥、证书私钥、完整连接串和验证码只在
阿里云密钥管理或受限 ECS 配置文件中保存，不能发到聊天、截图或 Git。

## 1. 先确定统一范围

- [ ] 确定一个阿里云地域，ECS、RDS 和 Tair 全部放在该地域。
- [ ] 新建本项目专用 VPC，不复用陌生项目的网络。
- [ ] 在该 VPC 中准备至少两个不同可用区的交换机，供高可用资源选择。
- [ ] 统一资源名称，例如 `siyan-settlement-production`，并增加项目、环境和负责人标签。
- [ ] 确认账单联系人、运维联系人和安全告警联系人能够实际收到通知。

原则：三类资源必须同地域、同 VPC，通过私网互通。RDS 和 Tair 不申请公网地址，也不能和应用
安装在同一台 ECS 上。

## 2. 按依赖顺序开通资源

### 第一步：VPC、交换机和安全组

- [ ] 创建项目专用 VPC 和交换机，记录 VPC ID、交换机 ID、可用区和网段。
- [ ] 创建项目专用 ECS 安全组，不直接复用其他项目的安全组。
- [ ] SSH `22` 只允许固定管理 IP，并优先使用 SSH 密钥；验证密钥可登录后关闭密码登录。
- [ ] 当前 `666/TLS` 部署仅开放 TCP `666`；正式域名入口优先改为 TCP `443`。
- [ ] 只有证书签发或 HTTP 跳转确实需要时才开放 TCP `80`。
- [ ] 不得向公网开放应用内部端口 `16666`、PostgreSQL `5432` 或 Redis `6379`。
- [ ] 任何入方向规则都不得用 `0.0.0.0/0` 开放 SSH、数据库或 Redis。

### 第二步：ECS 应用服务器

- [ ] 规格选择专用实例 `4 vCPU / 8 GiB`，使用受支持的 64 位 Linux。
- [ ] 系统盘使用 ESSD，建议至少 `80–100 GiB`，并开启磁盘和到期提醒。
- [ ] 放入上一步的 VPC、应用交换机和项目专用安全组。
- [ ] 只运行本项目应用、Nginx 和运维任务，不在 ECS 本机安装生产 PostgreSQL 或 Redis。
- [ ] 记录实例 ID、可用区、私网 IP、公网 IP 或 EIP、安全组 ID 和操作系统版本。
- [ ] 开启云监控、主机监控和安全基线检查。

单台 ECS 仍然是应用单点。首期可先使用一台；业务要求更高 SLA 时，应升级为 SLB 加至少两台
ECS，而不是把数据库搬回应用服务器。

### 第三步：RDS PostgreSQL

- [ ] 选择 `PostgreSQL 16`、高可用版、`2 vCPU / 4 GiB`、`100 GiB ESSD`。
- [ ] 与 ECS 选择同地域、同 VPC；主连接地址必须是私网地址。
- [ ] 不开通公网连接地址。
- [ ] 白名单或安全组仅允许本项目 ECS 的私网安全组；若只能填 IP，使用 ECS 私网 IP `/32`。
- [ ] 开启 SSL，应用连接也必须要求 SSL。
- [ ] 创建独立数据库，并分别创建“应用账号”和“只读备份账号”；不要使用高权限管理员账号运行应用。
- [ ] 应用账号不得有建库、建角色和超级用户权限；备份账号只允许读取所需表和序列。
- [ ] 开启存储自动扩容并设置容量上限，避免磁盘满后停库，也避免无限增长。
- [ ] 开启每日自动备份、日志备份和时间点恢复，建议保留至少 `30 天`。
- [ ] 开启释放保护、删除保护或回收站（以控制台实际提供的选项为准）。
- [ ] 记录实例 ID、私网地址、端口、数据库名、两个账号名、SSL 状态和备份保留期。

RDS 是订单、收付款、审计和幂等记录的最终可信数据源。任何财务事实都不能只保存在 Redis。

### 第四步：Tair（Redis 兼容）

- [ ] 选择 Redis 兼容版、标准主从高可用、`2 GiB`，优先选择当前受支持的 Redis 7 兼容版本。
- [ ] 与 ECS 选择同地域、同 VPC；连接地址必须是私网地址。
- [ ] 不开通公网连接地址。
- [ ] 白名单或安全组仅允许本项目 ECS 的私网安全组或 ECS 私网 IP。
- [ ] 开启 TLS，应用使用 `rediss://` 连接。
- [ ] 创建本项目独立 ACL 应用账号和至少 16 字符的强密码，不复用默认管理员账号。
- [ ] ACL 键空间只允许 `siyan-settlement-666:production:*`；命令至少允许 `PING`、`GET`、
  `SET`、`DEL`、`EVAL`、`INCR`、`EXPIRE` 和 `TTL`，并禁止 `FLUSHALL`、`FLUSHDB`、`CONFIG`、
  `KEYS`、`SHUTDOWN` 等管理或全库命令。
- [ ] 使用独立键前缀 `siyan-settlement-666:production:`，所有临时键必须设置 TTL。
- [ ] 淘汰策略选择 `noeviction`，避免在不知情时删除验证码、发送冷却或登录限流数据。
- [ ] 开启持久化/AOF 和每日自动备份，建议保留至少 `7 天`。
- [ ] 开启释放保护、删除保护或回收站（以控制台实际提供的选项为准）。
- [ ] 记录实例 ID、私网地址、TLS 端口、ACL 账号名、数据库编号、版本和备份保留期。

Tair 当前只用于验证码、发送冷却和登录限流；会话、提醒 outbox、发送租约和防重复状态保存在
PostgreSQL。清空 Tair 不应造成账务数据丢失或重复记账，但会使短信验证和登录保护暂时不可用。

## 3. 监控和告警

- [ ] ECS 设置 CPU、内存、磁盘使用率和实例不可达告警，初始阈值可从 `70%` 开始。
- [ ] RDS 设置 CPU、存储、连接数、慢查询、主备延迟和备份失败告警。
- [ ] Tair 设置内存、连接数、延迟、拒绝连接、主备切换和淘汰键数量告警。
- [ ] 设置应用 `/api/health`、systemd 服务失败和外部 HTTPS 可用性告警。
- [ ] 设置 TLS 证书到期告警，至少提前 30 天通知。
- [ ] 每一种告警都进行一次人工触发测试，确认负责人真实收到，而不只是控制台显示“已配置”。
- [ ] 告警联系人至少两人，避免只有一个人的手机或账号能收到。

## 4. 需要记录的非敏感字段

可以把以下内容记录到项目交付表，也可以在聊天中提供给开发人员：

| 类别 | 需要记录 |
| --- | --- |
| 网络 | 地域、VPC ID/名称、交换机 ID/可用区/网段、安全组 ID/名称 |
| ECS | 实例 ID、私网 IP、公网 IP 或 EIP、操作系统、规格、磁盘规格 |
| RDS | 实例 ID、私网主机名、端口、数据库名、应用账号名、备份账号名、SSL 状态 |
| Tair | 实例 ID、私网主机名、TLS 端口、ACL 账号名、数据库编号、实例版本 |
| 运维 | 备份保留期、时间点恢复范围、监控联系人组、资源到期时间 |

不要记录或发送：账号密码、完整 `DATABASE_URL`、完整 `REDIS_URL`、AccessKey、证书私钥、短信
密钥、微信密钥、OSS 密钥或任何验证码。截图前也要确认这些内容没有出现在页面中。

## 5. 把密码安全写入 ECS

密码应在阿里云密钥管理服务或团队密码库中生成和保存。不要写进 Git、部署包、聊天、工单、截图，
也不要直接放在会被 shell history 记录的命令中。

应用系统用户和目录建立后，在 ECS 上使用 `sudoedit` 打开受限配置文件：

```bash
sudo install -d -o root -g siyan-settlement-666 -m 0750 \
  /etc/siyan-settlement-666/app
sudoedit /etc/siyan-settlement-666/app/app.env
sudo chown root:siyan-settlement-666 /etc/siyan-settlement-666/app/app.env
sudo chmod 0640 /etc/siyan-settlement-666/app/app.env
sudo stat -c '%U %G %a %n' /etc/siyan-settlement-666/app/app.env
```

在编辑器内填写，不要把真实值粘贴回聊天。密码放入 URL 前必须进行 URL 编码：

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=16666
DATABASE_URL=postgresql://APP_USER:URL_ENCODED_PASSWORD@RDS_PRIVATE_HOST:5432/APP_DB?sslmode=require&connect_timeout=5
REDIS_URL=rediss://ACL_USER:URL_ENCODED_PASSWORD@TAIR_PRIVATE_HOST:6379/0
REDIS_KEY_PREFIX=siyan-settlement-666:production:
SEED_DEMO=false
PUBLIC_ORIGIN=EXACT_HTTPS_BROWSER_ORIGIN
SESSION_TTL_HOURS=168
BODY_LIMIT_BYTES=1048576
LOGIN_RATE_LIMIT_MAX=5
SMS_ENABLED=false
SMS_CODE_TTL_SECONDS=300
SMS_RESEND_COOLDOWN_SECONDS=60
SMS_VERIFY_MAX_ATTEMPTS=5
SMS_SEND_RATE_LIMIT_MAX=5
SMS_SEND_RATE_LIMIT_IP_MAX=20
SMS_SEND_RATE_LIMIT_WINDOW_SECONDS=3600
NOTIFICATION_PROVIDER=fake
NOTIFICATION_WORKER_NAME=settlement-reminders
NOTIFICATION_POLL_INTERVAL_MS=30000
NOTIFICATION_BATCH_SIZE=5
NOTIFICATION_LEASE_SECONDS=120
NOTIFICATION_MAX_ATTEMPTS=5
ALIYUN_SMS_DIGEST_TEMPLATE_CODE=SMS_已审核每日摘要模板编号
RELEASE_ID=当前发布目录的40位Git提交SHA
```

Worker 当前串行发送；租约必须至少为 `批量大小 * 15 秒 + 30 秒`。保持示例的 5 条/120 秒，除非同时
调整并重新验收两项参数。

`PUBLIC_ORIGIN` 必须与用户浏览器中的完整 HTTPS 来源一致，例如正式域名的 `https://域名`，或当前
验收入口的 `https://公网IP:666`。不要用 `cat` 打印配置文件来验收权限，只检查上面 `stat` 的结果
应为 `root siyan-settlement-666 640`。

## 6. 上线前验收

- [ ] 从 ECS 私网连接 RDS 成功，并确认连接启用了 SSL。
- [ ] 从应用系统用户使用 Tair TLS + ACL 执行 `PING` 成功。
- [ ] 部署前置检查脚本通过；它只验证配置和连接，不会替你创建云资源。
- [ ] `/api/health` 同时报告应用、数据库和 Redis 正常，响应中不含连接串或密码。
- [ ] 公网只能访问预期的 HTTPS 入口；`16666`、`5432` 和 `6379` 从公网不可达。
- [ ] 登录、退出、验证码限流、会话过期和服务重启后的登录状态经过真实测试。
- [ ] 多实例或重复任务场景不会重复发送提醒，也不会重复记账。
- [ ] RDS 自动备份和时间点恢复状态正常，并在隔离环境完成一次恢复演练。
- [ ] Tair 主备切换或短暂不可用时，账务数据不丢失且不会重复入账。
- [ ] 应用、数据库、Redis、证书和备份失败告警均完成真实收件测试。
- [ ] Git 历史、发布包、日志和监控页面中没有密码或完整连接串。
- [ ] 记录验收日期、执行人、证据位置和未通过项；任何未通过项都不能标记为“已完成”。

## 7. 当前仍未开通的外部服务

下列能力不能因为 ECS、RDS 和 Tair 开通就视为完成：

- [ ] 阿里云短信：登录接口和前端流程已经具备，但真实签名、模板、ECS RAM 角色和发送验收未完成；完成前保持 `SMS_ENABLED=false`。
- [ ] 提醒 worker：systemd、阿里云发送适配器和心跳检查已经具备，但每日提醒模板、MNS 回执消费者和真实去重验收未完成；完成前保持 service/timer disabled。
- [ ] OCR：尚未开通并验证真实纸单识别服务、费用、准确率和人工校对流程。
- [ ] 微信：尚未开通公众号/小程序通知能力，也未完成用户授权、模板和回调验收。
- [ ] OSS：尚未建立独立、加密、不可变的异地备份桶和最小权限账号。

OSS 未完成前，RDS 自动备份仍是同一云账号内的备份，不能替代异地不可变副本。以上服务开通后，
还必须分别完成密钥隔离、失败重试、额度告警、费用告警和真实端到端测试，才能进入商业上线验收。
