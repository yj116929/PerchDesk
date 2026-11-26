# 远程操控底层技术对比：Perch的远程助手 vs CrossDesk

- 日期：2026-11-26
- 对比对象：
  - **Perch的远程助手（下称 Perch）**：0.6.9，仓库 HEAD `bdef97c`（工作区含未提交改动）
  - **CrossDesk**：`kunkundi/crossdesk` 主分支，提交 `f5588a2`（2026-11-26）；其传输库 **MiniRTC** 为子模块 `kunkundi/minirtc`，提交 `c3b26b8`
- 范围：只比较"远程操控"的底层链路，即屏幕采集、视频编码、网络传输与拥塞控制、键鼠注入、信令与会话安全。界面、账号运营、DeskHub、CLI、MCP 等上层功能只在第九节简单列出。
- 依据与局限：Perch 的结论来自上一轮完整代码审查。CrossDesk 的结论来自它的 README、`docs/connection-architecture.md`、`docs/gui-architecture.md`、MiniRTC 的 README 与 `minirtc.h`，以及采集、输入注入、编码工厂等关键源文件。没有编译运行 CrossDesk，也没有做两者的实测性能对比，所以本文**不含延迟、帧率、CPU 占用的实测数字**。

## 一、一句话结论

两者走的是两条不同的路：

- **Perch 是"借 Chromium 的 WebRTC，自己补齐采集和注入"。** 编码、拥塞控制、重传、抖动缓冲、DTLS-SRTP 都由 Electron 内置的 libwebrtc 负责。Perch 自己写的是原生采集（macOS ScreenCaptureKit、Windows Graphics Capture）、零拷贝把画面送进 WebRTC 的管道、原生键鼠注入，以及加密信令。
- **CrossDesk 是"自研整条 RTC 栈"。** 用 C++17 写了 MiniRTC：基于 libnice 的 ICE，自己的 RTP/RTCP，移植自 WebRTC 的带宽估计与 pacing，自己的 FEC，显式选择的硬件或软件编解码器。上层是 Slint 原生界面。

Perch 的优势是复用成熟的 WebRTC 链路、macOS 采集到共享纹理的低拷贝交接、口令模式信令端到端加密，以及 WebRTC 强制的 DTLS-SRTP。CrossDesk 的优势是控制力强、平台覆盖广（Linux、移动端、浏览器）、Windows 采集更健壮（DXGI、WGC、GDI 三级回退，GPU 色彩转换，安全桌面，虚拟显示器），并且支持无人值守。

## 二、总体架构

| 维度 | Perch | CrossDesk |
| --- | --- | --- |
| 应用框架 | Electron 45（Node 主进程 + Chromium 渲染进程） | 原生 C++17，Slint 界面 + SDL，Xmake 构建 |
| 实时传输栈 | Chromium 内置 libwebrtc（`RTCPeerConnection`） | 自研 MiniRTC（LGPL-3.0），静态库，`extern "C"` 接口 |
| ICE / NAT 穿透 | libwebrtc 自带 ICE，STUN/TURN 由服务端下发 | libnice（带自有补丁），STUN、TURN UDP/TCP、UPnP |
| 媒体加密 | DTLS-SRTP，WebRTC 强制开启 | DTLS-SRTP；ID 模式下与旧版对端保留明文兼容分支，IP 直连模式强制加密 |
| 数据通道 | SCTP DataChannel，4 条：`control`（可靠有序）、`motion`（无序、不重传）、`file`、`file-clipboard` | MiniRTC 自有 RTP 数据流，按名称注册，可靠或不可靠；浏览器端走 libdatachannel |
| 信令 | 自研 Node 服务（`ws`），账号 Bearer 鉴权；口令模式下信令内容用客户端密钥做 AES-GCM 加密 | 自研 CrossDesk Server，WSS；设备用 Ed25519 签名登录，服务端校验目标设备密码 |
| 原生组件形态 | macOS：N-API 插件（`input.node`）；Windows：独立 Go 子进程（`input.exe`），用 stdin/stdout 文本协议通信 | 全部在同一个 C++ 进程内；Windows 另有系统服务和会话辅助进程 |
| 主控端形态 | 只有桌面端（浏览器版只能看提示，无法建立会话） | 桌面、浏览器、iOS、Android、鸿蒙、终端 CLI、MCP |
| 被控端平台 | macOS 13+、Windows x64 | Windows 10+、macOS 14+、Linux（X11、Wayland、无头）、鸿蒙 PC（开发中） |
| 许可证 | 私有 | CrossDesk GPL-3.0-only，MiniRTC LGPL-3.0-only |

