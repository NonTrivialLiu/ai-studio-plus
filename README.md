# AI Studio Plus

Google AI Studio 浏览器扩展：在原生导航中提供会话历史、搜索与行级操作，并为用户消息添加气泡折叠和页面渲染优化。

## 功能

- 按最后更新时间分组显示会话，支持搜索、滚动加载和站内切换。
- 单击会话切换，双击或按 F2 原位改名；行尾菜单提供 Rename、Share、Make a copy 和 Delete。删除前显示确认。
- 长按会话约 500 毫秒或点击历史列表标题旁的 Select 进入多选；勾选后可批量移入回收站。选择栏显示数量、退出和 Delete，搜索不会清除已选项。
- Build / Manage 收在历史列表下方的抽屉中；侧栏使用站点的图标和主题色，适配明暗主题。
- 原生导航折叠后，可将鼠标移到展开按钮上临时预览；点击图钉固定展开。`⌘B` / `Ctrl+B` 切换导航，输入和会话操作期间不拦截。
- Run settings 折叠时可悬浮预览并固定；预览期间保留输入与关联菜单操作。
- 用户消息靠右显示为气泡，长消息可展开或收起；离屏正文卸载时保留站点的虚拟占位。
- 移除毛玻璃和部分持续动画，为受影响的界面提供背景。具体性能收益取决于设备和页面。

## 安装与构建

需要 Node.js 22 或更高版本。修改 `extension/src/` 或 `extension/styles/` 后运行：

```sh
npm run build
```

Chrome：打开扩展管理页，启用开发者模式，加载未打包的 `extension/` 目录；已有扩展时重新加载后刷新 AI Studio。

Edge 等 Chromium 浏览器可使用同一扩展目录。Firefox 128 起支持所需的主世界脚本；Firefox 的安装和站点行为尚未实测，商店发布还需按 Mozilla 要求补充签名和数据声明。

`npm run package` 生成 `build/AI-Studio-Plus-WebExtension.zip`。

推送到 `main` 或提交 PR 会运行构建和测试；推送 `v` 开头的标签会在检查通过后创建 GitHub Release 并附上扩展包。浏览器商店上架仍需开发者账号及各商店审核。

## 检查

```sh
npm run check         # 检查三个聚合文件与模块源码是否一致
npm test              # 聚合文件检查与单元测试
npm run test:browser  # Chromium 加载扩展，运行历史、行级交互和导航测试
```

`tests/check.html` 覆盖气泡行为；`tests/inspect.js` 用于真实页面的只读诊断。仿真测试和真实站点验证各自提供不同证据：站点 DOM、接口与主题发生变化时，需要在真实页面重新核对。改名、复制和删除会写入账号；验证时使用明确可处置的测试数据。

## 数据与结构

扩展复用 AI Studio 的会话列表请求与登录状态；翻页和行级操作会向 Google AI Studio 接口发送请求。历史缓存保存于当前页面的 `sessionStorage`，记录会话标识、标题和更新时间。扩展没有独立后台服务或第三方同步服务。接口和站点 DOM 属于 Google 的内部实现，可能随站点更新而变化。

模块职责、数据流与构建边界见 [架构文档](docs/ARCHITECTURE.md)。
