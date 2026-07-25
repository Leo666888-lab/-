# siyan-settlement-666 部署说明

本目录只服务于 `siyan-settlement-666`，不会复用或覆盖服务器上的现有项目。公网入口为
`https://123.56.254.236:666`，Nginx 只代理到本机 `127.0.0.1:16666`。

## 固定资源

| 资源 | 固定值 |
| --- | --- |
| 应用服务 | `siyan-settlement-666.service` |
| 备份服务 | `siyan-settlement-666-postgres-backup.service` |
| 备份定时器 | `siyan-settlement-666-postgres-backup.timer` |
| 健康检查 | `siyan-settlement-666-health-check.timer` |
| TLS 检查 | `siyan-settlement-666-tls-check.timer` |
| 失败告警 | `siyan-settlement-666-alert@.service` |
| 发布目录 | `/opt/siyan-settlement-666/current` |
| 应用配置 | `/etc/siyan-settlement-666/app/app.env` |
| 备份配置 | `/etc/siyan-settlement-666/backup/backup.env` |
| 监控配置 | `/etc/siyan-settlement-666/monitor/monitor.env` |
| 备份目录 | `/var/backups/siyan-settlement-666` |
| 内部监听 | `127.0.0.1:16666` |
| 外部监听 | `666/TLS` |

## 阿里云生产资源基线

以下是首个商业生产环境的最低可执行基线，不代表资源已经开通。ECS、RDS 和 Tair 必须在**同一
地域、同一 VPC**，应用只使用 RDS 与 Tair 的私网地址；不要为数据库或 Redis 申请公网地址。优先
让 ECS 与主节点位于同一可用区以降低延迟，但 RDS/Tair 的高可用副本应由阿里云跨可用区托管。

| 资源 | 建议起步规格 | 生产要求 |
| --- | --- | --- |
| ECS 应用服务器 | 4 vCPU、8 GiB，80 GiB ESSD 系统盘 | 只运行应用、Nginx 和运维任务；单台 ECS 仍是单点，流量或 SLA 提升后改为 SLB + 至少 2 台 ECS |
| RDS PostgreSQL | PostgreSQL 16 高可用版，2 vCPU、4 GiB、100 GiB ESSD | 开启存储自动扩容、SSL、自动备份和日志备份；应用与备份使用不同账号 |
| Tair（Redis OSS 兼容） | Redis 7 兼容版本、标准主从高可用、2 GiB | 开启 TLS、ACL 应用账号、持久化和自动备份；只保存验证码、会话、任务锁等可过期数据，不作为账务事实库 |

容量告警建议从 CPU 70%、内存 70%、RDS 存储 70%、连接数 70% 开始；连续运行一段时间后按监控
实测调整。所有实例启用云监控告警。RDS 是订单和收付款的唯一事实库，Redis 故障只能造成临时
登录或任务能力降级，不能造成账务数据丢失。

`/api/health` 在 RDS 正常、Redis 异常时返回 HTTP `200` 和 `status: "degraded"`：负载均衡不会
因此摘除仍可服务账务请求的应用实例，但本项目的主动健康检查会把非 `ok` 状态视为失败并触发
告警。RDS 异常时返回 HTTP `503` 和 `status: "unavailable"`。

网络边界必须在创建资源时一次配置正确：

- ECS 公网入方向仅开放 TCP `666`；SSH `22` 仅允许固定管理 IP，内部端口 `16666` 不开放。
- RDS 白名单或安全组仅允许本项目 ECS 的私网安全组访问 `5432`，拒绝 `0.0.0.0/0`。
- Tair 白名单或安全组仅允许本项目 ECS 的私网安全组访问 TLS 端口（通常为 `6379`），拒绝公网。
- ECS 出方向保留到 RDS、Tair 私网端点以及 DNS/NTP、阿里云 API/OSS HTTPS 所需的最小访问。
- 上线前分别从应用系统用户执行 PostgreSQL 只读连接和 Redis TLS/ACL `PING`；preflight 会执行
  这两个检查，但不会创建云资源。

RDS 至少启用每日自动备份、日志备份/时间点恢复并保留 30 天；开启删除保护，任何恢复必须落到
新实例验证，不能覆盖生产实例。本仓库的 `pg_dump` + `age` + 独立 OSS 对象锁备份仍然必须运行，
因为同账号内的 RDS 自动备份不能替代异地、不可变副本。Tair 启用 AOF/持久化和每日自动备份，
保留至少 7 天；所有验证码、会话和任务锁必须设置 TTL，恢复后允许由数据库状态重建。

