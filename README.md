<p align="center">
  <img src="src/icons/icon-128.png" width="96" height="96" alt="分享有据图标">
</p>

<h1 align="center">分享有据 · Share This Tweet</h1>

<p align="center">分享喜欢，也留下出处。</p>

<p align="center">
  <a href="https://addons.mozilla.org/zh-CN/firefox/addon/share-this-tweet/"><img src="https://img.shields.io/amo/v/share-this-tweet?label=AMO&amp;logo=firefoxbrowser&amp;logoColor=white&amp;color=FF7139" alt="AMO 商店版本"></a>
  <a href="https://github.com/star-whisper9/share-this-tweet/releases/latest"><img src="https://img.shields.io/github/v/release/star-whisper9/share-this-tweet?display_name=tag&amp;label=Unlisted&amp;logo=github&amp;logoColor=white&amp;color=blue" alt="GitHub Releases · Unlisted 版本"></a>
  <img src="https://img.shields.io/badge/Firefox-supported-FF7139?logo=firefoxbrowser&amp;logoColor=white" alt="支持 Firefox">
  <img src="https://img.shields.io/badge/Android-experimental-3DDC84?logo=android&amp;logoColor=white" alt="Android 初步支持">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="许可证 GPL-3.0"></a>
</p>

分享有据是一个 Firefox 扩展，用于保存 X 推文中的图片、视频与 GIF，生成推文卡片，复制文字，并保留作者和原推文的来源信息。支持桌面 Firefox 与 Firefox Android。

[用户指南](docs/guide/getting-started.md) · [开发指南](docs/development/getting-started.md) · [更新记录](CHANGELOG.md)

## 快速上手

1. 用桌面 Firefox 140 或 Android Firefox 142 及以上版本打开 [AMO 商店页面](https://addons.mozilla.org/zh-CN/firefox/addon/share-this-tweet/)，点击「添加到 Firefox」。
2. 打开 X 推文的**详情页**，点击「分享有据」导出入口。安装前已打开的页面请先刷新。
3. 选择媒体并保存，或保存整条推文卡片、复制推文文字。
4. 保存操作显示「已加入队列」后，可以离开原推文，在「查看导出任务」中查看进度。桌面自动保存；Android 需要保留任务页并手动保存文件。

其他安装方式、更新说明和详细操作见[用户指南](docs/guide/installation.md)。

## 功能概览

- **来源画框**：在照片上方或下方添加作者与来源，适配明暗主题和透明图片。
- **画廊拼接**：按原顺序横向拼接全部媒体，可选无缝连接、画廊间隔和整图画框。
- **推文卡片**：将正文、作者、媒体预览和来源整理为静态 PNG，支持译文、投票与一层引用，以及网格或单行布局。
- **媒体下载**：保存原图、MP4 与 GIF，可为视频和 GIF 写入来源；GIF 默认在本机转码为 `.gif`。
- **复制与命名**：通过预设和模板调整复制文字、画框内容与文件名。
- **任务与来源记录**：查看进度、取消和重试导出，查找、备份来源记录，或从本地 MP4／GIF 读取已写入的来源。
- **实验性动态处理**：开启后可生成动态拼图或为普通视频添加画框，默认关闭；规则与限制见[实验性功能](docs/guide/experimental.md)。

保留出处不代表获得转载授权，分享时仍需尊重原作者的权益。

## 致谢与许可

开发过程中参考了 [twitter-improvements](https://github.com/usyless/twitter-improvements) 的部分源码和实现思路。本项目独立开发，不基于该项目构建。

采用 [GNU GPL v3](LICENSE) 许可证。
