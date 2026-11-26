# 腾讯云轻量部署

腾讯云实例提供 HTTPS 信令和 STUN 地址发现。P2P 连接成功后，画面、键鼠、文件和文本在会话双方之间传输。默认服务只处理信令与 STUN，coturn 以 `--stun-only` 启动。异地网络无法直连时，可用其他机器或托管服务提供 TURN。

| 流量 | 经过哪里 |
| --- | --- |
| 邀请、ICE 候选、加密 SDP、心跳 | 腾讯云 HTTPS 信令 |
| 登录、在线设备列表 | 腾讯云 HTTPS 账号服务 |
| 探测公网地址和端口 | 腾讯云 UDP STUN |
| 直连的画面、键鼠和文件 | 两台电脑之间 |
| TURN 中继的加密流量 | 单独配置的 TURN 服务 |

## 部署

服务端需要 Docker 与 Docker Compose。将服务端部署包解压到服务器，进入 `deploy/tencent`。首次运行用 `install -m 600 .env.example .env` 创建配置，填入 `PEERDESK_HOST` 和 `PEERDESK_ADMIN_EMAILS`。管理员邮箱可用逗号分隔配置多个。升级已有部署时，将原管理员邮箱填入此字段以保留管理员权限。`PEERDESK_HOST` 写域名或固定公网 IPv4 地址，无需加 `https://`。使用域名时，将 DNS A 记录指向服务器，STUN 要能直接到达这台服务器的 UDP 监听端口。

**独立 HTTPS 入口**使用公网 TCP 443。腾讯云防火墙放行 TCP 443 和用于 STUN/TURN 的 UDP 3478（以 `PEERDESK_STUN_PORT` 为准）。启用本机 TURN 时，还需放行该端口的 TCP 和下方配置的 UDP 中继端口段。直接使用公网 IP 时，将它填入 `PEERDESK_HOST`。

```sh
docker compose --profile edge up -d --build
```