证书使用服务器现有文件：

```text
/etc/letsencrypt/live/123.56.254.236/fullchain.pem
/etc/letsencrypt/live/123.56.254.236/privkey.pem
```

Nginx 配置特意不发送 HSTS。该证书绑定共享 IP，HSTS 可能影响同一 IP 上的其他项目。

## 前置检查

不要停止或修改任何现有服务。先确认端口、目录和服务名没有冲突：

```bash
sudo ss -lntup
sudo lsof -nP -iTCP:666 -sTCP:LISTEN
sudo lsof -nP -iTCP:16666 -sTCP:LISTEN
systemctl status siyan-settlement-666.service
systemctl status siyan-settlement-666-postgres-backup.timer
sudo nginx -T
```

服务器需要隔离安装的 Node.js 24.18.0 LTS、PostgreSQL client（`pg_dump`、`psql`）、支持 TLS 的
`redis-cli`、`age`、`rclone`、Nginx、`curl` 和 `flock`。`pg_dump` 主版本不能低于 PostgreSQL 服务端主版本。现有 `/usr/bin/node` 是
v20，不能用于本项目，也不得替换，以免影响服务器上的其他服务。

## 隔离用户和目录

应用、备份、监控必须使用三个不同的无登录系统用户。它们只共同加入只读发布组，任何用户都不能
加入另外两个服务用户的私有组：

```bash
sudo groupadd --system siyan-settlement-666-release
sudo useradd --system --user-group --home-dir /var/lib/siyan-settlement-666 \
  --create-home --shell /usr/sbin/nologin siyan-settlement-666
sudo useradd --system --user-group --home-dir /var/lib/siyan-settlement-666-backup \
  --create-home --shell /usr/sbin/nologin siyan-settlement-666-backup
sudo useradd --system --user-group --home-dir /var/lib/siyan-settlement-666-monitor \
  --create-home --shell /usr/sbin/nologin siyan-settlement-666-monitor
for service_user in siyan-settlement-666 siyan-settlement-666-backup siyan-settlement-666-monitor; do
  sudo usermod --append --groups siyan-settlement-666-release "${service_user}"
done

sudo install -d -o root -g siyan-settlement-666-release -m 0750 /opt/siyan-settlement-666
sudo install -d -o root -g siyan-settlement-666-release -m 0750 \
  /opt/siyan-settlement-666/releases /opt/siyan-settlement-666/runtime
sudo install -d -o root -g root -m 0711 /etc/siyan-settlement-666
sudo install -d -o root -g siyan-settlement-666 -m 0750 /etc/siyan-settlement-666/app
sudo install -d -o root -g siyan-settlement-666-backup -m 0750 /etc/siyan-settlement-666/backup
sudo install -d -o root -g siyan-settlement-666-monitor -m 0750 /etc/siyan-settlement-666/monitor
sudo install -d -o siyan-settlement-666 -g siyan-settlement-666 -m 0750 \
  /var/lib/siyan-settlement-666
sudo install -d -o siyan-settlement-666-backup -g siyan-settlement-666-backup -m 0700 \
  /var/backups/siyan-settlement-666 /var/lib/siyan-settlement-666-backup
sudo install -d -o siyan-settlement-666-monitor -g siyan-settlement-666-monitor -m 0700 \
  /var/lib/siyan-settlement-666-monitor
sudo install -d -o root -g siyan-settlement-666-monitor -m 0750 \
  /var/lib/siyan-settlement-666-tls
```

systemd 还会用 `InaccessiblePaths` 在挂载命名空间内再次隐藏其他服务的 secret。Unix 权限和
systemd 隐藏必须同时生效，不能只满足其中一个。

从 Node.js 官方发布包安装并校验 checksum 后，将 Node 24.18.0 放在本项目独立运行时目录：

```text
/opt/siyan-settlement-666/runtime/node/bin/node
```

`runtime/node` 可以是指向已校验版本目录的符号链接，但不能指向 `/usr/bin/node`。安装后先
确认输出严格为 `v24.18.0`。升级 Node 时必须同步修改 CI 和打包脚本并重新构建工件：

