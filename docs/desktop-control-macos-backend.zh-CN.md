# CliGate 桌面控制 · macOS 原生后端 设计与进度记录

> 状态:**进行中(Windows 侧已完成,macOS 真机落地待续)**
> 最近更新:2026-06-17
> 适用范围:CliGate「桌面控制 / 控制电脑 / computer-use」能力的跨平台扩展

---

## 1. 背景与文档目的

CliGate 现有的桌面控制能力(Assistant 的 `desktop_*` 工具)只支持 Windows:底层是一个跑在用户桌面会话里的 Python HTTP agent(`src/desktop-agent/runtime/desktop-agent-server-impl.py`),依赖 `uiautomation` / `ctypes.user32` / `mss` / `RapidOCR`,全文件仅有 `os.name == "nt"` 分支,非 Windows 基本是 stub。**macOS 上等于没有桌面控制能力。**

本文记录一次针对 macOS 的扩展:设计目标、需求约束、方案选型、架构、已完成事项、验证情况,以及后续必须在 Mac 上完成的工作。参考过开源项目 cua 的做法,但**不依赖其任何包**,代码与产物均为自研。

---

## 2. 设计目标与需求约束

用户明确提出的硬约束(本方案的基准):

1. **不依赖第三方 computer-use 包**:cua 等只作技术参考,自己实现、出自己的产物。
2. **符合 macOS 技术要求**:用原生 Accessibility / CGEvent / ScreenCaptureKit / Vision,而不是勉强可用的方案。
3. **装完即用**:用户安装软件、开启「桌面控制」开关即可使用,不需要再手动执行任何命令/脚本。
4. **随软件关闭而消失**:关闭 CliGate,控制能力即失效——**不允许常驻守护进程 / launchd / 计划任务**。
5. **不破坏现有功能**:绝不影响 Windows 版的下载、安装、使用,也不影响线上 GitHub 打包流程。
6. **解耦、清晰、独立目录**:新增代码独立成目录,不污染现有结构。

> macOS 系统级、任何控制软件都绕不开的两步,不算「需要额外执行」的违背:
> - 授权「辅助功能 + 屏幕录制」(TCC,一次性);
> - 未做公证时首次打开过一次 Gatekeeper(右键→打开)。

---

## 3. 方案选型

### 3.1 为什么不直接接入 cua / 不注册成 MCP
- 违反「不依赖其包」约束;
- 裸 MCP 接入会绕过 CliGate 已有的 lease 队列、artifact 注册、错误增强、focus 预处理,且 macOS 与 Windows 工具面不一致。

### 3.2 为什么不沿用 Python + PyObjC
- 需捆绑 CPython + PyObjC(几十 MB),违背「装完即用」;
- 后台事件投递、ScreenCaptureKit 等在 Python 里难做好;
- TCC 权限挂在解释器上,易被系统判定变化而重置。

### 3.3 最终选型:**自研原生 Swift helper**
- 一个小型签名二进制,无运行时依赖;
- 原生 AX / CGEvent / ScreenCaptureKit·CGWindowList / Vision OCR;
- 权限挂在**签名固定**的 helper 上,授权可跨版本保留(免费自签名证书即可满足,$99 公证只为免去首次 Gatekeeper 提示,非必需);
- 作为 CliGate 的**子进程**运行,随 app 退出而终止——满足「关闭即失效」。

---

## 4. 架构设计

核心原则:**平台差异完全封死在「本地 agent」边界内**。macOS helper 讲与 Windows Python agent **完全相同的 localhost HTTP 契约**,因此 `http-client.js` 以上(`service.js`、lease、全部 `desktop_*` 工具、Dashboard)**与平台无关、无需改动**。

```
Dashboard (settings-page.js / workspace-config.html)
  → /api/desktop-agent/*  (routes/desktop-agent-route.js)
  → desktop-agent/service.js   (lease 队列 / 区域裁剪 / fillTextField·clickText 编排) ── 不变
  → desktop-agent/http-client.js (统一 HTTP 契约 + Bearer token) ───────────────────── 不变
  → desktop-agent/manager.js → resolveDesktopBackend()  ← 新增的「后端选择」接缝
       ├─ Windows/Linux → python-http 后端 → runtime/desktop-agent-server-impl.py (现有, 不变)
       └─ macOS(darwin) → macos-native 后端 → runtime-macos/cligate-desktop-agent (新, 自研 Swift)
助手工具: definitions/desktop-*.js → handlers/desktop.js → desktop/client.js  ── 不变
```

### 4.1 后端选择层(新增)
- `src/desktop-agent/backends/index.js` — `resolveDesktopBackend({platform, settings, token})`,**仅 darwin 选原生 helper**,其余平台保持原 Python 启动逻辑,命令/参数优先级(显式 `settings` 覆盖 > 平台默认)逐字节不变。
- `src/desktop-agent/backends/python-http.js` — Windows/Linux 默认后端(承接原 `resolveRuntimeScript`)。
- `src/desktop-agent/backends/macos-native.js` — macOS 原生 helper 后端(二进制路径解析,含 asar→asar.unpacked 处理)。

