# siyan-settlement-666 部署说明

本目录只服务于 `siyan-settlement-666`，不会复用或覆盖服务器上的现有项目。公网入口为
`https://123.56.254.236:666`，Nginx 只代理到本机 `127.0.0.1:16666`。

## 固定资源

| 资源 | 固定值 |
| --- | --- |
| 应用服务 | `siyan-settlement-666.service` |
| 备份服务 | `siyan-settlement-666-postgres-backup.service` |
| 备份定时器 | `siyan-settlement-666-postgres-backup.timer` |
| 发布目录 | `/opt/siyan-settlement-666/current` |
| 环境文件 | `/etc/siyan-settlement-666/app.env` |
| 备份目录 | `/var/backups/siyan-settlement-666` |
| 内部监听 | `127.0.0.1:16666` |
| 外部监听 | `666/TLS` |

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

服务器需要隔离安装的 Node.js 24.18.0 LTS、PostgreSQL client（`pg_dump`）、`age`、`rclone`、
Nginx 和 `flock`。`pg_dump` 主版本不能低于 PostgreSQL 服务端主版本。现有 `/usr/bin/node` 是
v20，不能用于本项目，也不得替换，以免影响服务器上的其他服务。

## 用户和目录

```bash
sudo useradd --system --user-group --home-dir /var/lib/siyan-settlement-666 \
  --create-home --shell /usr/sbin/nologin siyan-settlement-666
sudo install -d -o root -g siyan-settlement-666 -m 0750 /opt/siyan-settlement-666
sudo install -d -o root -g siyan-settlement-666 -m 0750 \
  /opt/siyan-settlement-666/releases /opt/siyan-settlement-666/runtime
sudo install -d -o root -g siyan-settlement-666 -m 0750 /etc/siyan-settlement-666
sudo install -d -o siyan-settlement-666 -g siyan-settlement-666 -m 0700 \
  /var/backups/siyan-settlement-666
```

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
sudo chown -R root:siyan-settlement-666 "${release_staging}"
sudo chmod -R u=rwX,g=rX,o= "${release_staging}"
sudo mv "${release_staging}" "${release_dir}"
```

只有最后一次 `mv` 会让版本目录可见，失败的 staging 目录应在核实后删除。不得修改已经发布的
版本目录；需要变更时使用新的 Git SHA 重新构建。数据库迁移必须向后兼容，否则应用回滚还必须
配合数据库恢复，不能只切符号链接。

## 生产环境文件

`/etc/siyan-settlement-666/app.env` 必须由 root 创建，权限为 `0640`，组为
`siyan-settlement-666`。不要把它提交到 Git：

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=16666
DATABASE_URL=postgresql://APP_USER:URL_ENCODED_PASSWORD@DB_HOST:5432/APP_DB
SEED_DEMO=false
PUBLIC_ORIGIN=https://123.56.254.236:666
SESSION_TTL_HOURS=168
BODY_LIMIT_BYTES=1048576
LOGIN_RATE_LIMIT_MAX=5
BACKUP_RETENTION_DAYS=30
BACKUP_REMOTE=offsite:siyan-settlement-666/production
```

数据库密码必须 URL 编码。生产环境不得省略 `DATABASE_URL`，不得启用 demo seed。
主服务启动命令还会强制覆盖 `NODE_ENV`、`HOST`、`PORT`、`SEED_DEMO` 和 `PUBLIC_ORIGIN`，
即使环境文件误填，应用也只能以 production 模式监听 `127.0.0.1:16666`，并只接受来自
`https://123.56.254.236:666` 的浏览器 Cookie 写请求。

## 加密备份密钥

备份使用 `age` 公钥流式加密，明文 dump 不落盘。请在可信的离线设备生成密钥：

```bash
age-keygen -o siyan-settlement-666-backup.agekey
age-keygen -y siyan-settlement-666-backup.agekey
```

私钥只保存在离线密码库。把第二条命令输出的 `age1...` 公钥写入服务器：

```text
/etc/siyan-settlement-666/backup.age-recipient
```

该文件建议 `root:siyan-settlement-666`、权限 `0640`。备份文件权限为 `0600`，默认保留
30 天，脚本拒绝低于 7 天或高于 3650 天的配置。