```bash
/opt/siyan-settlement-666/runtime/node/bin/node --version
```

CI 和人工重建都必须调用 `deploy/scripts/build-release-artifact.sh`。它只接受 Linux、Node 24.18.0
及其自带的 npm 11.16.0、
完整的 40 位 Git SHA 和该提交的时间戳，使用 lockfile 安装 production dependencies，并固定
tar 的顺序、owner、时间戳和 gzip header。包内 `SHA256SUMS` 校验所有普通文件，包外摘要校验
整个归档。CI 生成的包包含编译结果、静态资源、迁移和部署脚本。

在干净的 Linux checkout 中复现 CI 工件：

```bash
set -Eeuo pipefail
npm ci
npm run build
release_id="$(git rev-parse HEAD)"
source_date_epoch="$(git show -s --format=%ct "${release_id}")"
deploy/scripts/build-release-artifact.sh ./release-artifacts \
  "${release_id}" "${source_date_epoch}"
```

上传 `.tar.gz` 与 `.tar.gz.sha256` 后，先校验外层摘要，再解压到同一文件系统的 staging 目录；
已有 release ID 一律拒绝覆盖：

```bash
set -Eeuo pipefail
release_id=完整的40位小写Git提交SHA
[[ "${release_id}" =~ ^[0-9a-f]{40}$ ]]
archive="siyan-settlement-${release_id}.tar.gz"
release_dir="/opt/siyan-settlement-666/releases/${release_id}"
sha256sum -c "${archive}.sha256"
sudo test ! -e "${release_dir}"
release_staging="$(sudo mktemp -d "/opt/siyan-settlement-666/releases/.incoming-${release_id}.XXXXXX")"
sudo tar --no-same-owner --no-same-permissions -xzf "${archive}" -C "${release_staging}"
sudo /usr/bin/bash -c 'cd "$1" && sha256sum -c SHA256SUMS' _ "${release_staging}"
sudo test -f "${release_staging}/dist/src/server.js"
sudo test -f "${release_staging}/dist/src/cli/migrate.js"
sudo test -f "${release_staging}/public/index.html"
sudo test -d "${release_staging}/node_modules/fastify"
sudo chown -R root:siyan-settlement-666-release "${release_staging}"
sudo chmod -R u=rwX,g=rX,o= "${release_staging}"
sudo mv "${release_staging}" "${release_dir}"
```

只有最后一次 `mv` 会让版本目录可见，失败的 staging 目录应在核实后删除。不得修改已经发布的
版本目录；需要变更时使用新的 Git SHA 重新构建。数据库迁移必须向后兼容，否则应用回滚还必须
配合数据库恢复，不能只切符号链接。

## 隔离生产 secret

应用配置 `/etc/siyan-settlement-666/app/app.env` 必须为
`root:siyan-settlement-666`、`0640`，只能包含 Web 运行所需变量：

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=16666
DATABASE_URL=postgresql://APP_USER:URL_ENCODED_PASSWORD@DB_HOST:5432/APP_DB
REDIS_URL=rediss://ACL_USER:URL_ENCODED_PASSWORD@TAIR_PRIVATE_HOST:6379/0
REDIS_KEY_PREFIX=siyan-settlement-666:production:
SEED_DEMO=false
PUBLIC_ORIGIN=https://123.56.254.236:666
SESSION_TTL_HOURS=168
BODY_LIMIT_BYTES=1048576
LOGIN_RATE_LIMIT_MAX=5
```

数据库和 Redis 密码必须 URL 编码。生产环境不得省略 `DATABASE_URL`、`REDIS_URL` 或
`REDIS_KEY_PREFIX`，不得启用 demo seed。RDS 地址必须是私网地址并启用 SSL；可在 PostgreSQL URL
中追加 `?sslmode=require&connect_timeout=5`。Redis 只接受 `rediss://`，必须使用独立 ACL 用户、
至少 16 字符的强密码和固定前缀 `siyan-settlement-666:production:`；不要复用默认管理员账号。
ACL 键空间只允许该前缀，命令至少允许 `PING`、`GET`、`SET`、`DEL`、`EVAL`、`INCR`、`EXPIRE`
和 `TTL`，并拒绝 `FLUSHALL`、`FLUSHDB`、`CONFIG`、`KEYS`、`SHUTDOWN` 等管理或全库命令。
preflight 使用应用系统用户执行带 SNI 的 TLS/ACL `PING`，密码仅通过 `REDISCLI_AUTH` 子进程环境
传递，不会把完整 URL 或密码放进进程参数或日志。
主服务启动命令还会强制覆盖 `NODE_ENV`、`HOST`、`PORT`、`SEED_DEMO` 和 `PUBLIC_ORIGIN`，
即使环境文件误填，应用也只能以 production 模式监听 `127.0.0.1:16666`，并只接受来自
`https://123.56.254.236:666` 的浏览器 Cookie 写请求。

