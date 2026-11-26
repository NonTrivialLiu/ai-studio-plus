# AI Studio Plus 架构

## 运行结构

```text
AI Studio 页面（MAIN）
  └─ interceptor.js：监听请求、解析列表、分页和会话操作
          ↕ window.postMessage（同窗口、同源、频道过滤）
扩展内容脚本（ISOLATED）
  ├─ history-store.js：会话、分页、搜索、分组与 sessionStorage 缓存
  ├─ sidebar-shared.js / sidebar-edit.js / sidebar-selection.js / sidebar-menu.js / sidebar.js：
  │    导航挂载、历史流、原位重命名、多选与批量删除、三点菜单与抽屉
  ├─ sidebar-space.js：窄屏判断、左右栏互斥可用宽度与指针命中辅助
  ├─ nav-collapse.js：原生导航悬浮预览、固定与快捷键
  ├─ run-settings-peek.js：运行设置栏的悬浮预览与固定
  ├─ bubbles.js：用户消息折叠与虚拟占位处理
  └─ main.js：模块启动与主世界脚本注入兜底
```

`extension/src/protocol.js` 定义通信频道、消息类型及共享校验/IME 辅助；`prompts-parser.js` 解析列表与完整会话对象。`extension/styles/` 包含 `bubbles.css`、`sidebar.css`、`nav-collapse.css`、`run-settings-peek.css` 和 `performance.css`（共用的深浅色 `--aip-*` token 定义在 `sidebar.css` 的 `body` 上）。脚本全部通过 DOM API 构建节点，以适配站点的 Trusted Types 限制。

## 历史数据流

主世界拦截页面发出的 `ListPrompts` 请求，从响应中提取会话标识、标题、更新时间及分页状态；扩展世界按更新时间排序、按本地日历日分组，并在侧栏增量渲染。触底或搜索需要更多历史时，主世界复用页面请求上下文（包含 Drive `folder` 与凭据）请求下一页。首页与已有状态对账；游标仅保留在内存。缓存最多保存 1000 条会话的必要字段，使用 `sessionStorage`。

页面自身正在连续翻页时，扩展等待页面数据，以减少重复请求。站点导航或数据结构变化可能使列表不可用，需要重新核对接口和 DOM。

## 行级操作

侧栏处理单击导航、双击 / F2 编辑、菜单和确认界面。改名、复制与删除通过消息交给主世界；主世界使用页面请求上下文调用对应的 Google 接口。改名和复制先获取完整会话对象，再构造更新或创建请求，以保留其他字段。分享进入 History，按会话 ID 找到对应行并调用其原生 Share，打开 Google Drive 分享界面。

多选状态按会话 ID 保存，与当前打开的会话及搜索过滤分开。侧栏在长按达到阈值时进入多选，并在本次指针释放后拦截对应点击；批量删除逐项复用现有删除请求，按结果更新选择及列表。超时的结果标记为不确定并阻止直接重复提交，需刷新或取消勾选后继续。

## 导航展开

`nav-collapse.js` 监听原生导航的折叠状态。悬浮预览使用覆盖层，固定展开交给原生按钮；会话编辑、多选、长按和菜单操作期间保持预览。快捷键避开输入控件，并在业务操作期间暂停切换。

`run-settings-peek.js` 管理右侧 Run settings 的临时预览。原生面板关闭时会卸载，预览通过原生开关创建面板；固定后交还原生布局和关闭按钮。

共享协议消息包括 `prompts:page`、`prompts:error`、`prompts:invalidated`、`route:changed`、`action:result`、`hello`、`prompts:request` 和 `action:request`；实现和字段以 `extension/src/protocol.js` 为准。消息通过 `window.postMessage` 传递，接收端检查来源窗口、同源和频道。

## 构建、门禁与调试

`npm run build` 按 `scripts/build.mjs` 中的 `BUNDLES` 顺序将模块拼接为扩展根目录的 `content.js`、`interceptor.js` 和 `content.css`；这三个文件是生成物。`npm run lint` 运行零依赖静态与架构检查（语法、Trusted Types、产物一致性、模块体积与命名空间、版本同步、CSS 变量）；`.githooks/pre-commit` 在提交前自动执行 `lint` 与单元测试。

单元测试位于 `tests/unit/`，真实扩展集成与交互测试位于 `tests/browser/`，`tests/check.html` 用于气泡回归，`tests/inspect.js` 用于真实页面只读诊断。真机调试通过 `scripts/dev-chrome.mjs`（Chrome for Testing + CDP）和 `scripts/debug-cdp.mjs`（复用 `scripts/chromium.mjs`）完成。

Manifest V3 同时声明 MAIN 和 ISOLATED 世界脚本；`main.js` 另有主世界注入兜底。浏览器支持程度、站点安全策略及真实扩展运行情况应分别实测，不以声明或兜底路径保证所有版本可用。