使用 `rclone config` 创建独立对象存储 remote，把配置安装为
`/etc/siyan-settlement-666/rclone.conf`（`root:siyan-settlement-666`、`0640`）。
`BACKUP_REMOTE` 必须指向真正独立于 ECS 的存储。脚本在本地加密完成后同步全部保留备份，
失败会让 systemd 任务失败且跳过本地清理，下次自动重试。存储端必须启用对象锁/不可变保留和
生命周期策略，服务凭据仅授予写入与校验所需的最小权限，不授予删除权。

## 安装服务

确认隔离 Node 路径、`/usr/bin/bash` 和部署目录均正确后安装独立 unit：

```bash
sudo install -m 0644 deploy/systemd/siyan-settlement-666.service \
  /etc/systemd/system/siyan-settlement-666.service
sudo install -m 0644 deploy/systemd/siyan-settlement-666-postgres-backup.service \
  /etc/systemd/system/siyan-settlement-666-postgres-backup.service
sudo install -m 0644 deploy/systemd/siyan-settlement-666-postgres-backup.timer \
  /etc/systemd/system/siyan-settlement-666-postgres-backup.timer
sudo systemd-analyze verify /etc/systemd/system/siyan-settlement-666*.service \
  /etc/systemd/system/siyan-settlement-666*.timer
sudo systemctl daemon-reload
```

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
  --property=EnvironmentFile=/etc/siyan-settlement-666/app.env \
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

## 安装 Nginx

只新增本项目配置文件，不修改已有 server block：

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

## 启用和验证备份

仓库只提供加密、`rclone copy` 和下载回查逻辑，不会替你创建真实对象存储、对象锁、监控或告警。
以下条件全部有真实执行证据之前，异地备份视为**尚未完成，并阻断上线**：

- `BACKUP_REMOTE` 位于独立于 ECS 的账号或故障域，并已启用对象锁/不可变保留；
- 凭据可以上传、列举和回读，但没有覆盖既有对象或删除备份的权限；
- 手动任务成功，远端同时存在 `.dump.age` 和 `.sha256`，脚本的下载回查成功；
- 从远端重新下载的文件完成一次下面的全量恢复演练；
- systemd 任务失败能够主动通知负责人，而不只是留在本机 journal。

先手动运行一次并检查日志与远端对象，再启用定时器：

```bash
sudo systemctl start siyan-settlement-666-postgres-backup.service
sudo journalctl -u siyan-settlement-666-postgres-backup.service -n 100 --no-pager
sudo -u siyan-settlement-666 /usr/bin/bash -c \
  'cd /var/backups/siyan-settlement-666 && sha256sum -c -- *.dump.age.sha256'
sudo systemctl enable --now siyan-settlement-666-postgres-backup.timer
systemctl list-timers siyan-settlement-666-postgres-backup.timer
```

每天 `02:30 Asia/Shanghai` 触发，并随机延迟最多 15 分钟。`Persistent=true` 会在服务器错过
计划时间后补跑。

恢复演练必须在隔离主机使用临时数据库，不能直接覆盖生产库。先从异地存储重新下载一组 dump
和 checksum，在其目录校验摘要并确认 archive 可读：

```bash
backup_file=siyan-settlement-666-YYYYMMDDTHHMMSSZ.dump.age
sha256sum -c "${backup_file}.sha256"
age --decrypt -i OFFLINE_PRIVATE_KEY "${backup_file}" | pg_restore --list >/dev/null
```

创建一次性登录角色及由它拥有的数据库，再以该角色恢复。dump 故意不包含生产 owner 和 ACL，
所以灾难恢复时必须显式重建角色；不能以管理员恢复后就直接宣布完成：

```bash
restore_role=siyan_restore_app
restore_db=siyan_restore_drill
sudo -u postgres createuser --login --no-createdb --no-createrole --no-superuser \
  --pwprompt "${restore_role}"
sudo -u postgres createdb --owner="${restore_role}" "${restore_db}"
age --decrypt -i OFFLINE_PRIVATE_KEY "${backup_file}" | \
  sudo -u postgres pg_restore --exit-on-error --no-owner --no-privileges \
    --role="${restore_role}" --dbname="${restore_db}"
```

