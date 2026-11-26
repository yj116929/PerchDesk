# Perch的远程助手 代码审查报告

- 审查日期：2026-11-25
- 审查版本：0.6.4（提交 `0bd7f68`）
- 审查范围：仓库内全部自研代码，包括服务端、桌面主进程与预加载、渲染页面、macOS 和 Windows 原生组件、打包与签名脚本、腾讯云部署配置、测试。不含 `node_modules/`、`releases/` 和 `.build/` 下的第三方产物。
- 测试结果：`node --test test/*.test.mjs` 19 项全部通过（本机 Node 22.23）。`test:e2e`、`test:workspace`、`test:performance` 需要 Electron 图形环境，本次没有运行。
- 本次只做审查，没有修改任何代码。

## 一、总体评价

项目的安全基础整体扎实：

- **Electron 隔离做得到位。** 窗口全部开启 `sandbox` 和 `contextIsolation`，IPC 都检查了 `senderFrame.url`，自定义协议有文件白名单，导航、弹窗和 webview 都被拦截。
- **认证实现规范。** 会话令牌只以 SHA-256 哈希入库；密码使用 scrypt 和 `timingSafeEqual`，账号不存在时用假盐对齐耗时；登录验证码对未注册邮箱也返回 challenge，防止枚举。
- **口令协助模式是端到端加密的。** 信令内容用客户端生成的密钥做 AES-GCM 加密，附加数据里绑定了房间、角色和序号，服务器只转发密文。
- **输入通道有完整的防护。** 键名白名单、坐标范围检查、滚轮限幅、速率限制、`inputGate` 防止旧授权复用，开启控制前强制注册紧急停止快捷键。
- **文件接收是安全的。** 文件名过滤了路径分隔符、控制字符和 Windows 保留名；每个文件放在独立的临时目录，以 `wx` 方式创建，不会自动打开，24 小时后清理。
- **页面没有 XSS 入口。** `public/` 中没有使用 `innerHTML`、`insertAdjacentHTML` 或 `outerHTML`，两个页面都有 CSP。
- **专用信令证书做了固定。** 校验证书链、主机名和指纹。

主要风险集中在一处：**账号令牌会被发给任意信令地址，而账号直连又是免确认控制**。两者叠加，构成"粘贴一个链接就被远程控制"的攻击链。这一条必须在下次发布前修复。

## 二、问题总表

| 编号 | 级别 | 问题 | 位置 |
| --- | --- | --- | --- |
| C1 | 严重 | 账号令牌被发往邀请链接中的任意服务器，可导致账号接管和免确认远控 | `main.cjs` 606/612、`network.cjs` 62–84、`app.js` 692/717 |
| H1 | 高 | 账号直连自动接受控制，被控窗口可能隐藏，被控者无感知 | `main.cjs` 211/224/331–335 |
| H2 | 高 | 账号安全能力不足：无法查看或注销其他会话，没有改密码和删除设备的接口 | `accounts.mjs` 路由表 |
| H3 | 高 | 账号直连的信令密钥由服务器生成，服务器可以中间人攻击 | `server.mjs` 149、`session.js` 78 |
| H4 | 高 | 打包未加固：没有 asar 和 fuses，macOS 未开启 hardened runtime | `package.mjs` 131、`macos-signing.mjs` 92 |
| M1 | 中 | 部署未设置 `PEERDESK_TRUST_PROXY`，全站共用一个限流桶 | `compose.yaml` |
| M2 | 中 | 全局配额容易被单个用户或单个邮箱占满 | `accounts.mjs` 97、`email.mjs` 78、`server.mjs` 216 |
| M3 | 中 | TURN 权限撤销不彻底 | `server.mjs` 37–56 |
| M4 | 中 | 同账号下可以冒用设备 ID，把真实设备挤下线 | `accounts.mjs` 225–229 |
| M5 | 中 | 剪贴板传文件没有总大小上限，可以写满磁盘 | `file-clipboard.cjs` 162–163 |
| M6 | 中 | 密码登录没有按账号的失败限制 | `accounts.mjs` 107–111 |
| M7 | 中 | 管理邮箱写死在代码和 README 中 | `account-store.mjs` 10 |
| M8 | 中 | SMTP 固定使用 `secure: true`，不支持 587 端口 STARTTLS | `email.mjs` 29 |
| L1–L12 | 低 | 代码质量、配置和功能细节 | 见第五节 |

