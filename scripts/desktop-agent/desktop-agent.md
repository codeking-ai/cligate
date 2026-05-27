# Desktop Agent — 让 AI 自主操作桌面的本地服务

> 一个跑在用户桌面会话里的本地 HTTP 服务，通过 **Windows UI Automation (UIA) + 视觉双路径**，让任意语言的 AI agent（Claude Code / Codex / 自研 Node 程序）以语义级精度操控桌面应用 —— 启动程序、点击按钮、读输入框、读回复，全部走 OS 原生 a11y 接口，**不依赖截图猜坐标**。

---

## 目录

1. [问题背景](#1-问题背景)
2. [现行方案 (v0.2)](#2-现行方案-v02)
3. [原理：为什么 UIA 比视觉稳](#3-原理为什么-uia-比视觉稳)
4. [实测数据](#4-实测数据)
5. [后续优化路线](#5-后续优化路线)
6. [Node 项目如何集成](#6-node-项目如何集成)
7. [跨平台扩展（Mac / Linux）](#7-跨平台扩展mac--linux)
8. [参考资料](#8-参考资料)

---

## 1. 问题背景

要让 AI agent "像人一样操作电脑"（打开软件、点按钮、输入信息），传统做法是给模型加视觉能力 —— 截屏 → 模型估坐标 → 鼠键模拟。问题：

- 模型从压缩预览图估坐标，**误差 30-50 px**，点小按钮经常失败
- 全局键鼠事件**怕焦点抢占**（终端弹窗、Windows 设置、通知）
- 每一步要"截图 → 加载图片到 context → 推理 → 动作 → 再截图"，**单步闭环 5-15 秒**
- Claude Code / Codex 这类 CLI agent **不是为 see-act 高频闭环设计**，工具调用开销大

实测一个"打开通义 + 提问 + 读回复"流程，**纯视觉路径耗时 1.5-2 分钟**。

---

## 2. 现行方案 (v0.2)

### 架构

```
┌──────────────────────────────────────────────────────┐
│  用户的桌面会话 (interactive desktop session)        │
│                                                       │
│   ┌──────────────────────────────────────────┐        │
│   │ Python HTTP Server  (127.0.0.1:8765)     │        │
│   │  desktop-agent-server.py                 │        │
│   │                                          │        │
│   │  ┌──────────────┐  ┌─────────────────┐   │        │
│   │  │  视觉路径    │  │  UIA 路径       │   │        │
│   │  │              │  │                 │   │        │
│   │  │ mss/PIL 截图 │  │ uiautomation    │   │        │
│   │  │ Win32 键鼠   │  │ (COM/IUIAutom.) │   │        │
│   │  │ 像素坐标点击 │  │ 控件树/Pattern  │   │        │
│   │  └──────────────┘  └─────────────────┘   │        │
│   │                                          │        │
│   │  HTTP API:                               │        │
│   │   /screenshot /click /type /press ...    │        │
│   │   /launch /focus /windows /active        │        │
│   │   /ui/find /ui/act /ui/tree              │        │
│   └──────────────────────────────────────────┘        │
│                  ▲                                    │
└──────────────────┼────────────────────────────────────┘
                   │ HTTP (任意语言)
   ┌───────────────┴───────────────┐
   │  Claude Code / Codex / curl  │
   │  PowerShell 客户端           │
   │  Node 业务程序                │
   │  自定义 Agent                 │
   └───────────────────────────────┘
```

**部署模型**：用户登录后在桌面会话里手动启动 `python desktop-agent-server.py`，服务监听 localhost:8765。任何调用方通过 HTTP 操作，**实际键鼠事件发生在用户的可见桌面**。这绕过了 SSH/服务账号"没有交互式会话"的限制。

### 端点一览

| 端点 | 方法 | 用途 |
|---|---|---|
| `/health` `/active` `/windows` | GET | 屏幕信息、当前焦点窗口、窗口列表 |
| `/screenshot` | POST | 全屏或 `region` 区域截图，可 `inline` 返 base64，永远附 `active_window` |
| `/move` `/click` `/scroll` | POST | 鼠标动作（支持 `screen`/`normalized`/`preview`/`region` 坐标系） |
| `/type` `/press` `/hotkey` | POST | 键盘动作（`/type` 默认保留剪贴板） |
| `/launch` | POST | 启动应用（`path` 直拉 .lnk/.exe 或 `query` 走 Win 搜索） |
| `/focus` | POST | 激活窗口（带 AttachThreadInput workaround） |
| `/ui/find` | POST | UIA 查控件，返回 bbox + 状态 |
| `/ui/act` | POST | UIA 执行动作：`click` / `set_value` / `append` / `get_value` / `get_text` / `focus` / `send_keys` |
| `/ui/tree` | POST | dump 窗口控件树（带 `max_depth` / `max_nodes`） |

### 一次端到端的典型调用序列（伪代码）

```
hwnd = POST /windows {title: "通义"} ─→ 拿 hwnd
POST /focus {hwnd}
POST /ui/find {window_hwnd: hwnd, control_type: "Edit"} ─→ 拿输入框 bbox
POST /ui/act  {window_hwnd: hwnd, control_type: "Edit",
               act: "set_value", text: "今天是什么日子"}
POST /ui/act  {window_hwnd: hwnd, control_type: "Edit",
               act: "send_keys", keys: "{Enter}"}
sleep N
POST /ui/tree {window_hwnd: hwnd, max_depth: 30}  ─→ 过滤 TextControl 读回复
```

**0 截图、0 像素估算、0 鼠标移动**，纯语义操作。

---

## 3. 原理：为什么 UIA 比视觉稳

### 视觉路径 = 从像素反推语义

```
应用画 UI → 像素 → 模型看图 → 猜"这是按钮" → 估坐标 → 鼠标走过去点
              ↑↑↑                ↑↑↑           ↑↑↑       ↑↑↑
            压缩失真           语义识别     坐标误差   焦点抢占
```

每一环都可能错，且这些错误**会叠加**。

### UIA 路径 = 直接读 OS 语义层

操作系统为了支持视障人士（屏幕阅读器、放大镜），**强制要求每个 UI 框架在渲染界面时同步向 OS 报告界面的语义结构**：

```
应用画 UI ──→ 像素送到屏幕
          ↘ 同步报告无障碍树到 OS
             ├─ 屏幕阅读器读      (视障辅助 — 法规要求)
             └─ 自动化工具读      (我们在用的)
```

这棵树有：
- **ControlType**：Button / Edit / Window / TabItem / ListItem / ...
- **Name**：a11y 名称（开发者给的或从内容自动提取）
- **AutomationId**：开发者起的稳定 ID
- **BoundingRectangle**：开发者/渲染层给的**像素真值**
- **Pattern**：可调用的动作 —— `InvokePattern.Invoke()` = 点击，`ValuePattern.SetValue(text)` = 设输入值，`TogglePattern` = 开关

### 稳定性来源对比

| 维度 | 视觉路径 | UIA 路径 |
|---|---|---|
| 坐标 | 模型估，±30-50 px | 渲染层真值，像素精确 |
| 操作触发 | 全局键盘鼠标事件（OS 级） | COM/IPC 调控件方法（应用进程级） |
| 被窗口遮挡 | 失败（鼠标点到上面那个窗口） | 不影响（不走鼠标） |
| 焦点被抢 | 失败（键盘事件被别的窗口吃掉） | 不影响（SetValue 直接改输入框值） |
| UI 改版/动画中 | 坐标变就失败 | 按 Name / AutomationId 找仍命中 |
| 语义读取 | 模型读图（错率不可控） | 直接读 Name / Value 字段 |
| 法律保证 | 无 | ADA（美）/ EAA（欧）强制主流应用支持 a11y |
| 触发耗时 | 秒级（含模型推理 + 加载图） | 毫秒级（COM 调用） |

### UIA 不能用、必须视觉的场景

- 自绘 UI **不暴露 a11y**：部分游戏、Steam 老界面、部分自定义 Qt、远程桌面里的内容
- **Canvas/WebGL 内容**：Figma、在线表格、网页游戏
- 全屏 **DirectX / OpenGL**
- 图像内容理解："这张图里有几个人"、验证码

**生产实践 = UIA-first, 视觉 fallback**。本项目两条路径都暴露成 HTTP API，调用方按需混用。

---

## 4. 实测数据

### 案例 A：冷启动通义 APP + 问"今天是什么日子" + 读回复

| 步骤 | 视觉版 (v0.1) | UIA 版 (v0.2) |
|---|---|---|
| 找/启动通义 | 视觉找桌面图标 + 双击，含 PIL 裁剪 + 紫色像素重心定位 | `/launch path=...lnk` 直拉 |
| 定位输入框 | 截图 + 裁剪 + 估坐标 | `/ui/find control_type=Edit` 162ms |
| 写入文本 | 点击 + Ctrl+V | `/ui/act set_value` 742ms（ValuePattern） |
| 触发发送 | press Enter（怕焦点抢占） | `/ui/act send_keys` 809ms（先 SetFocus 到控件） |
| 读回复 | 截图 + 模型读图 + 重试 | `/ui/tree` + 过滤 TextControl 577ms |
| **核心 API 合计** | — | **~3 s** |
| **总流程**（含启动 8s + 模型生成 7s） | **1.5-2 分钟** | **~18 s** |

### 案例 B：Chrome 已开 → 新标签打开 www.qq.com

| 步骤 | 耗时 |
|---|---|
| `/focus Chrome` | 269 ms |
| `/hotkey ctrl+t` 新标签 | 212 ms |
| `/ui/find` 地址栏（Name="Address and search bar"） | 162 ms |
| `/ui/act set_value www.qq.com` | 652 ms |
| `/ui/act send_keys {Enter}` | 714 ms |
| 等页面加载 | 4 s |
| **总流程** | **~6.5 s** |

Chrome 是标准 `WindowControl`，地址栏 a11y Name 固定为 `Address and search bar`（不分系统语言），开箱即用。

---

## 5. 后续优化路线

### 短期（小范围 API 完善）

- **`/ui/find_all`** — 一次返回所有匹配控件（避免 `/ui/tree` 拉全树的开销）
- **`/ui/wait`** — 等控件出现 / Name 变化 / Value 变化，替代固定 `sleep`
- **`/screenshot` region 客户端 wrapper** — 屏蔽 PIL 裁剪步骤
- **点前校验** — `WindowFromPoint(x, y)` 验证目标窗口类名/标题，防止焦点抢占下点错
- **`_find_control` 边界**：name 为空 + control_type 给定时的语义已修复，其他组合再补一轮测试
- **`/type` 强制 SendInput** — 提供选项不走 Ctrl+V 路径，避免某些场景剪贴板被 IME 占用

### 中期（能力扩展）

- **OCR 端点** —— PaddleOCR / Tesseract，返回 `[{text, bbox, conf}]`，自绘 UI 兜底
- **批量动作 `/batch`** — 一次提交多个动作，减少 HTTP 往返
- **事件订阅** —— WebSocket 推送控件出现/消失/变值，业务侧不再轮询
- **手势 / 拖拽** —— `drag_drop` 端点 + UIA `DragPattern`
- **快捷输入法管理** —— 确保 ASCII / 中文输入模式正确

### 长期（架构层）

- **跨平台 server** —— macOS (`atomac` / pyobjc) / Linux (`pyatspi`)，HTTP API 协议不变
- **多屏 / DPI** —— `EnumDisplayMonitors` 处理虚拟屏，DPI per-monitor
- **UAC 提权窗口** —— 当前普通进程读不到提权进程的控件树，需 manifest 标记或服务端提权
- **安全 token** —— 当前 localhost 服务对同机任意进程开放，加一次性 token 限制访问

---

## 6. Node 项目如何集成

下面四种方案按推荐度排序。

### 方案 A：Node 直接 HTTP 调用本机 server（推荐，零额外依赖）

**适用**：Node 业务程序需要操作桌面 UI，Python server 已在跑（用户启动）或 Node 帮忙起。

**优点**：
- Node 端不依赖任何原生模块
- 跨平台靠 server 端解决，Node 代码零改动
- 调试方便，HTTP 可见

**示例**：一个轻量 client class

```ts
// desktop-agent.ts
type Spec = Record<string, unknown>;

export class DesktopAgent {
  constructor(private base = "http://127.0.0.1:8765") {}

  private async call<T = any>(path: string, body?: Spec, method: "GET" | "POST" = "POST"): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`${path} failed: ${data.error || res.status}`);
    return data;
  }

  health()                            { return this.call("/health", undefined, "GET"); }
  windows(title?: string, match = "contains") {
    return title ? this.call("/windows", { title, match })
                 : this.call("/windows", undefined, "GET");
  }
  launch(path: string)                { return this.call("/launch", { path }); }
  focus(hwnd: number)                 { return this.call("/focus", { hwnd }); }
  press(key: string)                  { return this.call("/press", { key }); }
  hotkey(keys: string[])              { return this.call("/hotkey", { keys }); }
  type(text: string)                  { return this.call("/type", { text }); }

  uiFind(spec: Spec)                  { return this.call("/ui/find", spec); }
  uiAct(spec: Spec)                   { return this.call("/ui/act", spec); }
  uiTree(spec: Spec)                  { return this.call("/ui/tree", spec); }

  sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}

// 业务：打开通义、问问题、读回复
async function askTongyi(question: string) {
  const a = new DesktopAgent();
  await a.launch(String.raw`C:\Users\liuting\Desktop\通义.lnk`);
  await a.sleep(8000);

  const wins = await a.windows("通义");
  const hwnd = wins.windows[0].hwnd;
  await a.focus(hwnd);

  const spec = { window_hwnd: hwnd, control_type: "Edit", timeout_ms: 4000 };
  await a.uiAct({ ...spec, act: "set_value", text: question });
  await a.uiAct({ ...spec, act: "send_keys", keys: "{Enter}" });

  await a.sleep(7000);

  const tree = await a.uiTree({ window_hwnd: hwnd, max_depth: 30, max_nodes: 600 });
  return collectText(tree.tree);
}

function collectText(node: any, out: string[] = []): string[] {
  if (!node) return out;
  const name = (node.name || "").trim();
  if (node.control_type === "TextControl" && name.length > 3) out.push(name);
  for (const c of node.children || []) collectText(c, out);
  return out;
}
```

**注意点**：
- `fetch` 是 Node 18+ 原生，老版本用 `node-fetch` / `axios`
- 中文路径在 JSON body 里没问题（UTF-8），但**别在 shell 命令拼装 JSON**（双层转义会爆炸）
- Server 健康检查：启动 Node 程序时先 `health()` 一下，失败就 spawn server（见方案 B）

### 方案 B：Node 启动 Python server 作子进程

**适用**：希望 Node 程序"开箱即用"，不让用户手动起 server。

```ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

async function ensureServer() {
  try {
    const res = await fetch("http://127.0.0.1:8765/health");
    if (res.ok) return null;
  } catch {/* not running */}

  const child = spawn("python", [
    "desktop-agent-server.py", "--port", "8765"
  ], {
    detached: false,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: false,   // 让 server 跑在交互式桌面
  });

  // 等服务起来
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { if ((await fetch("http://127.0.0.1:8765/health")).ok) return child; } catch {}
  }
  throw new Error("desktop-agent server failed to start");
}

process.on("exit", () => { /* server 会随 detached:false 进程一起退出 */ });
```

**注意点**：
- 你的 Node 进程必须**本身就跑在用户的桌面会话里**（Electron app、用户终端、登录脚本）。**不能在 Windows 服务/SSH 里跑** —— Win32 服务没有交互式桌面，键鼠事件会失败
- `detached: false` 让 server 跟着 Node 退出（如果想跨进程复用 server，设 `detached: true`）

### 方案 C：纯 Node 实现 UIA（不推荐）

直接在 Node 里调 Windows COM 接口，绕开 Python。技术路径：

- **`koffi`** / **`node-ffi-napi`** + 自己包装 `UIAutomationCore.dll` 的 COM 接口
- **`edge-js`** —— Node 调 .NET，再用 `System.Windows.Automation`（.NET 自带的 UIA 高层封装）
- **`winax`** —— OLE/COM 自动化绑定

**问题**：
- **没有成熟的 Node UIA 高层封装**（不像 Python 有 `uiautomation` / `pywinauto`）
- COM 接口在 Node 里手写很繁琐，类型/线程模型容易踩坑
- 平台锁定 Windows，跨平台收益没了

**结论**：除非你有强烈的"运行时不能依赖 Python"约束，否则不值得。

### 方案 D：Node 视觉自动化（NUT.js / RobotJS）

完全跳过 UIA，纯视觉路径：

- **NUT.js** —— 现代 TypeScript，跨平台，含图像匹配
- **RobotJS** —— 老牌 Node 鼠键截图

**适用**：
- 操作的应用**不暴露 a11y**（部分游戏、Canvas 内容、远程桌面里的应用）
- 业务不需要语义级精度

**不适用**：
- 大部分 Electron / WPF / WinForms / 浏览器应用（用 UIA 都能稳过）
- 需要稳定生产级的 UI 自动化

### 推荐路径

```
              ┌─── 大多数桌面应用      → 方案 A / B (本项目)
              │
你的场景 ─────┼─── 自绘 UI / 游戏      → 方案 D (NUT.js)
              │
              ├─── Web 内的 Canvas    → Playwright (走浏览器)
              │
              └─── 纯 Node 重度约束   → 方案 C (手写 COM)
```

实际工程中通常是 **方案 A 为主 + 方案 D 兜底**，混着用。

---

## 7. 跨平台扩展（Mac / Linux）

三大 OS 都有对应的 a11y 标准，**思想完全一样**：枚举控件树 → 按 Name/Role 找 → 调 Pattern 方法。

| | Windows | macOS | Linux |
|---|---|---|---|
| 标准 | **UI Automation (UIA)** | **NSAccessibility** | **AT-SPI** |
| 底层 | COM `IUIAutomation` | Objective-C `AXUIElement` | D-Bus |
| Python 库 | `uiautomation` ★ / `pywinauto` | `atomac` / `pyobjc` 直接调 | `pyatspi2` |
| 调试器 | Inspect.exe / Accessibility Insights | Xcode 自带 **Accessibility Inspector** | **Accerciser** |
| 标准化程度 | 强 | **最强**（苹果严格审核） | 弱（社区） |
| 主流应用覆盖率 | 90%+ | **95%+** | 50-70% |
| 权限模型 | 默认开放 | 需在 *系统设置 → 隐私与安全性 → 辅助功能* 授权每个程序 | 默认开放 |

**移植本项目到 Mac 的方式**：
- HTTP API 协议**完全不变**（端点名、字段名、行为）
- Server 端用 `atomac` 替换 `uiautomation`：
  - `auto.ControlFromHandle(hwnd)` → `atomac.getAppRefByPid(pid)`
  - `EditControl(Name=...)` → `app.AXTextField[name]`
  - `GetValuePattern().SetValue(...)` → `field.AXValue = "..."`
- 启动应用：`os.startfile` → `subprocess.run(["open", "-a", "通义"])`
- 客户端代码（Node、PowerShell、Codex 等）**零改动**

---

## 8. 参考资料

### 标准与官方文档
- [Microsoft UI Automation Overview](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32)
- [Apple Accessibility Programming Guide for OS X](https://developer.apple.com/library/archive/documentation/Accessibility/Conceptual/AccessibilityMacOSX/)
- [AT-SPI (Linux Accessibility)](https://gitlab.gnome.org/GNOME/at-spi2-core)

### 库
- Python: [`uiautomation`](https://github.com/yinkaisheng/Python-UIAutomation-for-Windows) ★ / [`pywinauto`](https://pywinauto.readthedocs.io/) / [`atomac`](https://github.com/pyatom/pyatom)
- Node: [`nut.js`](https://nutjs.dev/) / [`robotjs`](http://robotjs.io/) / [`koffi`](https://koffi.dev/)
- 浏览器: [Playwright](https://playwright.dev/)
- 模型原生: [Anthropic Computer Use](https://docs.anthropic.com/en/docs/build-with-claude/computer-use) / OpenAI `computer-use-preview`

### 调试工具
- Windows: **Accessibility Insights for Windows**（开源，强烈推荐）
- macOS: **Accessibility Inspector**（Xcode 自带）
- Linux: **Accerciser**

---

## 一句话总结

UIA 这套之所以稳，是因为**操作系统已经为视障辅助强制每个应用暴露语义层**，我们只是搭便车去读这棵真值树，绕过了"渲染→像素→反推语义"的整段误差链。三平台都有对应标准，**Python 生态最完整**。把它包成本地 HTTP server 后，**客户端语言完全自由** —— Node、PowerShell、Codex、Claude Code、curl 都行 —— 这就是本项目的核心架构选择。