Caddy 通过 TCP 443 上的 TLS-ALPN-01 自动签发和续期证书。公网 IP 证书使用 Let’s Encrypt 的 `shortlived` 配置。等待证书签发时，可用 `docker compose --profile edge logs --tail=60 edge` 查看进度。 [Let’s Encrypt IP 证书说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability) · [TLS-ALPN-01](https://letsencrypt.org/docs/challenge-types/#tls-alpn-01) · [腾讯云轻量实例防火墙](https://cloud.tencent.com/document/product/1207/44577/)

**复用已有 HTTPS 入口**时，保留现有站点，由现有反向代理转发到 `127.0.0.1:8787`（以 `PEERDESK_HTTP_PORT` 为准）。转发需要保留原始 Host 并支持 WebSocket Upgrade。防火墙另外放行 STUN UDP 端口即可。

```sh
docker compose up -d --build
```

启动后从公网请求 `https://你的域名或IP/healthz`，应返回 `ok`。共享端选择「自建信令服务」，填同一 HTTPS 地址后创建邀请。对端在桌面客户端粘贴邀请即可，两个应用包都可沿用。

## 通过已有 SSH 端口连接

若两台电脑都能登录同一台腾讯云实例，可以通过 SSH 转发信令。服务器只启动 `signal`，保持 HTTP 监听绑定在服务器的回环地址。若 STUN 端口未放行，在 `.env` 中设置 `PEERDESK_STUN_URLS=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302`，由公共 STUN 端点进行地址探测。

```sh
docker compose up -d --build signal
```

在两台电脑各开一个终端，用相同本机端口连接，替换 SSH 用户名、地址和端口。密码在各自的终端输入。

```sh
ssh -N -p 22055 -o ExitOnForwardFailure=yes -o ServerAliveInterval=25 -L 127.0.0.1:18787:127.0.0.1:8787 ubuntu@你的公网IPv4
```

两个终端在会话期间保持打开。共享方选择「自建信令服务」，填写 `http://127.0.0.1:18787` 并创建邀请。另一台电脑在桌面客户端粘贴邀请。若服务器只允许受信人员登录 SSH，这种连接方式适用于这些人员的设备。 [Cloudflare STUN 地址](https://developers.cloudflare.com/realtime/turn/)

## TURN 中继

部署包内的 coturn 默认仅提供 STUN。需要中继时，在 `.env` 设置 `TURN_URLS`、`TURN_SHARED_SECRET` 和 `TURN_EXTERNAL_IP`。`TURN_EXTERNAL_IP` 在腾讯云这类公网 IP 映射到私网网卡的环境中使用 `公网IP/私网IP` 格式。`TURN_MIN_PORT` 和 `TURN_MAX_PORT` 默认限制 UDP 中继端口为 49160–49200。腾讯云防火墙需放行 UDP/TCP 3478 及 UDP 49160–49200，然后重建 `turn` 与 `signal` 服务。

```sh
docker compose -p peerdesk-signal -f compose.yaml -f compose.private-tls.yaml -f compose.smtp.yaml up -d --build turn signal
```

信令服务使用共享密钥签发一小时有效的临时凭证，客户端不会接触共享密钥。管理员登录工作台后，在「服务器中转授权」添加已注册账号邮箱。口令协助需要双方账号都获得授权。

## 可选的外置 TURN

如果使用其他服务提供 TURN，在 `.env` 中填外部服务的 `TURN_URLS`，可列逗号分隔的 UDP、TCP 或 TLS 地址。使用支持 REST 密钥的外置 coturn 时，填 `TURN_SHARED_SECRET`。使用托管服务提供的用户名和密码时，填 `TURN_EXTERNAL_USERNAME` 和 `TURN_EXTERNAL_CREDENTIAL`。两种凭证方式选其一。

使用 `TURN_EXTERNAL_USERNAME` 和 `TURN_EXTERNAL_CREDENTIAL` 时，服务商提供的静态凭证只会发给获授权会话，其有效期由服务商决定。撤销授权会结束相关 PeerDesk 会话。静态凭证需要在服务商处轮换才能失效。托管服务应按服务商设定为 TURN 服务设置独立额度。 [coturn 配置说明](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)

## 邮箱账号与注册白名单

账号、登录会话、设备和注册白名单存放在 Docker 卷 `peerdesk-accounts`。升级请使用现有部署目录和 Compose 项目，保留 `.env`、数据卷、TLS 文件和 SMTP 配置。旧的非邮箱认证会话保持失效。已绑定邮箱的账号和设备记录会迁移，旧管理员邮箱需列入 `PEERDESK_ADMIN_EMAILS`。账号设置现在支持查看及注销会话、退出其他设备或所有设备、修改密码、删除设备。管理员可输入邮箱禁用账号并撤销其所有会话。数据库文件、WAL 和共享内存文件会限制为服务账号可读写。

163 发信使用 `smtp.163.com` 的出站 TCP 465 和客户端授权码。SMTP 配置支持 465 隐式 TLS 或 587 强制 STARTTLS。在宿主机准备一个仅部署用户可读的 JSON 文件，字段为 `host`、`port`、`user`、`password`。容器以 UID 1000 运行，需要能读取该文件。将文件的绝对路径填入 `.env` 的 `PEERDESK_SMTP_FILE`，再用附加配置启动信令。

```sh
docker compose -f compose.yaml -f compose.private-tls.yaml -f compose.smtp.yaml up -d --build signal
```

更新后，`GET /api/info` 应返回 `auth` 为 `email`、`email` 为 `true`。管理员邮箱可首次验证邮箱并设置密码。管理员登录新版客户端后，可在「账号 → 注册白名单」添加授权邮箱。其他邮箱需获授权并通过验证码验证才能注册。服务端按 IP 和邮箱限制密码尝试及验证码发送频率。

## TCP 8443 私用测试入口

compose.private-tls.yaml 提供面向桌面客户端的入口，代理 /signal、/devices、/api/*、/healthz 和 /updates/*。更新文件保存在本目录的 updates/，由信令服务只读提供。放行 TCP 8443，用一张专用 CA 签发包含服务器公网 IP 的服务证书，将服务证书及私钥放在本目录的 private-tls/signal.crt 和 private-tls/signal.key。保持私钥仅在部署端可读。

```sh
docker compose -f compose.yaml -f compose.private-tls.yaml up -d signal private-edge
```

构建专用客户端时，通过 `PEERDESK_SIGNAL_PROFILE` 指定 JSON 文件。`origin` 写作 `https://公网IP:8443`，`certificate` 填服务证书的 PEM 内容，`authority` 填 CA 证书的 PEM 内容。客户端仅在这个确切的信令地址使用该 CA，并校验服务证书指纹、有效期和地址。更新服务证书后，同步重建两端客户端。