## 三、严重问题

### C1. 账号令牌被发往任意信令服务器

**现象**

1. 在"加入"流程中，`main.cjs` 612 行把当前账号的令牌 `accounts.signalToken()` 放进会话参数。`session:options`（421–424 行）把整个参数对象，包括令牌，交给渲染进程。
2. `app.js` 692 行直接从用户粘贴的邀请链接里取信令地址。"共享"流程（`main.cjs` 606 行、`app.js` 717 行）中，地址来自用户可以随意填写的输入框。
3. `network.cjs` 62–84 行的 `openSignal` 只做格式检查（`signalAddress`），不检查地址是否属于令牌所在的服务器，就以 `Authorization: Bearer <令牌>` 发起连接。
4. 局域网 HTTP 地址是允许的（`signalAddress(..., true)`），所以令牌也可能明文传输。

**攻击链**

1. 攻击者发送 `https://evil.example/#<room>.<secret>`。格式合法，能通过 `parseInvite` 和 `signalAddress`。
2. 受害者在工作台粘贴并加入，令牌被发到 `evil.example`。
3. 攻击者用这个令牌连接真实服务器的 `/devices`。不带 Origin 头可以通过 `accounts.mjs` 254 行的检查。接着登记一台假设备，调用 `/api/devices/connect` 连接受害者的任意在线设备。
4. 被控端自动开始采集屏幕并开启键鼠控制，不弹确认框（见 H1）。工作台没打开时，被控窗口是隐藏的。
5. 令牌有效期 30 天。受害者除非主动退出登录，否则不会让它失效。

**修复建议**

1. 令牌只保存在主进程。`session:options` 返回前删除 `token` 字段，`connectSignal` 不再接收令牌参数。
2. `openSignal` 根据目标地址的 origin 在 `accounts` 的记录中查找令牌：找到同源的已登录账号就用它的令牌；找不到就拒绝连接，并提示"请先登录该信令服务器"。服务器的 `/signal` 本来就要求在该服务器登录，所以正常流程不受影响。
3. 加入一个与当前账号不同源的邀请时，工作台明确提示用户，并要求切换到对应账号。
4. 补充测试：令牌不出现在渲染进程；跨源地址不附带令牌。

## 四、高、中优先级问题

### H1. 账号直连免确认控制，被控者可能毫无察觉

- `enableInput` 在自动模式下跳过确认对话框（`main.cjs` 211、224 行）。
- `account-host` 窗口只在工作台可见时才显示（331–332 行），关闭时也只是隐藏（335 行）。被控机前的人可能完全看不到会话已经开始。

**建议**

- 被控期间始终显示一个不能隐藏的提示，例如托盘图标变色、系统通知或置顶的小浮窗，上面提供"立即结束"按钮。
- 引入设备配对：某台主控设备第一次连接时，被控端需要人工确认一次，之后记住。或者提供"仅允许已配对设备免确认"的设置项。

### H2. 账号安全能力不足

服务端只有以下几类接口：登录、验证码、`/api/me`、退出登录、管理员白名单和中转授权、`/api/devices/connect`。缺少这些能力：

- 查看和注销本账号的其他会话（"退出所有设备"）。令牌泄露后没有办法止损。
- 修改或重置密码。
- 删除设备。`account-store.mjs` 180 行的 `removeDevice` 没有任何路由在用，而 175 行的报错却提示用户"请删除旧设备"。设备数达到 100 台后账号就无法再登记新设备，攻击者登记的假设备也会一直留在列表里。
- 管理员禁用账号。

**建议**