备份必须使用不同的 PostgreSQL 登录角色和不同密码。备份角色只授予连接、schema usage、全表及
sequence 读取，不授予写入、建库、建角色或复制权限。若生产库启用 RLS，备份角色可以单独授予
`BYPASSRLS`，但仍不得拥有任何业务表写权限。授权完成后用 `has_table_privilege` 核对实际权限：

```sql
CREATE ROLE siyan_settlement_backup LOGIN PASSWORD '由密码库生成的独立强密码'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE APP_DB TO siyan_settlement_backup;
GRANT USAGE ON SCHEMA public TO siyan_settlement_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO siyan_settlement_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO siyan_settlement_backup;
REVOKE CREATE ON DATABASE APP_DB FROM siyan_settlement_backup;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE APP_USER IN SCHEMA public
  GRANT SELECT ON TABLES TO siyan_settlement_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE APP_USER IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO siyan_settlement_backup;
```

这里的 `APP_USER` 必须替换为实际执行迁移并创建表的应用数据库角色，否则默认授权不会覆盖后续
新表。只有生产库实际启用 RLS 时才把 `NOBYPASSRLS` 改为 `BYPASSRLS`。preflight 会连接备份账号，
确认它指向与应用账号相同的数据库、能读取全部业务表和 sequence，同时没有 database/schema
创建权限、表写权限或 sequence 更新权限。

`/etc/siyan-settlement-666/backup/backup.env` 必须为
`root:siyan-settlement-666-backup`、`0640`，不得复制应用数据库凭据：

```text
DATABASE_URL=postgresql://siyan_settlement_backup:DIFFERENT_URL_ENCODED_PASSWORD@DB_HOST:5432/APP_DB
BACKUP_RETENTION_DAYS=30
BACKUP_REMOTE=offsite:siyan-settlement-666/production
```

`/etc/siyan-settlement-666/monitor/monitor.env` 必须为
`root:siyan-settlement-666-monitor`、`0640`。告警接收端需要接受 HTTPS
`application/x-www-form-urlencoded` POST；Bearer token 可省略：

```text
ALERT_WEBHOOK_URL=https://alerts.example.com/hooks/siyan-settlement
ALERT_WEBHOOK_BEARER_TOKEN=REPLACE_WITH_URLSAFE_TOKEN
ALERT_COOLDOWN_SECONDS=900
TLS_MIN_VALIDITY_SECONDS=1209600
TLS_RENEWAL_MAX_AGE_SECONDS=6048000
TLS_RENEWAL_TIMER=certbot-ip-renew.timer
```

不得把上述任何文件提交到 Git。部署前检查会验证三份文件各自的变量白名单、重复键和 Unix
读取边界，并拒绝应用与备份数据库用户名或密码相同的配置。

## 加密备份密钥

备份使用 `age` 公钥流式加密，明文 dump 不落盘。请在可信的离线设备生成密钥：

```bash
age-keygen -o siyan-settlement-666-backup.agekey
age-keygen -y siyan-settlement-666-backup.agekey
```

私钥只保存在离线密码库。把第二条命令输出的 `age1...` 公钥写入服务器：

```text
/etc/siyan-settlement-666/backup/backup.age-recipient
```

该文件必须为 `root:siyan-settlement-666-backup`、权限 `0640`。备份文件权限为 `0600`，默认保留
30 天，脚本拒绝低于 7 天或高于 3650 天的配置。

使用 `rclone config` 创建独立对象存储 remote，把配置安装为
`/etc/siyan-settlement-666/backup/rclone.conf`（`root:siyan-settlement-666-backup`、`0640`）。
`BACKUP_REMOTE` 必须指向真正独立于 ECS 的存储。脚本在本地加密完成后同步全部保留备份，
失败会让 systemd 任务失败且跳过本地清理，下次自动重试。存储端必须启用对象锁/不可变保留和
生命周期策略，服务凭据仅授予写入与校验所需的最小权限，不授予删除权。

