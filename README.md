# 分享有据 · Share This Tweet

面向 Firefox 的 X 推文分享增强扩展，当前 `v0.2.0` 功能实现已完成。

## 当前状态

- 仅在 X 推文详情页提供扩展操作入口。
- 支持浏览器工具栏弹出卡片，可直接进入设置页。
- 支持照片原图、普通视频和 GIF 对应的 MP4 保存。
- 支持文件名模板和 Tweet 元信息。
- 支持复制包含正文、作者、原文链接和 Tweet ID 的文本推文。
- 支持照片上方或下方来源画框；不透明图片输出 JPEG，含透明像素的图片输出 WebP；根据图像宽度自动使用单栏或双栏排版。
- 画框模板支持 `{author.avatar}`；头像获取失败时回退到内置 X logo。
- 媒体支持多选；原图按钮和两个画框按钮同时支持单选与批量保存。
- 批量画框时，照片添加画框，视频和 GIF 保持原样保存；无媒体选中时操作按钮自动禁用。
- 支持推文来源记录的本地保存、查询、删除、清空以及 JSON 导入导出。
- 支持纯文字及 1～4 张照片的推文卡片生成，并自动适配 X 页面或系统的亮色/暗色主题。
- 所有客户端均可直接保存推文卡片 PNG；无照片卡片保留正文、作者、时间、Tweet ID 和原推链接。
- 所有客户端均提供复制推文文字与保存推文卡片按钮。
- 设置页支持文件名、画框和复制文本模板的保存、校验与预览。
- UI 支持亮色和暗色模式。
- macOS Firefox 已完成主要功能验证；Android Firefox 已进行初步验证。

## 已知问题

原生分享暂不实现，不提供系统分享按钮。Firefox 的 Web Share 文件分享尚未实现（[Mozilla 1635700](https://bugzilla.mozilla.org/show_bug.cgi?id=1635700)），Android 文本分享存在正文未传给目标应用的问题（[Mozilla 1896224](https://bugzilla.mozilla.org/show_bug.cgi?id=1896224)）。调查日期：2026-09-08。

需要发送内容时，可复制文字后粘贴，或保存卡片后从相册／目标应用发送。原生分享没有排定实现版本。

项目使用 TypeScript、npm 和 Vitest，许可证为 GPL v3。

## 开发结构

- `content/ui.ts`：页面与推文数据协调入口。
- `content/tweet-page.ts`、`share-sheet.ts`：X 页面入口、弹层生命周期与焦点管理。
- `content/actions-view.ts`、`media-view.ts`、`ui-components.ts`：动作和媒体界面。
- `content/export-session.ts`、`media-selection.ts`：每条推文的导出状态、媒体选择和操作流程。
- `core/`：下载、渲染、模板及来源存储。

开发验证规范见 `AGENTS.md`；常规实机回归由星语负责。

## Roadmap

- 后续 `v0.x.0`：继续增强画框主题、媒体导出和更多推文内容导出能力。

## Credit

本项目独立开发，不基于 `twitter-improvements` 项目构建。开发过程中参考了该项目的部分源码和实现思路；具体复用范围将在确认后补充说明。