按优先级补上：注销全部会话、删除设备、改密码，最后是管理员禁用账号。会话有效期也可以考虑从 30 天缩短，并加上滑动续期。

### H3. 账号直连的信令密钥由服务器生成

`server.mjs` 149 行生成 `invite.secret` 并下发给双方，`session.js` 78 行用它派生 AES-GCM 密钥。所以服务器能够解密甚至篡改 SDP，包括 DTLS 指纹，从而对账号直连的音视频和键鼠做中间人攻击。口令协助模式的密钥由客户端生成，不受影响。

**建议**

如果"信任自己的服务器"是有意的设计，请在 README 和部署文档中写明。否则可以给每台设备生成长期密钥对，同账号设备之间用设备公钥做 ECDH 协商会话密钥，服务器只负责分发公钥，首次配对时人工核对。这一方案可以和 H1 的设备配对一起做。

### H4. 打包加固不足

- `package.mjs` 131 行设置 `asar: false`，全程没有使用 `@electron/fuses`。本机任何进程都可以通过 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、`--inspect`，或者直接修改 `Resources/app/*.js`，在本应用内执行代码，从而借用它已获得的"屏幕录制"和"辅助功能"权限。
- `macos-signing.mjs` 92 行调用 `rcodesign sign` 时没有加 `--code-signature-flags runtime`，所以没有启用 hardened runtime，`DYLD_INSERT_LIBRARIES` 注入也可行。
- `package.mjs` 74–76 行把 `server/` 和 `server.mjs` 一起打进了桌面应用，桌面端用不到它们。

**建议**

- 开启 asar，并用 fuses 关闭 `RunAsNode`、`EnableNodeOptionsEnvironment` 和 `EnableNodeCliInspectArguments`，开启 `EnableEmbeddedAsarIntegrityValidation` 和 `OnlyLoadAppFromAsar`。
- 签名时加上 hardened runtime，只申请必要的 entitlements。
- 从桌面包中去掉服务端代码。

### M1. 部署未设置 `PEERDESK_TRUST_PROXY`

`compose.yaml` 中 signal 服务的环境变量里没有 `PEERDESK_TRUST_PROXY`。请求都经过 Caddy 转发，所以 `allowAttempt` 看到的来源 IP 全是 Caddy 容器的地址，整个站点共用一个限流桶：所有用户加起来每分钟只能做 12 次密码登录和 8 次验证码申请。一个人在刷，其他人就都登不上。

**建议**：在 `compose.yaml` 中加上 `PEERDESK_TRUST_PROXY: "1"`。现在只有 Caddy 一层代理，取 `X-Forwarded-For` 最后一段是正确的。以后如果增加 CDN 等代理层，需要同步调整取值逻辑。

### M2. 全局配额容易被占满

- 限流表达到 4096 条时，所有人都会收到 429（`accounts.mjs` 97 行）。
- 验证码服务全局每小时最多 40 封，冷却表最多 256 条，同时最多 4 封在发（`email.mjs` 78 行）。管理邮箱公开在 README 中，任何人都可以每分钟用它申请一次登录码。这样一小时就能耗尽全站的发信额度，同时持续骚扰管理员邮箱。
- 口令协助的 `create` 不检查 `rooms.size`（`server.mjs` 216 行，只有 `reserve` 检查了）。信令连接（1024）、房间（1024）和 `/devices` 连接（512）都只有全局上限，没有按账号限制。

**建议**

- 增加按账号的上限，例如每个账号最多 8 条信令连接、4 个房间。
- 对单个邮箱增加每小时的发信上限。
- 全局表满时淘汰最旧的条目，而不是拒绝所有请求。
- `create` 也检查房间数量。

### M3. TURN 权限撤销不彻底

- 使用外置静态凭证（`TURN_EXTERNAL_*`）时，所有获得授权的用户拿到的是同一组永久凭证。撤销某个人的权限后，他仍然能继续使用这组凭证。
- 使用 REST 凭证时有效期是 8 小时（`server.mjs` 51 行），撤销后在过期前依然可用。