Perch 一条完整的画面链路是：原生采集 → 共享纹理 → 渲染进程里的 `MediaStreamTrackGenerator` → libwebrtc 编码 → SRTP → 对端 libwebrtc 解码 → `<video>`。CrossDesk 是：原生采集 → NV12（CPU 或 GPU 句柄）→ MiniRTC 编码器工厂 → 自有 RTP/FEC/pacing → SRTP → 对端解码 → Metal/OpenGL 渲染器。

## 三、屏幕采集

### macOS

两者都用 ScreenCaptureKit，区别在像素格式和送往编码器的方式。

| 项目 | Perch（`desktop/screen.mm`） | CrossDesk（`screen_capturer_sck_impl.mm`） |
| --- | --- | --- |
| 像素格式 | `32BGRA` | `420YpCbCr8BiPlanar`（NV12，video range） |
| 光标 | `showsCursor = NO`，画面不含光标 | 可配置 `showsCursor` |
| 帧队列 | `queueDepth = 4`；JS 侧最多保留 2 帧，忙时只保留最新一帧 | 由 SCK 配置和 MiniRTC 帧调度控制 |
| 送往编码器 | `IOSurface` → Electron `sharedTexture` → `VideoFrame` 写入 `MediaStreamTrackGenerator`，**全程不经过 CPU 拷贝** | 锁定 `CVPixelBuffer` 后用 `memcpy` 逐行复制 Y 和 UV 平面到 CPU 缓冲；MiniRTC API 同时支持直接传 `CVPixelBufferRef` |
| 帧率调整 | `updateConfiguration` 动态切换 30/60/90/144 | `minimumFrameInterval` 按 fps 设置 |

Perch 在 macOS 上的采集路径更省：没有 CPU 拷贝，色彩转换由 Chromium 在 GPU 上完成。CrossDesk 直接输出 NV12，省去 BGRA→YUV 转换，但当前实现在部分路径上会做一次平面拷贝。

### Windows

这是两者差距最大的部分。

| 项目 | Perch（`wininput/capture_windows.go`） | CrossDesk（`platform/windows/screen_capturer/`） |
| --- | --- | --- |
| 采集 API | 只有 Windows.Graphics.Capture（WGC） | 固定顺序 **DXGI Desktop Duplication → WGC → GDI**，逐级回退 |
| 进程模型 | 独立 Go 子进程，用 `DuplicateHandle` 把 NT 句柄交给父进程，按文本行通知 | 同进程；另有系统服务路径用于锁屏和登录前桌面 |
| 色彩转换 | 不转换，BGRA 交给 Chromium | 优先用 D3D11 VideoProcessor 在 GPU 上把 BGRA 转为 NV12；不可用时回退到 CPU 的 libyuv |
| 纹理生命周期 | 启动时预建并复用 2 张共享纹理及 NT 句柄，按帧池空闲槽写入 | 复用 NV12 纹理槽；需要 CPU 帧时经 staging 纹理 `Map` 读回 |
| 光标 | `IsCursorCaptureEnabled = false`，画面不含光标 | DXGI 路径单独跟踪光标，可以合成进画面，也可以作为独立光标状态发送 |
| 特殊桌面 | 不支持。锁屏、UAC 安全桌面时会话结束 | 支持安全桌面采集（有独立的帧节拍和状态轮询）、无头恢复、虚拟显示器（usbmmidd） |
| 多显示器 | 按显示器中心点选择 | 稳定的显示器槽位、显示器热插拔处理、远程切换分辨率 |