检查所有业务表都归恢复角色所有，并切换为该角色读取关键行数和金额汇总。结果必须与这份备份的
来源基线及抽样订单核对，不能只看命令退出码：

```bash
sudo -u postgres psql --dbname="${restore_db}" --set ON_ERROR_STOP=1 \
  --set restore_role="${restore_role}" <<'SQL'
SELECT schemaname, tablename, tableowner
FROM pg_tables
WHERE schemaname = 'public' AND tableowner <> :'restore_role';
SET ROLE :"restore_role";
SELECT count(*) AS tenants FROM tenants;
SELECT count(*) AS orders, COALESCE(sum(total_cents), 0) AS order_total_cents FROM orders;
SELECT count(*) AS payments, COALESCE(sum(amount_cents), 0) AS payment_total_cents FROM payments;
RESET ROLE;
SQL
```

接着让当前发布版本对恢复库执行迁移校验。环境文件位于 `/run` 且只让 systemd manager 读取，
演练结束必须删除：

```bash
restore_env=/run/siyan-settlement-666-restore.env
sudo install -m 0600 -o root -g root /dev/null "${restore_env}"
sudoedit "${restore_env}"
```

文件内容使用恢复角色的 URL 编码密码：

```text
DATABASE_URL=postgresql://siyan_restore_app:URL_ENCODED_PASSWORD@127.0.0.1:5432/siyan_restore_drill
```

```bash
sudo systemd-run --unit=siyan-settlement-666-restore-migrate --wait --collect --pipe \
  --property=Type=oneshot \
  --property=User=siyan-settlement-666 \
  --property=Group=siyan-settlement-666 \
  --property=WorkingDirectory=/opt/siyan-settlement-666/current \
  --property=EnvironmentFile="${restore_env}" \
  /usr/bin/env NODE_ENV=production HOST=127.0.0.1 PORT=17666 SEED_DEMO=false \
    PUBLIC_ORIGIN=https://123.56.254.236:666 \
  /opt/siyan-settlement-666/runtime/node/bin/node \
  /opt/siyan-settlement-666/current/dist/src/cli/migrate.js
```

最后在独立回环端口启动临时应用，验证数据库健康和静态入口，然后停止临时 unit：

```bash
set -Eeuo pipefail
restore_env=/run/siyan-settlement-666-restore.env
restore_unit="siyan-settlement-666-restore-smoke-$(date +%s)"
cleanup_restore_smoke() {
  sudo systemctl stop "${restore_unit}.service" 2>/dev/null || true
  sudo rm -f -- "${restore_env}"
}
trap cleanup_restore_smoke EXIT
sudo systemd-run --unit="${restore_unit}" --collect \
  --property=Type=simple \
  --property=User=siyan-settlement-666 \
  --property=Group=siyan-settlement-666 \
  --property=WorkingDirectory=/opt/siyan-settlement-666/current \
  --property=EnvironmentFile="${restore_env}" \
  /usr/bin/env NODE_ENV=production HOST=127.0.0.1 PORT=17666 SEED_DEMO=false \
    PUBLIC_ORIGIN=https://123.56.254.236:666 \
  /opt/siyan-settlement-666/runtime/node/bin/node \
  /opt/siyan-settlement-666/current/dist/src/server.js
curl --fail --retry 30 --retry-all-errors --retry-delay 1 \
  http://127.0.0.1:17666/api/health
curl --fail http://127.0.0.1:17666/ >/dev/null
sudo systemctl stop "${restore_unit}.service"
sudo rm -f -- "${restore_env}"
trap - EXIT
```

## 上线后只读验证

```bash
systemctl status siyan-settlement-666.service
sudo ss -lntup | grep -E ':(666|16666)\\b'
curl --fail --silent --show-error http://127.0.0.1:16666/api/health
curl --fail --silent --show-error https://123.56.254.236:666/api/health
sudo journalctl -u siyan-settlement-666.service -n 100 --no-pager
```

预期只有 Nginx 对外监听 `666`，Node 只监听 `127.0.0.1:16666`。上线验收记录必须同时包含
证书 hook 的成功日志、`certbot-ip-renew.timer` 到 hook 的实际调用链，以及一次续期后 666 端口
证书指纹匹配的结果；缺少任一项都不能标记 TLS 自动续期已完成。
