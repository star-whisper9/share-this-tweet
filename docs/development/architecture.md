# 项目结构与数据流

扩展使用 TypeScript 和浏览器原生界面，构建由 esbuild 完成。运行时由 X 页面中的脚本、内容脚本、持久后台页，以及独立的扩展页面和 Worker 组成。它们有不同的生命周期，排查问题时先判断数据在哪一步发生变化。

## 目录与入口

| 位置                                    | 职责                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| `src/manifest.json`                     | 权限、后台页、内容脚本和可被网页加载的资源声明           |
| `src/page`                              | 在 X 页面环境中观察网络响应，提取推文候选与手动翻译结果  |
| `src/content`                           | 接收推文、维护当前面板与媒体选择、提交导出任务           |
| `src/background`                        | 路由扩展消息、管理导出队列与下载、协调视频 Worker        |
| `src/core`                              | 渲染、媒体选择、模板、文件名、来源读写、存储及客户端封装 |
| `src/shared`                            | 跨入口的数据类型、协议、校验、设置、语言和任务规则       |
| `src/workers`                           | FFmpeg 动态处理与媒体来源读写                            |
| `src/options`、`src/popup`、`src/tasks` | 设置页、扩展弹窗和任务页                                 |
| `tests`、`scripts`                      | 行为测试、构建与真实媒体验证工具                         |

`src/core` 并不全部是可在任意环境运行的纯函数：例如图像渲染需要 Canvas，存储需要 IndexedDB，客户端会访问扩展消息 API。抽取或复用代码前，先检查它实际依赖的运行环境。

## 从 X 响应到推文记录

```text
X 的 fetch / XMLHttpRequest 响应
  → page/interceptor.ts：寻找推文候选，观察手动翻译请求
  → CustomEvent：JSON 字符串跨页面环境传递
  → content/capture.ts：监听事件并交给 TweetSource
  → shared/tweet-normalizer.ts：转换成 TweetRecord
  → content/tweet-source.ts：合并、缓存、补齐引用并通知界面
  → content/ui.ts：更新当前推文的导出面板
```

`content/bootstrap.ts` 在 `document_start` 启动读取器。`capture.ts` 先注册事件监听，再注入 `page/interceptor.js`，避免页面尚未完成加载时丢失第一份数据。读取器就绪与注入失败分别有明确状态，不能把「没有收到数据」当作一条空推文继续导出。

`interceptor.ts` 通过复制响应读取 JSON，不消费 X 自己要使用的响应体。它在页面环境工作，是为了观察 X 已有的请求；扩展不会为了翻译主动发起额外的翻译请求。

页面事件不是可信的扩展内部调用。事件名与序列化格式定义在 `shared/capture-protocol.ts`，接收后仍需解析、归一化和校验；后台接收导出请求时还会执行网络地址与大小等策略校验。

## 统一的数据模型

`shared/model.ts` 定义 `TweetRecord`、`MediaRecord`、作者和引用信息。媒体序号从 `1` 开始，是后续选择、文件 ID、命名和输出记录关联同一项媒体的依据，不要把数组下标当作媒体序号。

归一化发生在 `shared/tweet-normalizer.ts`。它负责适配 X 的响应形状；渲染器和界面应使用归一化后的模型，避免在多个地方重复解析 X 的原始字段。

同一条推文可能陆续收到摘要、完整正文、长文、媒体信息或译文。`mergeTweetRecords` 根据正文来源和观测时间合并数据，并保留已知的媒体与作者信息。新增字段时需要同时考虑归一化、合并规则、记录校验和实际使用方，不能只给 TypeScript 接口加一个可选字段。

引用状态为 `pending`、`unavailable` 或 `available`，最多保留一层引用。`TweetSource` 在收集一批候选后再补齐引用，因此同一响应中主推文和引用推文的先后顺序不应影响结果。

手动译文按请求 ID 与推文、目标语言绑定，较旧的响应不能覆盖较新的请求，译文也不能错配到已经变化的正文。页面缓存最多保留最近使用的 200 条推文，相关翻译缓存另有上限；面板和已经提交的任务各自持有需要的记录。

## 从面板到输出文件

```text
ExportSession：推文、选择项、设置、主题、语言
  → core/job-client.ts：发送 export-job-enqueue
  → background/export-jobs.ts：校验并持久化请求，返回入队确认
  → core/job-renderer.ts：按快照生成文件
  → 队列接收 Blob：存入任务数据库，再交给浏览器保存
  → tasks：读取摘要、保存状态和诊断，执行取消或重试
```

`content/export-session.ts` 管理一次面板会话。提交时复制推文和配置，固定主题与语言，生成 `ExportJobRequest`。后台确认入队后，任务不再依赖原面板；关闭面板或原推文只销毁界面会话，不能连带取消已接受的任务。

复制文字是例外：它在用户点击时直接操作当前页面的剪贴板，随后尝试写入来源记录，不进入导出队列。将复制操作改成后台异步任务会影响浏览器对用户手势的判断。

渲染器只生成文件并通过回调返回，队列负责持久化、下载和任务状态。新增导出能力时沿用这处分工，避免渲染函数自己下载文件，同时又由队列重复下载。

## 消息与校验边界

| 通道         | 定义与接收方                                         | 修改时关注                            |
| ------------ | ---------------------------------------------------- | ------------------------------------- |
| 页面事件     | `shared/capture-protocol.ts`、`content/capture.ts`   | 不可信输入、注入时机与就绪信号        |
| 普通扩展消息 | `shared/protocol.ts`、`background/background.ts`     | 请求和响应形状、错误是否返回调用方    |
| 导出任务消息 | `shared/export-jobs.ts`、`background/export-jobs.ts` | 快照校验、媒体地址、序号及数量限制    |
| 动态处理消息 | `shared/video-job.ts`、`shared/video-render.ts`      | 请求 ID、布局握手、取消和 Worker 回收 |

TypeScript 类型只约束编译时的调用，不会验证页面、消息或文件传来的数据。`shared/record-validation.ts` 检查记录结构；`isExportJobRequest` 还检查允许访问的 HTTPS 媒体域名、模板长度、媒体数量及引用深度。新增后台可获取的 URL 字段时，必须把它纳入请求校验，而不是只在渲染时才发现地址不合法。

正常的字段缺失、待加载引用和不可见投票结果按模型表达；格式错误、存储失败和处理失败需要通过既有错误路径暴露，不能返回伪造的完整记录或成功状态。

## 按问题寻找修改位置

| 改动                   | 起点                                              | 常用验证                                                            |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| X 响应字段变化         | `tweet-normalizer.ts`、`model.ts`、`TweetSource`  | `tweet-normalizer`、`model`、`capture`、`translation`、`quote` 测试 |
| 媒体选择或主／引用切换 | `content/export-session.ts`、`media-selection.ts` | `export-session`、`mobile-actions` 测试                             |
| 输出样式或编码结果     | `core/job-renderer.ts` 与具体渲染模块             | [导出与媒体处理](media-processing.md)                               |
| 下载、重试或历史数据   | 队列、任务存储和任务页                            | [后台任务与存储](jobs-and-storage.md)                               |
| 新增选项、变量或语言   | 设置、模板字段注册表和词典                        | [设置与本地化](settings-and-localization.md)                        |

表中的测试名对应 `tests/<名称>.test.ts`。只运行与本次行为有关的测试，必要时再补充完整检查与实机回归。