DXGI Desktop Duplication 在 Windows 上通常延迟更低、能拿到"脏区域"信息，也是采集安全桌面的唯一常规办法；WGC 的优势是兼容性和隐私友好（有采集边框）。CrossDesk 三级回退加 GPU 色彩转换，是成熟远控软件的典型做法。Perch 只依赖 WGC，在没有显示器、锁屏、UAC 弹窗这些场景下都无法工作。

### Linux

Perch 不支持 Linux 被控端。CrossDesk 有 X11、DRM/KMS、Wayland（xdg-desktop-portal ScreenCast + PipeWire）三种后端，还支持 Xvfb/Xfce 无头会话。

## 四、视频编码

| 项目 | Perch | CrossDesk（MiniRTC） |
| --- | --- | --- |
| 编码器归属 | libwebrtc 内部选择，应用不能直接指定硬件或软件 | `VideoEncoderFactory` 显式选择后端 |
| 编码格式 | H.264、H.265；通过 SDP 编码器排序（`video-codecs.js`）表达偏好，协商失败回退 | H.264（默认）、H.265、AV1 |
| Windows 后端 | 由 Chromium 决定 | H.264：NVENC、Media Foundation 或 OpenH264；H.265：NVENC 或 MF；AV1：SVT-AV1 |
| macOS 后端 | 由 Chromium 决定 | H.264/H.265：VideoToolbox，H.264 可回退 OpenH264；AV1：SVT-AV1 |
| Linux 后端 | 不适用 | NVENC/NVDEC（CUDA）、OpenH264、SVT-AV1 |
| 码率与分辨率控制 | `RTCRtpSender.setParameters`：`maxBitrate`、`maxFramerate`、`scaleResolutionDownTo`，`degradationPreference = maintain-framerate`；档位上限到 3840×2160、30 Mbps | 自有码控：编码器码率调节、帧率节拍、分辨率适配器、丢帧器；Media Foundation 编码缓冲可通过环境变量细调 |
| 关键帧与恢复 | libwebrtc 的 PLI/FIR | 自有 IDR/FIR 恢复预算和恢复时序 |

Perch 拿到的是"浏览器级"的编码能力：省心，但调不了 GOP、编码缓冲和编码器后端。本项目没有暴露 AV1 偏好配置，是否能在当前 Electron 构建中协商 AV1 需要运行时核验。CrossDesk 能针对屏幕内容精细调参，代价是要自己处理各家硬件编码器的兼容问题；仅 Media Foundation 编码缓冲一项，MiniRTC 的 README 就用了一整节来说明。

## 五、网络传输与拥塞控制

| 项目 | Perch | CrossDesk（MiniRTC） |
| --- | --- | --- |
| 带宽估计 | libwebrtc 的 GCC（transport-cc） | 从 WebRTC 移植的同一套模块：`delay_based_bwe`、`trendline_estimator`、`loss_based_bwe_v2`、`probe_controller`、`alr_detector`、`pacing_controller`、拥塞窗口回压 |
| 丢包恢复 | libwebrtc 的 NACK、RTX，以及浏览器自己的 FEC 策略 | NACK、RTX，外加自有 FEC：OpenFEC 与小块 Reed-Solomon，有 `fec_adaptation_controller` 按网络状况调整冗余 |
| 路径选择 | ICE 自动选择；Perch 自己实现了"仅中继 / 优先直连"的会话内切换（重建 PeerConnection，用 `routeId` 去重） | ICE 自动选择；TURN 模式由参数决定；IP 直连模式只允许双方的 host 候选 |
| 断线恢复 | ICE restart，最多 2 次，之后结束会话 | ID 模式支持信令重连和会话恢复；IP 直连不支持会话内 ICE 重启 |
| 统计诊断 | `getStats` 计算码率、RTT、编解码耗时、抖动缓冲，并把被控端数据回传给主控端 | 自有统计模块与网络统计面板 |