### 4.2 macOS helper 内部的契约映射
helper 实现与 Windows 相同的端点(`/health` `/windows` `/focus` `/launch` `/screenshot` `/ui/find` `/ui/find_all` `/ui/act` `/ui/tree` `/ui/wait` `/move` `/click` `/type` `/press` `/hotkey` `/scroll` `/wait` `/wait_change` `/find_text` `/active` `/cursor_info`),内部映射:

| 契约语义 | macOS 实现 |
|---|---|
| `window_hwnd` | CGWindowID(`kCGWindowNumber`),并附带 owning `pid` |
| `control_type`(Edit/Button/Text/…) | AXRole(AXTextField/AXButton/AXStaticText/…)双向映射 |
| `/ui/act` set_value / click / get_text / focus / send_keys | 写 `AXValue` / `AXPress` / 读 `AXValue·AXTitle` / `AXFocused` / CGEvent |
| `/screenshot` | `CGWindowListCreateImage` / `CGDisplayCreateImage` → PNG(+ 预览缩放) |
| `/find_text` | Vision `VNRecognizeTextRequest`,返回 screen 坐标的 bbox/center/confidence |
| 鼠标/键盘 | CGEvent(前台路径;后台 SkyLight 投递为后续阶段) |
| `/health` 诊断字段 | 额外返回 `accessibility` / `screen_recording`(TCC 状态) |

---

## 5. 已完成事项(本轮交付,均在 Windows 上验证,零 Windows/打包影响)

### 5.1 后端解耦层(新增)
- `src/desktop-agent/backends/index.js`、`python-http.js`、`macos-native.js`
- `src/desktop-agent/manager.js`:改用 `resolveDesktopBackend()`;在 start() 顶部即记录 `backendId`(即便复用外部 agent 也能在 status 中报告后端);保留 `DEFAULT_SCRIPT` / `resolveRuntimeScript` 向后兼容导出。

### 5.2 路由 / 状态(改)
- `src/routes/desktop-agent-route.js`:`buildDesktopControlStatus()` 改为可注入依赖(便于在 Windows 上单测 darwin 分支),新增 `platform` 字段;darwin 下 `supported=true`,并**最佳努力**通过 helper `/health` 读取 `permissions:{accessibility, screenRecording}`(Windows 分支永不探测、形状不变)。

### 5.3 Assistant 错误引导(改)
- `src/assistant-tools/handlers/desktop.js`:新增 `ACCESSIBILITY_DENIED` / `SCREEN_RECORDING_DENIED` 的 LLM 恢复引导(指向系统设置授权,而非「重启 agent」)。

### 5.4 前端(改,严格 mac 门控)
- `public/partials/views/workspace-config.html`:新增 macOS 权限提示块,**仅 `desktopControl.platform === 'darwin'` 且权限缺失时渲染**,Windows 视图完全不变。
- `public/js/modules/settings-page.js`:`desktopControl` 状态新增 `platform` / `permissions`,`loadDesktopControlStatus` 透传。
- `public/js/i18n.js`:新增 `desktopControlMacPermHint` / `desktopControlMacPermAccessibility` / `desktopControlMacPermScreenRecording`(中英文)。

### 5.5 macOS 原生 helper 脚手架(新增,独立目录 `native/macos-desktop-agent/`)
- `Package.swift`、`build.sh`(构建+自签名+拷贝到 `src/desktop-agent/runtime-macos/`)、`README.md`、`.gitignore`
- `Sources/cligate-desktop-agent/`:`main.swift`、`HTTPServer.swift`、`Server.swift`、`Json.swift`、`Keymap.swift`、`Permissions.swift`、`Health.swift`、`WindowsService.swift`、`InputService.swift`、`CaptureService.swift`、`OCRService.swift`、`Accessibility.swift`
- `src/desktop-agent/runtime-macos/README.md`(二进制部署目标说明)

### 5.6 打包链路准备(改,已验证不破坏)
- `package.json`:`asarUnpack` 增加 `src/desktop-agent/runtime-macos/**/*`(electron 打包时会解包该目录;目前仅 README,不报错)。
- `native/` 不在 npm `files` 也不在 electron `build.files`——**不会进 npm 包、不会进 app 包、不进 CI**。

### 5.7 测试
- 新增 `tests/unit/desktop-agent-backends.test.js`(平台选择/覆盖/端口全矩阵)。
- 扩充 `tests/unit/desktop-agent.test.js`(manager backend id、darwin 路由、macOS TCC 错误引导、权限状态surfacing)。
- **desktop + backends:40/40 通过。** 改动模块均可正常 import;`<template>` 标签平衡;前端 JS 语法检查通过。

---

## 6. 验证情况:为什么「不影响 Windows / 不影响打包」