## 安装服务

确认隔离 Node 路径、`/usr/bin/bash` 和部署目录均正确后安装独立 unit：

```bash
sudo install -m 0644 deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/siyan-settlement-666*.service \
  /etc/systemd/system/siyan-settlement-666*.timer
sudo systemctl daemon-reload
```

三个服务用户只通过 `siyan-settlement-666-release` 读取 root 拥有的发布目录。应用 unit 在自己的
mount namespace 中看不到备份、对象存储或监控配置；备份和监控 unit 同样看不到应用 secret。
任何 unit 失败都会触发 `siyan-settlement-666-alert@.service`。

## 安装 Nginx 和证书 hook

preflight 会检查 Nginx listener、证书和续期链路，因此必须先完成本节。只新增本项目配置文件，
不修改已有 server block：

```bash
sudo install -m 0644 deploy/nginx/siyan-settlement-666.conf \
  /etc/nginx/conf.d/siyan-settlement-666.conf
sudo nginx -t
sudo systemctl reload nginx
sudo nginx -T 2>&1 | grep -F \
  'configuration file /etc/nginx/conf.d/siyan-settlement-666.conf:'
```

阿里云安全组只开放外部 TCP `666`，来源范围应尽量收窄；绝不能开放内部 `16666`。

安装证书 deploy hook。它在 reload 前检查有效期、IP SAN、私钥匹配和 Nginx include，reload
后再比较 666 端口实际提供的证书指纹：

```bash
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo install -m 0755 deploy/scripts/siyan-settlement-666-nginx-cert-reload.sh \
  /etc/letsencrypt/renewal-hooks/deploy/siyan-settlement-666-nginx-cert-reload
sudo /etc/letsencrypt/renewal-hooks/deploy/siyan-settlement-666-nginx-cert-reload --check-only
sudo /etc/letsencrypt/renewal-hooks/deploy/siyan-settlement-666-nginx-cert-reload
```

标准 Certbot 会自动执行该目录。现有 `certbot-ip-renew.timer` 若使用自定义续期程序，必须先用
`systemctl cat certbot-ip-renew.service` 确认它是否执行标准 hook；若没有，则为对应 service 添加
以下 drop-in（二选一，不能把“文件已安装”当作“定时器会调用”）：

```ini
[Service]
ExecStartPost=/etc/letsencrypt/renewal-hooks/deploy/siyan-settlement-666-nginx-cert-reload
```

安装 drop-in 后执行 `systemctl daemon-reload`，手动触发一次续期 service，并在日志中确认 hook
成功。hook 未实际被定时器调用、或无法核对线上证书指纹，都属于上线阻断项。

升级已有数据库前必须先成功执行一次备份服务。该服务只有在加密文件上传异地并下载回查一致后
才返回成功；失败时禁止继续迁移。首次部署仅可在已经确认数据库为空时跳过这一步：

```bash
if [[ -L /opt/siyan-settlement-666/current ]]; then
  sudo systemctl start siyan-settlement-666-postgres-backup.service
  sudo journalctl -u siyan-settlement-666-postgres-backup.service -n 100 --no-pager
else
  echo '首次部署：继续前必须人工确认目标数据库为空' >&2
fi
```

备份成功标记只有在加密文件完成异地上传并通过下载回查后才写入
`/var/lib/siyan-settlement-666-backup/last-success`。迁移前必须运行只读 preflight；首次安装需要
人工核对目标数据库为空并显式确认，脚本还会在 `BEGIN READ ONLY` 中再次检查：

```bash
release_id=完整的40位Git提交SHA
release_dir="/opt/siyan-settlement-666/releases/${release_id}"

# 首次安装
sudo "${release_dir}/deploy/scripts/siyan-settlement-666-preflight.sh" \
  --mode first-install --release-dir "${release_dir}" --confirm-empty-database

# 已有版本升级
sudo "${release_dir}/deploy/scripts/siyan-settlement-666-preflight.sh" \
  --mode upgrade --release-dir "${release_dir}"
```

preflight 只执行摘要、权限、systemd、Nginx、证书、端口、只读 PostgreSQL 查询、Redis TLS/ACL
`PING`、健康检查和备份新鲜度检查，不执行迁移、不创建或删除数据库，也不启动或停止服务。