两者的拥塞控制算法同源，都是 GCC 家族。区别是 Perch 直接用 Chromium 维护、随版本升级的实现；CrossDesk 是移植后自己维护，好处是可以把 FEC、丢帧、分辨率降级和码控串成一套针对远控的策略。

## 六、键鼠注入

| 项目 | Perch | CrossDesk |
| --- | --- | --- |
| 线上格式 | JSON；坐标归一化到 0–1；带 `sequence`、`epoch`、`after` 屏障字段，保证点击和移动的先后关系 | `libs/wire` 中的结构体：鼠标浮点坐标、按键带 `key_value`、`scan_code`、`extended`；另有 `keyboard_state` 消息同步最多 32 个已按下的键 |
| 通道划分 | 移动走 `motion`（无序、不重传）；按键、点击、滚轮走 `control`（可靠有序） | 移动走不可靠流；点击、滚轮走可靠的 mouse 流；键盘单独一条流 |
| 被控端排序与限流 | 渲染进程 `InputReceiver` 按屏障排序；主进程 `input-flow.cjs` 做令牌桶限流（上限 240，每毫秒回补 0.18） | `RemoteInputDispatcher` 队列：跟踪未释放的按键和按钮，断开时先补发释放，超时的按下或点击不重放 |
| macOS 注入 | N-API 插件，`CGEventPost(kCGHIDEventTap)`，自行维护修饰键、双击计数、拖拽事件 | 同样用 `CGEventPost(kCGHIDEventTap)`，并在事件里写入自有标记，以区分注入事件和真实事件 |
| Windows 注入 | Go 子进程，按扫描码 `SendInput`，`SetPhysicalCursorPos` 定位；通过 stdin 每行一条 JSON，输入行最长 2048 字节 | 同进程 `SendInput`；先绑定当前交互式桌面，不在 `Default` 桌面时拒绝；锁屏、UAC、安全桌面交给系统服务处理；支持发送 SAS（Ctrl+Alt+Del）、锁定工作站 |
| Linux 注入 | 不支持 | X11 用 XTest（特意用 `XTestFakeMotionEvent` 而不是 `XWarpPointer`，以便产生 XInput2 原始事件）；Wayland 用 xdg-desktop-portal RemoteDesktop |
| 光标呈现 | 画面不含光标，主控端用 CSS 显示本机光标；未见光标形状同步 | 有 `CursorState` 消息，同步位置、可见性、形状和偏移 |
| 输入延迟观测 | 有探针回执：被控端在注入后回传 `dispatchMs`，主控端统计往返时间 | 有排队和执行耗时日志，超过 50 ms 时上报 |

两者的注入方式在 macOS 和 Windows 上基本一致，差别主要在边界场景。CrossDesk 覆盖了 Windows 的 UAC 和锁屏、断线时的卡键恢复、远端光标形状，以及 Linux/Wayland。Perch 在输入顺序保证和延迟可观测性上做得更细，但 Windows 输入多了一次跨进程的文本序列化。

## 七、信令、会话授权与安全

