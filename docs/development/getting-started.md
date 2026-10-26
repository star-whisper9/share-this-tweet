# 本地开发

开发指南面向修改代码、排查问题和参与维护的协作者。先完成一次本地构建与临时加载，再根据改动范围阅读[项目结构与数据流](architecture.md)、[导出与媒体处理](media-processing.md)、[后台任务与存储](jobs-and-storage.md)或[设置与本地化](settings-and-localization.md)。

## 准备环境

需要 Git、Node.js 22 或更高版本、npm，以及用于调试的 Firefox。扩展清单要求桌面 Firefox 140、Android Firefox 142 及以上；构建脚本中的 JavaScript 编译目标不等于扩展支持的最低浏览器版本。

```sh
git clone https://github.com/star-whisper9/share-this-tweet.git
cd share-this-tweet
npm ci
npm run build
```

依赖版本由根目录 `package-lock.json` 锁定。构建会重建 `dist`，打包 TypeScript 入口，并复制清单、界面资源和本地 FFmpeg 核心；不要直接修改 `dist` 中的文件。

日常开发不需要发布凭据或签名安装包。`npm run build` 生成的目录可以直接用于临时加载。

## 在 Firefox 中加载

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 选择「临时载入附加组件」，打开仓库中的 `dist/manifest.json`。
3. 在 Firefox 中打开 X 推文详情页，检查导出入口。
4. 修改代码后重新运行 `npm run build`，在调试页重新加载扩展，并刷新 X 页面。

这里没有自动监听源码的扩展构建命令。重新加载扩展会中断正在处理的任务；重新启动后，这些任务会显示为已中断，可手动重试。临时扩展会在 Firefox 重启后移除。

## 找到调试位置

| 问题所在                         | 查看位置                                                             |
| -------------------------------- | -------------------------------------------------------------------- |
| 导出入口、面板交互、推文读取     | X 页面开发者工具；源码从 `src/content` 和 `src/page` 查起            |
| 入队、下载、数据库、视频处理协调 | `about:debugging` 中扩展的「检查」入口；源码从 `src/background` 查起 |
| 设置页或任务页                   | 对应扩展页面的开发者工具，以及后台日志                               |
| 编码失败、阶段耗时或内存问题     | 任务页下载的诊断 JSON，结合后台和 Worker 错误定位                    |

构建会生成 source map，便于从打包后的错误追溯 TypeScript。报告问题时保留具体操作、浏览器版本、错误与相关诊断；不要把 X 的完整网络响应、凭据或个人媒体加入测试夹具和日志。

## 运行验证

### 按改动范围检查

先运行相关测试。例如修改模板或设置时：

```sh
npm test -- tests/template.test.ts tests/settings.test.ts
npm run typecheck
```

根目录 `tsconfig.json` 检查 `src` 中的 TypeScript，Vitest 使用 Node 环境运行 `tests/**/*.test.ts`。测试中的浏览器 API、Canvas 或 IndexedDB 模拟不代表真实 Firefox 已验证通过。

一次完整的常规检查为：

```sh
npm run check
npm run lint:extension
```

`check` 依次检查格式、类型、单元测试并构建扩展；`lint:extension` 检查已经生成的 `dist` 清单与扩展内容。仅修改文档时，使用下方的文档验证即可，不必为文字修改重复运行媒体处理测试。

### 涉及视频编码

修改 FFmpeg 参数、探测或 Worker 交互后，除相关单元测试外，在本机安装 `ffprobe`，运行：

```sh
npm run verify:video
```

该脚本先构建扩展，在 Node Worker 中执行打包后的真实 ffmpeg.wasm，再用本机 `ffprobe` 检查 GIF 转码及混合拼图、视频上下画框的输出尺寸、帧率、时长和音轨。它不能代替 Firefox 集成验证，也不能代表 Android 性能。

### 编写与验证文档

文档站是 `docs` 中独立的 npm 项目，不共用扩展的依赖安装与构建入口：

```sh
npm --prefix docs ci
npm --prefix docs run dev
```

在终端给出的地址下访问 `/share-this-tweet/`。页面位于 `docs/guide` 和 `docs/development`，导航配置位于 `docs/.vitepress/config.mts`。站点使用本地搜索，新增页面时同时补充导航与相关链接。

```sh
npm run format:check
npm --prefix docs run typecheck
npm --prefix docs run build
npm --prefix docs run preview
```

构建会检查无效的页面链接，不要通过关闭检查掩盖路径错误。输出目录为 `docs/.vitepress/dist`，不提交生成文件；预览时检查子页面直接访问、搜索、图片和窄屏目录。

## 为改动选择测试

优先复用已有测试，只为必要行为和高风险边界补充覆盖。测试通过公开模块接口验证输入、输出和状态，不强转访问控制器的私有成员，也不以易变 UI 文案或整段界面快照作为功能契约。

提交供维护者审阅的改动时，说明解决了什么问题、运行了哪些必要检查，以及哪些行为还需要实机验证。渲染、下载和 Android 交互通常需要人工回归；纯函数测试通过不等于设备上的文件已经成功保存。