然后通过一次性 transient unit 对尚未切换的 release 执行迁移。systemd 读取生产环境文件，
`/usr/bin/env` 再强制覆盖所有非秘密运行模式变量，因此不会误回退到本地 PGlite。迁移本身持有
advisory lock，但仍不得让多个发布流程同时进行：

```bash
release_id=完整的40位Git提交SHA
release_dir="/opt/siyan-settlement-666/releases/${release_id}"
sudo test -r "${release_dir}/dist/src/cli/migrate.js"
sudo systemd-run --unit=siyan-settlement-666-migrate --wait --collect --pipe \
  --property=Type=oneshot \
  --property=User=siyan-settlement-666 \
  --property=Group=siyan-settlement-666 \
  --property=WorkingDirectory="${release_dir}" \
  --property=EnvironmentFile=/etc/siyan-settlement-666/app/app.env \
  /usr/bin/env NODE_ENV=production HOST=127.0.0.1 PORT=16666 SEED_DEMO=false \
    PUBLIC_ORIGIN=https://123.56.254.236:666 \
  /opt/siyan-settlement-666/runtime/node/bin/node \
  "${release_dir}/dist/src/cli/migrate.js"
```

迁移成功后，记录上一版本，用同目录中的临时符号链接原子切换 `current`。健康检查最多等待
30 秒；若新版本失败，立即切回上一版本。首次部署失败时停止服务并保留失败版本供排查：

```bash
set -Eeuo pipefail
release_id=完整的40位Git提交SHA
release_dir="/opt/siyan-settlement-666/releases/${release_id}"
current_link="/opt/siyan-settlement-666/current"
[[ ! -e "${current_link}" || -L "${current_link}" ]] || {
  echo "current 必须不存在或为符号链接" >&2
  exit 1
}
previous_release="$(readlink -f /opt/siyan-settlement-666/current 2>/dev/null || true)"
if [[ -n "${previous_release}" && "${previous_release}" != /opt/siyan-settlement-666/releases/* ]]; then
  echo "拒绝切换：上一版本不在独立 releases 目录" >&2
  exit 1
fi
next_link="/opt/siyan-settlement-666/.current-${release_id}.$$"
sudo ln -s "${release_dir}" "${next_link}"
sudo mv -Tf "${next_link}" "${current_link}"
sudo systemctl enable siyan-settlement-666.service
sudo systemctl restart siyan-settlement-666.service

healthy=false
for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:16666/api/health >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done

if [[ "${healthy}" != true ]]; then
  sudo journalctl -u siyan-settlement-666.service -n 100 --no-pager
  if [[ -n "${previous_release}" && -d "${previous_release}" ]]; then
    rollback_link="/opt/siyan-settlement-666/.rollback-${release_id}.$$"
    sudo ln -s "${previous_release}" "${rollback_link}"
    sudo mv -Tf "${rollback_link}" "${current_link}"
    sudo systemctl restart siyan-settlement-666.service
    curl --fail --retry 20 --retry-all-errors --retry-delay 1 \
      http://127.0.0.1:16666/api/health >/dev/null
  else
    sudo systemctl stop siyan-settlement-666.service
    sudo rm -f -- "${current_link}"
  fi
  exit 1
fi
```

上线后若需人工回滚，指定经过校验且与当前数据库兼容的旧 release ID，再执行相同的原子切换和
健康检查。不能把任意路径传给回滚命令：

```bash
rollback_release_id=需要回滚到的40位Git提交SHA
[[ "${rollback_release_id}" =~ ^[0-9a-f]{40}$ ]]
rollback_release="/opt/siyan-settlement-666/releases/${rollback_release_id}"
sudo test -r "${rollback_release}/dist/src/server.js"
rollback_link="/opt/siyan-settlement-666/.rollback-${rollback_release_id}.$$"
sudo ln -s "${rollback_release}" "${rollback_link}"
sudo mv -Tf "${rollback_link}" /opt/siyan-settlement-666/current
sudo systemctl restart siyan-settlement-666.service
curl --fail --retry 30 --retry-all-errors --retry-delay 1 \
  http://127.0.0.1:16666/api/health >/dev/null
```

## 启用监控、TLS 检查和备份

