# 服务端部署记录

记录日期为 2026-11-25。本文整理最近一次部署后确认的信息，便于后续维护。

## 服务器与目录

- 主机地址为 `110.40.177.207`。
- SSH 用户为 `ubuntu`，端口为 `22055`。
- 服务端部署目录为 `/home/ubuntu/peerdesk-signal`。
- 连接命令为 `ssh -p 22055 ubuntu@110.40.177.207`。

## 部署状态

- 服务使用 Docker Compose 运行。
- 最近一次部署检查时，信令服务容器状态为 `healthy`，`/healthz` 返回 `ok`。
- 已部署邮箱账号登录和由管理员授权账号使用服务器中转的服务端逻辑。
- 更新时保留了服务器上的 `.env` 配置和原有 `peerdesk-accounts` 数据卷。
- 仓库 README 的 SSH 转发示例使用本机端口 `18787` 和服务端 HTTP 端口 `8787`。仓库 Compose 配置将 HTTP 端口绑定到服务器回环地址。
- 桌面端使用 `https://110.40.177.207:8443`，TLS 证书由专用 CA `PeerDesk Private Signaling Authority` 签发。客户端需随包提供信令证书配置，不能仅依赖操作系统默认 CA 列表。

服务器密码、`.env` 内容和账号数据均不记录在本文件或 Git 仓库中。TURN 地址及凭证沿用服务器 `.env`，本次记录未抄录其值。

## 连接和检查

先连接服务器，再进入部署目录：

```sh
ssh -p 22055 ubuntu@110.40.177.207
cd /home/ubuntu/peerdesk-signal
```

查看容器、信令日志和健康检查：

```sh
docker compose ps
docker compose logs --tail=100 signal
curl -fsS http://127.0.0.1:8787/healthz
```

## 更新信令服务

在部署目录放入新的服务端部署文件后，按现有 Compose 配置重建信令服务：

```sh
docker compose up -d --build signal
docker compose ps
curl -fsS http://127.0.0.1:8787/healthz
```

更新时继续使用现有部署目录和 Compose 项目，以保留 `.env` 与 `peerdesk-accounts` 数据卷。桌面安装包和服务端部署包位于本机 `releases/`，该目录被 Git 忽略。

## 桌面客户端证书配置

打包专用桌面客户端时，客户端需要包含信令地址、服务证书和 CA 证书组成的 profile。客户端会校验 CA 签名、服务器 IP 和证书指纹。服务端证书目前有效至 2029-02-25，签发 CA 目前有效至 2036-11-20。本机当前 profile 保存在 `releases/PerchRemote-signal-profile.json`，打包脚本会自动读取该文件，`releases/` 已加入 `.gitignore`。如需从其他位置打包，可通过 `PEERDESK_SIGNAL_PROFILE` 指定路径。

从项目根目录重新打包时使用：

```sh
npm run package -- all
```

信令证书或 CA 更新后，从服务器取回公开证书 `signal.crt` 和 `authority.crt`，重生成本机 profile 并重打桌面包。服务器私钥留在服务器端。未带 profile 的客户端访问这个 HTTPS 地址时会报证书链校验错误。


## 2026-11-25 自动更新发布