**建议**：REST 凭证的有效期缩短到会话时长左右，比如 1 小时，在会话中按需刷新。在文档中说明，静态凭证无法做到按人撤销。

### M4. 同账号下可冒用设备 ID

`accounts.mjs` 225–229 行：用同一个设备 ID 再登记一次，就会把原设备挤下线，并接管它在列表中的身份。持有令牌的人（例如 C1 中的攻击者）可以冒充用户自己的某台电脑；用户点击连接这台"电脑"时，实际上连到的是攻击者的机器。

**建议**：首次登记设备时由服务器下发一个设备密钥，之后登记需要出示这个密钥。或者在设备 ID 冲突时拒绝新连接，而不是挤掉旧连接。

### M5. 剪贴板传文件没有总大小上限

`file-clipboard.cjs` 162–163 行限制每次最多 128 个文件，但单个文件的大小只检查了是否为安全整数。对方可以通过剪贴板传输写满本机磁盘。前提是被控端已经开启键鼠控制，或者主控端主动发起了复制。

**建议**：设置单次总量上限，例如 4 GiB；接收前用 `statfs` 检查剩余空间，并预留一部分余量。

### M6. 密码登录没有按账号的失败限制

限流只按 IP 计算（每分钟 12 次）。修好 M1 之后，攻击者用很多 IP 就能对单个账号持续尝试密码。

**建议**：按邮箱统计连续失败次数，超过阈值后要求改用邮箱验证码登录，或者逐步延长等待时间。

### M7. 管理邮箱写死

`account-store.mjs` 10 行和 README 中都写着管理员的个人 QQ 邮箱。这会泄露个人信息，也为 M2 的发信骚扰和针对性钓鱼提供了目标。

**建议**：改用环境变量 `PEERDESK_ADMIN_EMAIL`，可以配置多个；从 README 中删除具体邮箱地址。

### M8. SMTP 只支持 465 端口

`email.mjs` 29 行固定 `secure: true`，配置 587 端口（STARTTLS）时会连接失败。

**建议**：根据端口自动判断，或者在配置文件中增加 `secure` 字段，并设置 `requireTLS: true`。

## 五、低优先级问题

| 编号 | 问题 | 位置 |
| --- | --- | --- |
| L1 | `finish(room, reason)` 只有两个参数，但有三处调用传入了第三个参数 `socket`。看起来原意是不给发起方发送 `ended`，现在发起方也会收到。需要确认意图后统一。 | `server.mjs` 64、180、233 |
| L2 | 口令协助房间的 `allowTurn` 固定为 false，已获中转授权的用户在跨网络协助时也用不上 TURN。请确认这是否为有意设计。 | `server.mjs` 217 |
| L3 | preload 的 `onStop`、`onInputReceipt`、`onState`、`onPermissions`、`onWindows` 每调用一次就新增一个监听，没有取消订阅的方法。页面重复调用会累积监听。 | `preload.cjs` 91、95、132–134 |
| L4 | 数据库目录权限是 0700，但 sqlite 文件以及 `-wal`、`-shm` 文件按 umask 创建。Docker 中影响不大，裸机部署时建议设置 `umask 077`。 | `account-store.mjs` 26 |
| L5 | 遗留代码：`username`、`wechat` 列；`email_auth` 迁移（新会话一律写 1，查询中的条件已经多余）。 | `account-store.mjs` |
| L6 | `capture:arm` 先检查音频支持再检查 ctx，顺序反了，不影响功能。 | `main.cjs` 434 |
| L7 | `.env.example` 中的 `TURN_ACCESS_TOKEN` 服务端没有读取。 | `deploy/tencent/.env.example` |
| L8 | `.gitignore` 没有包含 `deploy/tencent/private-tls/`。将来放入 `signal.key` 时容易被误提交。 | `.gitignore` |
| L9 | `engines` 写的是 `>=22`，但 `node:sqlite` 在 22.13 之前需要加实验参数才能用，建议改为 `>=22.13`。Docker 使用 `node:24`，不受影响。 | `package.json` |
| L10 | `.build/tencent-test/perch-test-user` 中有一串像令牌的长字符串。该目录已被 git 忽略，不会被提交；如果它是线上测试账号的有效令牌，建议在服务端注销后删除这个文件。 | `.build/tencent-test/` |
| L11 | Windows 采集组件每一帧都新建一张共享纹理和一个 NT 句柄。60 fps 以上时有额外开销，可以改为复用 2–3 张纹理轮转。 | `wininput/capture_windows.go` 119–150 |
| L12 | 已知限制，建议写进 README：Windows 下 `SendInput` 无法操作以管理员身份运行的窗口，也无法操作 UAC 安全桌面；macOS 锁屏后会话会结束。 | `wininput/main_windows.go` |