仓库只提供加密、`rclone copy` 和下载回查逻辑，不会替你创建真实对象存储、对象锁、监控或告警。
以下条件全部有真实执行证据之前，异地备份视为**尚未完成，并阻断上线**：

- `BACKUP_REMOTE` 位于独立于 ECS 的账号或故障域，并已启用对象锁/不可变保留；
- 凭据可以上传、列举和回读，但没有覆盖既有对象或删除备份的权限；
- 手动任务成功，远端同时存在 `.dump.age` 和 `.sha256`，脚本的下载回查成功；
- 从远端重新下载的文件完成一次下面的全量恢复演练；
- systemd 任务失败能够主动通知负责人，而不只是留在本机 journal。

先直接调用一次告警模板，确认接收端确实收到包含项目、主机、unit 和 UTC 时间的通知：

```bash
sudo systemctl start siyan-settlement-666-alert@manual-test.service
sudo journalctl -u siyan-settlement-666-alert@manual-test.service -n 50 --no-pager
```

证书 deploy hook 只有在 Nginx reload 后、且 `666` 实际提供的证书指纹与磁盘证书一致时，才会原子写入
`/var/lib/siyan-settlement-666-tls/renewal-last-success`。先执行一次 hook 建立真实续期证据，再运行 TLS
检查。只创建空文件或手工修改时间戳不能通过指纹检查：

```bash
sudo /etc/letsencrypt/renewal-hooks/deploy/siyan-settlement-666-nginx-cert-reload
sudo systemctl start siyan-settlement-666-tls-check.service
sudo journalctl -u siyan-settlement-666-tls-check.service -n 50 --no-pager
sudo stat /var/lib/siyan-settlement-666-tls/renewal-last-success
```

手动运行健康检查和备份，检查远端对象及成功标记后，再启用三个定时器：

```bash
sudo systemctl start siyan-settlement-666-health-check.service
sudo systemctl start siyan-settlement-666-postgres-backup.service
sudo journalctl -u siyan-settlement-666-health-check.service -n 50 --no-pager
sudo journalctl -u siyan-settlement-666-postgres-backup.service -n 100 --no-pager
sudo -u siyan-settlement-666-backup /usr/bin/bash -c \
  'cd /var/backups/siyan-settlement-666 && sha256sum -c -- *.dump.age.sha256'
sudo stat /var/lib/siyan-settlement-666-backup/last-success
sudo systemctl enable --now \
  siyan-settlement-666-health-check.timer \
  siyan-settlement-666-tls-check.timer \
  siyan-settlement-666-postgres-backup.timer
systemctl list-timers 'siyan-settlement-666-*'
```

健康检查每分钟运行。TLS 检查每天运行并要求证书至少还有 14 天有效期、续期证据未过期、续期
定时器处于 active/enabled，且线上指纹与磁盘一致。备份每天 `02:30 Asia/Shanghai` 运行并随机延迟
最多 15 分钟。任一 service 失败都会调用告警模板；告警自身带 15 分钟默认冷却，避免持续故障刷屏。

## 隔离恢复演练

恢复演练必须在独立、可销毁且不承载生产服务的主机上进行。生产 ECS、生产 PostgreSQL 主机以及
任何存在生产配置、`current` 链接或监听 `666`/`16666` 的主机都禁止执行。演练脚本不会创建或
删除数据库；数据库管理员必须预先创建专用角色和空数据库，并在取证完成后另行清理。

在隔离主机安装已校验的同版本 release、Node 24.18.0、PostgreSQL client 和 `age`，但不要创建
`/opt/siyan-settlement-666/current`。release 中的普通文件和目录必须归 root 所有，且 group/other
不可写。创建非 root 演练用户和显式主机标记：

```bash
sudo useradd --system --user-group --create-home \
  --home-dir /var/lib/siyan-restore-drill --shell /usr/sbin/nologin siyan-restore-drill
sudo install -d -o root -g root -m 0755 /etc/siyan-settlement-666
printf '%s\n' 'THIS_HOST_IS_ISOLATED_AND_DISPOSABLE' | \
  sudo tee /etc/siyan-settlement-666/RESTORE_DRILL_HOST >/dev/null
sudo chown root:root /etc/siyan-settlement-666/RESTORE_DRILL_HOST
sudo chmod 0444 /etc/siyan-settlement-666/RESTORE_DRILL_HOST
```