- 服务端已升级到包含应用内更新文件路由的版本。信令容器和 TCP 8443 的私用 TLS 入口在重建后均正常。
- 更新文件目录是服务器上的 /home/ubuntu/peerdesk-signal/deploy/tencent/updates，容器以只读方式挂载到 /updates。专用 TLS 入口将 /updates/* 转发到信令服务。
- 已发布并验证 0.6.5 更新清单和两个平台安装包。客户端公钥验证、服务器 TLS 证书、清单签名及两个安装包的大小和 SHA-256 均已通过。
- 更新部署保留了 deploy/tencent/.env、私用 TLS 证书和 peerdesk-accounts 数据卷。替换前的代码与 Compose 文件保存在 /home/ubuntu/.perch-backups/automatic-updates-20261125。
- 从仓库根目录运行 Compose 时明确指定项目 peerdesk-signal，并同时带上 compose.yaml、compose.private-tls.yaml 和 compose.smtp.yaml。漏掉项目名会创建独立的 tencent 项目并争用 8787 端口。
- 新版本发布时，先把版本化 ZIP 上传到 updates 目录，验证文件大小和哈希后，再以原子重命名替换 latest.json。无需重建容器。

服务器端部署命令可从仓库根目录运行：

    sudo docker compose -p peerdesk-signal -f deploy/tencent/compose.yaml -f deploy/tencent/compose.private-tls.yaml -f deploy/tencent/compose.smtp.yaml up -d --build signal private-edge turn

自动更新实现、首个支持版本和客户端首次升级要求记录在 docs/automatic-updates.md。

## 2026-11-25 0.6.6 部署记录

- 0.6.6 服务端代码已部署并重建 signal 与 private-edge。signal 容器状态为 healthy，`/healthz` 返回 `ok`，`/api/info` 返回 `{"auth":"email","email":true}`。
- 更新清单已原子替换为 0.6.6。通过客户端使用的主机名和 TLS 入口访问清单及两个版本化安装包均返回 HTTP 200。
- macOS 通用包大小为 226185775 字节，SHA-256 为 `19bfeab9889659d4528c13e3f41130d08801ee1f548d9a26cf56c31b3c019106`。
- Windows x64 包大小为 159994926 字节，SHA-256 为 `f11eaf0497320007e97fb955b783a1bf5997aceea2383abbae13d8c84d55a1bf`。
- 服务端包 SHA-256 为 `2c373d04d146d0ac687778ce491b364ec0eea4c1fa12d434b785c7b3b1e09d4d`。上传暂存副本位于 `/home/ubuntu/.perch-release-staging-0.6.6/PerchRemote-Tencent-Signal.tar.gz`。
- 部署前备份位于 `/home/ubuntu/.perch-backups/automatic-updates-20261125-0.6.6`。`.env`、私用 TLS 证书和 `peerdesk-accounts` 数据卷均保留。

## 2026-11-25 0.6.7 本地验证

- 0.6.7 修复了 macOS hardened runtime 拒绝加载 Electron Framework，以及 Windows 原生键鼠程序未从 ASAR 解包的问题。
- macOS 与 Windows ZIP 已在本地重新构建。macOS 包从 ZIP 解压后已启动并加载工作台页面，Windows 包已验证包含有效 PE 主程序和 ASAR 外置的原生键鼠程序。
- 本地打包清单已更新为 0.6.7。该版本尚未上传到服务器，线上服务和 `latest.json` 未在此次修复中更改，仍保持上一节记录的 0.6.6 状态。

## 2026-11-26 TURN 中继部署

- 已启用自建 coturn，TURN 地址为 `turn:110.40.177.207:3478`。服务器公网地址映射到网卡私网地址 `10.0.0.17`。coturn 只监听该私网地址，避免 Docker 网桥地址进入 ICE 候选。
- `deploy/tencent/.env` 已配置一小时有效 TURN 临时凭证所需的随机共享密钥、外部 IP 映射和 UDP 中继端口范围 `49160–49200`。`.env` 权限为 `600`，共享密钥未写入本文或 Git。
- 复用了已支持 TURN 临时凭证和账号授权控制的信令镜像。`signal` 与 `turn` 容器已启动，`signal` 状态为 healthy，`/healthz` 返回 `ok`，`/api/info` 返回 `{"auth":"email","email":true}`。
- 服务器内的 STUN 探测返回公网映射地址 `110.40.177.207`。基于 TURN 共享密钥的临时凭证已通过分配及中继回显测试。从本机外网探测到 UDP、TCP 3478 均可连接。
- 用户确认云防火墙已放行 UDP/TCP 3478 和 UDP 49160–49200。管理员授权逻辑保持生效，只有获授权的账号可取得中继凭证，口令协助仍要求双方账号均获授权。
- 部署前备份位于 `/home/ubuntu/.perch-backups/turn-20261126-013140`，包含 `.env`、Compose 配置和 coturn 启动脚本副本。

## 2026-11-26 0.6.8 更新测试发布

- 本机已运行 `npm test`，37 项测试全部通过，并运行 `npm run package -- all` 生成 macOS universal 与 Windows x64 包。打包流程中的 macOS 解压启动检查及 Windows 主程序、原生组件检查均通过。
- 两个安装包已上传至服务器更新目录，并在服务器端完成文件大小和 SHA-256 校验后原子替换 `latest.json`。替换前的清单备份为 `latest-before-0.6.8.json`，0.6.6 版本包继续保留。
- macOS ZIP 为 226204199 字节，SHA-256 为 `bc451c6decd65e0d195eab6d5c9b4283dcf634c5090a79dff66c1172143dcb18`。Windows ZIP 为 160001315 字节，SHA-256 为 `d11800552253bb1d0407aba0a560dcd53adfe55a7fffcf472d5973932872c1d2`。
- 通过客户端使用的 TLS 证书链访问线上更新地址，`latest.json` 返回 0.6.8 且签名验证通过。两个版本化 ZIP 路由均返回 HTTP 200，Content-Length 与清单匹配。

## 2026-11-26 0.7.0 发布

- 本机运行 `npm test`，39 项测试全部通过。macOS universal 包通过解压启动及工作台页面加载检查，Windows x64 包通过结构检查，并从实际 ZIP 解压后的 `resources/app.asar` 读取到 `PerchRemote` 版本 0.7.0。
- 两个平台的 0.7.0 ZIP 已上传至服务器更新目录，服务器端 SHA-256 与本机发布清单一致。随后以原子重命名切换 `latest.json`，切换前清单备份为 `latest-before-0.7.0.json`。
- macOS ZIP 为 226205275 字节，SHA-256 为 `fda92834413bd3adf8bf120ce21d0355790c3a59c84eea229932878bf8c4e12d`。Windows ZIP 为 160002403 字节，SHA-256 为 `2b69ec830bb53d156a1646a1f0ba16f7ad7f69564908334fa3747ab2ca211e95`。
- 通过客户端使用的 TLS 配置访问线上更新地址，0.7.0 清单签名验证通过。两个 ZIP 路由均返回 HTTP 200，Content-Length 与清单匹配。本次仅发布桌面更新资产，未重建信令容器。
