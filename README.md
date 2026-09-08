<p align="center">
  <img src="src/icons/icon-128.png" width="96" height="96" alt="分享有据图标">
</p>

<h1 align="center">分享有据 · Share This Tweet</h1>

<p align="center">分享喜欢，也留下出处。</p>

<p align="center">
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.3.0-blue" alt="版本 0.3.0"></a>
  <img src="https://img.shields.io/badge/Firefox-supported-FF7139?logo=firefoxbrowser&amp;logoColor=white" alt="支持 Firefox">
  <img src="https://img.shields.io/badge/Android-experimental-3DDC84?logo=android&amp;logoColor=white" alt="Android 初步支持">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="许可证 GPL-3.0"></a>
</p>

将 X 推文保存为卡片，为图片附上作者与来源，或复制带出处的文字。适用于 Firefox，也支持 Firefox Android。

当前版本 **v0.3.0** · [更新记录](CHANGELOG.md)

## 保存内容，也保留来源

### 给图片加上来源画框

在图片上方或下方添加作者与来源信息，方便分享后找回原推文。画框自动适配明暗主题，也支持透明图片。

想保留原图？可以直接保存照片、视频和 GIF，也可以多选后批量保存。视频与 GIF 保存为 MP4。

| 亮色 · 上方画框                                  | 暗色 · 下方画框                                 |
| ------------------------------------------------ | ----------------------------------------------- |
| ![亮色上方来源画框](docs/images/frame-light.jpg) | ![暗色下方来源画框](docs/images/frame-dark.jpg) |

### 把推文存成卡片

将正文、作者、时间、照片和来源链接整理成一张 PNG。纯文字推文也能保存；引用推文会一并呈现，支持一层引用。

X 提供译文时，卡片会同时保留译文和原文，阅读与对照都方便。明暗主题自动适配，来源放在底部脚注中。

| 图文与双语                                                        | 引用推文                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| ![包含译文、原文和照片的推文卡片](docs/images/card-bilingual.png) | ![包含一层引用和双语正文的推文卡片](docs/images/card-quote.png) |

<sub>译文与原文一并保留，来源集中在底部脚注。点击图片可查看完整尺寸。</sub>

### 按你的习惯复制和命名

复制推文文字时，可以自由组合原文、译文、作者和链接；保存文件时，也能自定义命名规则。

设置页提供预设、变量填写指南、快捷插入与预览，无需从零编写模板。已保存的来源记录可在本地查询、删除，也可导入导出备份。

![复制文字设置：预设、模板编辑、变量快捷插入与效果预览](docs/images/settings-copy.png)

<sub>从预设开始，按需调整文字与出处的组合；右侧即时预览复制效果。</sub>

## 怎么使用

1. 在 X 中点击进入一条推文的**详情页**。
2. 点击扩展提供的导出入口，选择要保存的媒体，或直接保存卡片、复制文字。
3. 如需修改画框、文件名或复制格式，从 Firefox 扩展菜单打开设置。

导出入口仅出现在推文详情页，时间线和搜索结果中不会显示。

## 安装

目前尚未上架 Firefox 附加组件商店，暂时通过本地构建体验。桌面 Firefox 已验证主要功能；Android Firefox 已进行初步验证，完整兼容性仍在完善。

<details>
<summary>桌面 Firefox：本地构建与临时加载</summary>

准备 Node.js 和 npm，下载项目源码，在项目目录运行：

```sh
npm ci
npm run build
```

打开 `about:debugging#/runtime/this-firefox`，选择“临时载入附加组件”，加载构建生成的 `dist/manifest.json`。

临时加载的扩展会在 Firefox 重启后移除；普通安装需要 Mozilla 签名的扩展包。

</details>

## 个人使用：签名 unlisted 版本

需要 Mozilla Add-ons API 凭据，通过环境变量 `WEB_EXT_API_KEY` 和
`WEB_EXT_API_SECRET` 提供。不要将凭据写进仓库或命令行参数。

```sh
# 检查、构建并签名；会上传到 Mozilla，但不会在商店公开列出
npm run sign:unlisted

# 仅生成和验证产物，不上传，也不要求凭据
npm run sign:unlisted -- --prepare-only

# 换电脑、清理本地记录或 AMO 已占用编号时，指定一个更大的第四段数字
npm run sign:unlisted -- --build-number 42
```

脚本保持当前扩展 ID，以源码版本为基础分配第四段数字，例如
`0.3.0.1`、`0.3.0.2`。只有独立副本的 manifest 会改变；源码版本、
`package.json`、锁文件及正式 `dist/manifest.json` 都保持原版本。
原始 TypeScript 源码包随签名上传，内含重建步骤及版本覆盖命令。

产物位于 `releases.local/unlisted/<版本号>/`，包含独立扩展目录、
未签名 ZIP、审核源码 ZIP、成功后取得的 XPI 和 `submission.json` 状态记录。
**目录本身就是编号预留记录**：准备模式和失败提交也会消耗编号；不要删除这些
版本目录后继续自动编号。脚本只知道本地编号，不查询 AMO，遇到远端版本冲突时
请根据 AMO 记录，用 `--build-number` 指定更大的编号后重试。

同一时间只能运行一个 unlisted 构建；强制终止可能留下
`releases.local/sign-unlisted.lock/`，确认没有相关进程后再手动移除。
运行签名时不要在另一个终端同时执行会重建 `dist/` 的命令。

listed 和 unlisted 共享版本号空间。安装 `0.3.0.1` 后，商店的 `0.3.0`
不会自动覆盖它；后续正式 `0.3.1` 才更高。当前 manifest 没有自定义
`update_url`，后续更高的 AMO 正式版可以成为更新来源。
参见 [Mozilla unlisted 分发说明](https://extensionworkshop.com/documentation/publish/self-distribution/)
和 [版本格式](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/version)。

## 使用前了解

- **翻译由 X 提供。** 扩展不会主动请求翻译。没有译文时保留原文；在 X 中手动点击翻译后，无需刷新即可更新导出内容。翻译数据异常时，面板会显示警告。
- **系统分享暂不提供。** Firefox 的文件分享支持及 Android 文本分享存在已知问题，暂不计划实现系统分享按钮。可以复制文字后粘贴，或保存图片后在目标应用中发送。记录可参见 [CHANGELOG](CHANGELOG.md)。
- **来源记录保存在本地。** 如需迁移或备份，可在设置页导出记录；扩展不提供云同步。
- **X 的页面和数据可能变化。** 如遇到无法读取推文或导出异常，欢迎在仓库 Issues 中反馈，并附上复现步骤与浏览器版本。

## 致谢与许可

开发过程中参考了 [twitter-improvements](https://github.com/usyless/twitter-improvements) 的部分源码和实现思路。本项目独立开发，不基于该项目构建。

采用 [GNU GPL v3](LICENSE) 许可证。