角色名必须以 `siyan_restore_` 开头，数据库名必须以
`siyan_settlement_666_restore_drill_` 开头。角色必须同时设置 `NOSUPERUSER`、`NOCREATEDB`、
`NOCREATEROLE`、`NOREPLICATION` 和 `NOBYPASSRLS`，且数据库在运行脚本前不能包含任何用户表或
sequence：

```sql
CREATE ROLE siyan_restore_20260725 LOGIN PASSWORD '由密码库生成的一次性强密码'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE siyan_settlement_666_restore_drill_20260725
  OWNER siyan_restore_20260725;
REVOKE ALL ON DATABASE siyan_settlement_666_restore_drill_20260725 FROM PUBLIC;
```

从异地存储重新下载一组 `.dump.age` 和 `.sha256`，并把备份、checksum、离线 age 私钥和只含一行
`DATABASE_URL` 的目标环境文件放到演练用户私有目录。私钥、备份和环境文件必须归演练用户所有，
且 group/other 权限为零：

```text
DATABASE_URL=postgresql://siyan_restore_20260725:URL_ENCODED_PASSWORD@127.0.0.1:5432/siyan_settlement_666_restore_drill_20260725
```

```bash
sudo install -d -o siyan-restore-drill -g siyan-restore-drill -m 0700 \
  /var/lib/siyan-restore-drill/inputs
sudo chown siyan-restore-drill:siyan-restore-drill \
  /var/lib/siyan-restore-drill/inputs/*
sudo chmod 0600 /var/lib/siyan-restore-drill/inputs/*

release_id=经过校验的40位Git提交SHA
backup_file=/var/lib/siyan-restore-drill/inputs/siyan-settlement-666-YYYYMMDDTHHMMSSZ.dump.age
sudo -u siyan-restore-drill \
  "/opt/siyan-settlement-666/releases/${release_id}/deploy/scripts/siyan-settlement-666-restore-drill.sh" \
  --backup "${backup_file}" \
  --identity /var/lib/siyan-restore-drill/inputs/backup.agekey \
  --target-env /var/lib/siyan-restore-drill/inputs/restore.env \
  --release-dir "/opt/siyan-settlement-666/releases/${release_id}"
```

脚本先校验主机、角色、空库、文件权限和加密备份，再恢复、运行当前 release 的迁移，并以只读
事务输出企业、订单、收付款和审计记录计数。把输出与备份时记录的基线及抽样订单金额核对后，
保存演练日期、release SHA、备份文件名和结果；只看退出码不能算恢复演练完成。

## 上线后只读验证

```bash
release_dir="$(readlink -f /opt/siyan-settlement-666/current)"
sudo "${release_dir}/deploy/scripts/siyan-settlement-666-preflight.sh" \
  --mode upgrade --release-dir "${release_dir}"
systemctl status siyan-settlement-666.service
systemctl is-enabled --quiet siyan-settlement-666-health-check.timer
systemctl is-enabled --quiet siyan-settlement-666-tls-check.timer
systemctl is-enabled --quiet siyan-settlement-666-postgres-backup.timer
systemctl is-active --quiet siyan-settlement-666-health-check.timer
systemctl is-active --quiet siyan-settlement-666-tls-check.timer
systemctl is-active --quiet siyan-settlement-666-postgres-backup.timer
sudo systemctl start siyan-settlement-666-health-check.service
sudo systemctl start siyan-settlement-666-tls-check.service
sudo ss -lntup | grep -E ':(666|16666)\\b'
curl --fail --silent --show-error http://127.0.0.1:16666/api/health
curl --fail --silent --show-error https://123.56.254.236:666/api/health
sudo journalctl -u siyan-settlement-666.service -n 100 --no-pager
sudo journalctl -u siyan-settlement-666-health-check.service -n 50 --no-pager
sudo journalctl -u siyan-settlement-666-tls-check.service -n 50 --no-pager
sudo journalctl -u siyan-settlement-666-postgres-backup.service -n 100 --no-pager
sudo systemctl --failed
```

预期只有 Nginx 对外监听 `666`，Node 只监听 `127.0.0.1:16666`。上线验收记录必须同时包含
证书 hook 的成功日志、`certbot-ip-renew.timer` 到 hook 的实际调用链，以及一次续期后 666 端口
证书指纹匹配的结果；缺少任一项都不能标记 TLS 自动续期已完成。