- **CI(`.github/workflows/build-desktop.yml`)**:三腿 win/mac/linux 各自 `electron-builder --<platform>`;**无任何 Swift 构建步骤**;`native/` 不在 `build.files`,Swift 源码不进 CI、不进 app。三腿照常出 `.exe/.dmg/.AppImage`。
- **npm 发布(`release:check` / `scripts/release-check.js`)**:逐条核对——name/version 与 lock 同步、`files` 含 `bin`+`src`、`npm pack --dry-run` 含 `bin/cli.js`+`README.md`——均通过;`native/` 不在 `files`,不进 npm 包。
- **Windows 运行时**:`selectDesktopBackend` 只有 darwin 选原生 helper;Windows 永远走 python-http,启动命令/参数逐字节不变(已单测固化)。macOS 后端代码在 Windows 上从不被选中、从不 spawn。
- **唯一刻意未动**:CI 的 mac 腿未加 Swift 构建步骤(无法本地验证 + 矩阵 `fail-fast` 风险),留到 Mac 验证通过后再加,并将设为 `continue-on-error`。

---

## 7. 当前状态:直接打包后 Mac 上能用吗?

| 部分 | Mac 上 |
|---|---|
| CliGate 主体(网关/Dashboard/代理/账号池) | ✅ 能(本就跨平台,mac `.dmg` 一直能构建,改动未破坏) |
| **桌面控制** | ❌ **不能** |

**根因:原生 helper 二进制尚未构建、未进安装包。** `native/` 里只有 Swift 源码;`src/desktop-agent/runtime-macos/` 目前只有 README,没有二进制。Mac 用户开启开关时会 spawn 不存在的 `cligate-desktop-agent`,启动失败。

---

## 8. 后续待操作(让「打包→下载→Mac 可用」成立)

### A. 必须在 Mac 上做(无法在 Windows 验证/代劳)
1. **编译 helper**:`cd native/macos-desktop-agent && swift build -c release`。**首次编译预计要修一批错误**(availability 标注、可选解包、个别 API 签名)——本 Swift 在 Windows 上盲写,未经编译。把编译错误反馈即可逐个修。
2. **签名**:`codesign --force --options runtime --sign "<证书>" <bin>`(免费自签名即可,保证 TCC 不掉);`build.sh` 已留 `CLIGATE_CODESIGN_IDENTITY` 钩子。
3. **放到位**:`build.sh` 自动把签好的二进制拷到 `src/desktop-agent/runtime-macos/cligate-desktop-agent`(打包侧已就绪:`asarUnpack` + 路径解析)。
4. **真机功能验证**:开启控制 → 授权辅助功能/屏幕录制 → 跑通 找控件/点击/输入/截图/OCR,修实际的 AX/CGEvent/坐标 bug。**这一步决定可用性,无 Mac 无法进行。**

### B. 打包 / CI(等 A 验证通过后)
5. CI macos-latest 腿在 `electron-builder` 前加「`swift build` + 签名」步骤,设 `continue-on-error: true`(防止波及 win 腿);或本地 `build.sh` + `electron-builder --mac` 出 dmg。
6. (可选)Electron app 本身用稳定证书签名,使权限在 app 更新后仍保留;有预算可上 $99 公证免去首次 Gatekeeper 提示。

### C. macOS 用户安装后的固有步骤(系统规矩,非缺口)
7. 授权「辅助功能 + 屏幕录制」(Dashboard 已做引导提示)。
8. 未公证时首次「右键 → 打开」过 Gatekeeper(建议在 README 注明 `xattr -dr com.apple.quarantine /Applications/CliGate.app`)。

### D. 功能增强(后续阶段,需 Mac)
9. 后台免抢焦点投递(SkyLight `SLEventPostToPid`)、focus-without-raise。
10. `/ui/tree` 的 inspect-window 标注叠加(set-of-mark)。
11. 截图迁移到 ScreenCaptureKit(macOS 14+);`/wait_change` 信号细化;`/ui/wait` 完善。

---

## 9. 关键文件索引

**Node(新增/改)**
- `src/desktop-agent/backends/{index,python-http,macos-native}.js`
- `src/desktop-agent/manager.js`、`src/routes/desktop-agent-route.js`
- `src/assistant-tools/handlers/desktop.js`
- `src/desktop-agent/runtime-macos/README.md`

**前端(改)**
- `public/partials/views/workspace-config.html`、`public/js/modules/settings-page.js`、`public/js/i18n.js`

**macOS helper(新增,独立目录)**
- `native/macos-desktop-agent/`(`Package.swift`、`build.sh`、`README.md`、`Sources/cligate-desktop-agent/*.swift`)

**测试**
- `tests/unit/desktop-agent-backends.test.js`、`tests/unit/desktop-agent.test.js`

**打包**
- `package.json`(`build.asarUnpack` 增加 runtime-macos)

---

## 10. 风险与注意事项
- **Swift 未经编译**:首次 bring-up 必然要改;结构/契约/各模块逻辑是已交付物,不等于可编译产物。
- **SkyLight 私有 SPI**:后台投递阶段会用到,有系统升级兼容性风险,已规划 CCGEvent 兜底。
- **TCC 权限稳定性**:依赖「签名固定」;切勿用 ad-hoc 签名(每次构建权限会重置)。
- **不要往 CI mac 腿贸然加未验证的 Swift 步骤**:矩阵默认 `fail-fast`,失败会波及 Windows 腿。
- 本轮改动目前仍在工作区(未提交),可先 review 再决定如何合并。