## 六、已核查、没有发现问题的部分

- **页面渲染：** 设备名、文件名、对端文本都通过 `textContent` 或 `value` 写入页面，没有 HTML 注入。
- **接收文件：** 文件名清洗、独立目录、`wx` 创建、发送端的 `O_NOFOLLOW` 与 inode 和修改时间校验、24 小时清理，都已实现。
- **原生输入：** macOS 端有键名白名单、0–1 坐标检查、`CGDisplayIsActive` 校验和滚轮限幅；Windows 端有扫描码白名单，输入行最长 2048 字节，JSON 解析失败时直接退出。
- **屏幕采集：** ScreenCaptureKit 与 threadsafe function 的引用和释放成对出现，帧队列有上限（最多保留 2 帧）。Windows 端的句柄回收只接受自己发出的句柄。
- **剪贴板原生实现：** macOS 只读取文件 URL，写入前校验绝对路径；Windows 限制最多 512 项，输入不超过 4 MiB。
- **验证码：** 6 位数字，5 分钟有效，每个 challenge 最多尝试 5 次，同一地址 60 秒冷却，校验使用 HMAC 和定时比较。
- **WebSocket：** 信令只接受 `peerdesk://app` 或同源 Origin，使用 Bearer 鉴权，不存在跨站 WebSocket 劫持；负载大小、发送缓冲、心跳和消息速率都有限制。
- **被控端处理对端消息：** 锁屏和静音等 `safety` 设置要求已授权控制，并检查 `grantVersion`；路径切换要求 `routeId` 单调递增。
- **打包供应链：** Electron 运行时和 rcodesign 都做了 SHA-256 校验。

## 七、测试覆盖

现有 19 项单元测试覆盖了信令和账号流程、TURN 授权与撤销、注册白名单、数据库迁移、采集管线、输入顺序和诊断统计。缺少以下测试：

1. 令牌与信令地址的绑定，即 C1 修复后的回归测试。
2. `desktop/accounts.cjs`：账号切换、401 时清理记录、令牌持久化。
3. `file-clipboard.cjs`：数量和大小上限、文件名清洗、取消后的清理。
4. `main.cjs` 的 IPC 权限检查：非会话页面、非工作台页面调用时应被拒绝。
5. 验证码的单地址冷却和全局配额行为。

## 八、建议的修复顺序

1. **C1**：令牌只留在主进程，并与信令地址绑定。这一条必须在下次发布前完成。
2. **M1**：在 compose 中加一行 `PEERDESK_TRUST_PROXY: "1"`，改动小、收益大。
3. **H1**：被控期间常驻提示，并支持设备配对确认。
4. **H2**：注销全部会话、删除设备、改密码。
5. **H4**：asar、fuses 和 hardened runtime。
6. **M2、M4、M5、M6**：按账号和按邮箱的配额、设备 ID 绑定、剪贴板总量上限、按账号的失败限制。
7. **H3、M3**：根据你确定的信任模型，决定是否引入设备密钥，以及如何缩短 TURN 凭证有效期。
8. **M7、M8**及低优先级问题：顺手清理。