| 项目 | Perch | CrossDesk |
| --- | --- | --- |
| 找到对方 | 同账号设备列表，或者一次性邀请链接（10 分钟有效） | 9 位设备 ID，或者局域网 `IP:端口` |
| 授权方式 | 账号直连：同账号设备自动接受控制；口令协助：被控者逐项允许观看和键鼠控制 | 知道 ID 和密码即可连接，由服务端校验密码；IP 直连由被控端本地用 Argon2id 校验 6 位密码；可选"仅允许可信设备"（Ed25519 配对，并签名一次性挑战） |
| 设备身份 | 服务端分配 UUID，没有设备密钥（审查报告 M4） | 每台设备有 Ed25519 私钥，登录时签名挑战，服务端绑定公钥 |
| 信令保密 | 口令模式：信令帧用客户端生成的密钥做 AES-GCM 加密，服务器无法读取 SDP；账号直连：密钥由服务器生成（审查报告 H3） | 信令走 TLS，服务器能看到 SDP；IP 直连不经过服务器 |
| 对服务器的信任 | 账号直连信任服务器；口令模式不信任 | ID 模式下服务器能看到密码校验和 SDP，信任服务器；可信设备机制能挡住"只知道密码"的人，但其签名没有绑定 DTLS，CrossDesk 文档自己也承认无法防御实时中继转发 |
| 媒体加密 | 始终 DTLS-SRTP | 新版双方之间完整加密；**与旧版对端连接时，音频和数据可能是明文**（`NegotiateSrtp` 的兼容分支） |
| 限流 | 按 IP 和全局配额（审查报告 M1、M2、M6） | 按"已验证控制端"和"控制端→目标"两个维度累计失败次数（20 次和 5 次）；IP 直连另有 900 秒冷却 |
| 被控者知情 | 有紧急结束快捷键；账号直连时被控窗口可能隐藏（审查报告 H1） | 有隐私屏（被控端屏幕遮盖）、被控会话面板 |

值得 Perch 借鉴的是 CrossDesk 的**设备密钥**设计：每台设备一把 Ed25519 私钥，登录签名挑战，可信设备名单按公钥匹配。这正好能同时解决 Perch 审查报告里的 H1（设备配对）、H3（服务器生成密钥）和 M4（设备 ID 冒用）。反过来，CrossDesk 的明文兼容分支和"密码交给服务器校验"的模型，安全性不如 Perch 口令模式的端到端加密信令。

## 八、各自的长处与短板

**Perch 的长处**

1. 传输层维护面较小：直接复用 Chromium 的 WebRTC，包括拥塞控制、重传、抖动缓冲和媒体加密，应用层主要维护采集、会话策略和输入。
2. macOS 采集到编码器全程零拷贝。
3. 媒体加密不可降级；口令模式信令端到端加密，服务器无法读取。
4. 输入顺序保证、延迟探针、会话诊断（编码、解码、抖动缓冲分段耗时）比较完整。
5. 支持会话内切换"仅中继 / 优先直连"。

**Perch 的短板**

1. Windows 采集目前依赖 WGC，无法覆盖锁屏、UAC 安全桌面和无显示器等场景。共享纹理与 NT 句柄已采用双槽复用，后续性能优化应以端到端测量为依据。
2. 编码器控制粒度有限：应用可协商 H.264/H.265 偏好并调整发送码率、帧率和分辨率，但不能像 MiniRTC 一样直接选择编码器实现或配置其内部缓冲策略。本项目未暴露 AV1 偏好选项，运行时是否具备 AV1 能力需按 Electron 构建实测。
3. 没有 Linux 被控端，没有移动端和浏览器主控端。
4. 没有无人值守：锁屏或休眠就结束会话。
5. 没有光标形状同步。
6. 安装包体积和内存占用受 Electron 影响。
7. 设备没有密钥身份（审查报告 H1、H3、M4）。

**CrossDesk 的长处**

1. 整条链路自主可控：编码器后端、FEC、码控、帧调度都能针对远控调整。
2. Windows 采集三级回退，GPU 色彩转换，支持安全桌面、虚拟显示器、无头运行，有系统服务做无人值守。
3. 平台覆盖广：Linux（X11、Wayland）、移动端、浏览器、CLI、MCP。
4. 设备有 Ed25519 身份，可选可信设备，IP 直连不依赖服务器。
5. 远端光标形状、按键状态同步、断线卡键恢复都已实现。

**CrossDesk 的短板**

1. 自研 RTC 栈维护量大：移植的 WebRTC 模块需要自己跟进，硬件编码器兼容性要自己兜底。
2. 与旧版对端连接时，音频和数据可能不加密。
3. ID 模式下服务器参与密码校验，能看到 SDP。
4. GPL-3.0 许可证。

