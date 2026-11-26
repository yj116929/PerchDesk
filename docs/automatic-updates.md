# 自动更新发布

0.6.5 是首个带应用内更新能力的版本。0.6.4 及更早版本需要先手动安装 0.6.5。桌面客户端从打包时附带的信令 profile 获取 HTTPS 更新地址。客户端验证清单 RSA-SHA256 签名、安装包 SHA-256、macOS 应用签名和版本号。

截至 2026-11-26，服务器发布清单指向 0.7.0，macOS universal 与 Windows x64 包均已上传并通过 SHA-256、清单签名、客户端 TLS 证书链和 HTTPS 下载路由校验。部署记录见 docs/server-deployment.md。

0.6.7 是本地修复构建，尚未上传或发布。0.6.6 打包文件曾通过签名和 ZIP 校验，但首次启动时 macOS 因 hardened runtime 库校验拒绝加载 Electron Framework，Windows 包内原生键鼠程序也未从 ASAR 解包。0.6.7 为 macOS 签名加入 Electron 所需 entitlement，并修正 Windows 原生程序的 ASAR 解包规则。新打包流程会从生成的 macOS ZIP 解压应用并确认工作台页面加载，也会检查 Windows ZIP 中的可执行文件和解包后的原生组件。

## 发布身份

更新清单私钥使用 macOS 本地发布身份：

    ~/Library/Application Support/PerchRemote Signing/identity.pem

同一身份还用于签名 Mac 应用。desktop/update-public-key.pem 中的客户端公钥证书必须与它匹配。打包前，脚本会验证证书与本地身份。私钥不要复制到服务器或提交到仓库。恢复备份时必须恢复与已发布客户端公钥匹配的身份。

本地打包 profile 在 releases/PerchRemote-signal-profile.json，或通过 PEERDESK_SIGNAL_PROFILE 指向提供的 profile 文件。更新服务器和客户端信令服务器使用同一 HTTPS origin。

## 构建版本

先更新 package.json 和 package-lock.json 的版本号，再在 macOS 发布机上运行：

    npm run package -- all

脚本同时生成两平台的通用 ZIP、带版本号的更新 ZIP、哈希清单和签名的 releases/latest.json。需要同时构建两平台，避免发布的清单缺少当前客户端所需的平台资产。

可在发布前检查签名和资产元数据：

    node --input-type=module -e "import { readFile } from 'node:fs/promises'; import { verifyManifest } from './desktop/updater.cjs'; const envelope = JSON.parse(await readFile('releases/latest.json', 'utf8')); const key = await readFile('desktop/update-public-key.pem', 'utf8'); console.log(verifyManifest(envelope, key));"

## 部署静态资产

在服务端部署目录准备更新目录：

    cd /home/ubuntu/peerdesk-signal/deploy/tencent
    mkdir -p updates

将 PerchRemote-macOS-universal-<版本>.zip、PerchRemote-Windows-x64-<版本>.zip 和 latest.json 上传到此目录。先上传版本化 ZIP 并确认文件完整，最后替换 latest.json。latest.json 指向的两个包必须先可下载。清单替换后，新客户端即可看到新版本，不需要重建容器。

更新包通过专用 TLS 入口的 /updates/ 路径提供。检查：

    curl -fsSI https://110.40.177.207:8443/updates/latest.json
    curl -fsSI https://110.40.177.207:8443/updates/PerchRemote-macOS-universal-<版本>.zip

客户端下载最多 1 GiB 的更新文件，并在安装前校验清单声明的大小和 SHA-256。更新包保留在服务端以供较旧客户端下载。待确认旧版本客户端不再需要后，可手动清理过期 ZIP。

## 客户端行为

正式打包客户端启动后先延迟检查，之后每六小时检查一次。发现版本后自动下载，并显示真实下载百分比。下载不会结束当前远控会话。安装需用户点击「立即重启更新」，如有活动会话，先确认结束会话。

重启后由独立辅助进程展示安装进度，完成后启动新版并等待工作台确认成功。替换或启动失败时辅助进程尽量恢复旧版。macOS 自动更新仅适用于有写权限的应用目录。Windows 自动更新需要写入应用所在磁盘，应用应从独立的 PerchRemote 文件夹运行。