## 九、上层功能差异（简表）

| 功能 | Perch | CrossDesk |
| --- | --- | --- |
| 系统声音 | 有（Chromium 回环采集，macOS 14.2+、Windows） | 有（WASAPI、SCK、Linux），Opus 48 kHz |
| 文件传输 | 单文件 100 MiB；原生剪贴板复制文件，每次最多 128 个 | 双栏文件浏览器，支持文件夹，有传输队列 |
| 文本剪贴板 | 手动发送，最多 12000 字符 | 自动同步，最多 128 KiB |
| 多显示器 | 选择一块共享 | 远程切换显示器，远程修改分辨率 |
| 隐私屏 | 无 | 有 |
| 多设备墙 | 无 | DeskHub |
| 会话后锁屏 | 有 | 有（远程锁定工作站） |

## 十、对 Perch 的建议

按投入产出排序：

1. **保留 Chromium WebRTC，不要自研传输栈。** 对目前的团队规模，CrossDesk 那样维护一整套 MiniRTC 的代价太高。Perch 的瓶颈不在传输层，而在采集、注入和身份。
2. **引入设备密钥和配对**，参考 CrossDesk 的 Ed25519 设计，但把签名绑定到本次 DTLS 指纹，避免 CrossDesk 文档承认的中继转发问题。这一项和审查报告的 C1、H1、H3、M4 可以一起修。
3. **评估 Windows 增加 DXGI Desktop Duplication 回退路径**，并在目标系统实测安全桌面、无头与显示器热插拔场景。当前 WGC 路径已复用双槽共享纹理。
4. **加入按键状态同步**：主控端周期性发送当前按下的键，被控端对比后释放多余的键，断线时统一释放。现有的 `reset` 只在会话结束时生效。
5. **同步远端光标形状**，改善"画面不含光标、主控端用本地光标"带来的光标形状不一致问题。
6. **评估 Windows 系统服务**，用于锁屏、UAC 和登录前的远控。这是一个独立的大项目，涉及会话 0 隔离和桌面切换，需要单独立项。
7. **如果需要更低码率，可以评估 Chromium 的 AV1 编码**（libwebrtc 已支持 AV1，可以通过编码器排序优先使用）。是否走硬件取决于 Chromium 版本和 GPU，需要实测。

**关于借用代码：** CrossDesk 是 GPL-3.0，直接复制它的代码到 Perch，Perch 也要以 GPL-3.0 开源。MiniRTC 是 LGPL-3.0，条件宽一些，但 Perch 用的是 Chromium 的 WebRTC，用不上它。建议只参考设计思路，自己实现。具体许可证问题请以法律意见为准。

## 附：本次查看的 CrossDesk 资料

- `README.md`、`docs/connection-architecture.md`、`docs/gui-architecture.md`、`xmake.lua`
- `apps/desktop/src/platform/windows/screen_capturer/`：`capture_backend_policy.h`、`screen_capturer_dxgi.cpp`、`dxgi_nv12_frames.cpp`
- `apps/desktop/src/platform/macos/screen_capturer/screen_capturer_sck_impl.mm`
- `apps/desktop/src/platform/windows/input/windows_input_injector.cpp`、`mouse_controller.cpp`
- `apps/desktop/src/platform/macos/input/mouse/mouse_controller.cpp`
- `apps/desktop/src/platform/linux/input/mouse/mouse_controller.cpp`、`mouse_controller_wayland.cpp`
- `apps/desktop/src/gui/features/input/remote_input_dispatcher.cpp`、`gui/runtime/gui_runtime.cpp`、`gui/runtime/peer_data_callbacks.cpp`
- `libs/wire/include/remote_action.h`、`stream_names.h`
- MiniRTC：`README_ZH.md`、`src/api/minirtc.h`、`src/media/video/encode/video_encoder_factory.cpp`，以及 `src/qos`、`src/fec`、`src/transport` 的文件结构
