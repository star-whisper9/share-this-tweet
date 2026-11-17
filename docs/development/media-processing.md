# 导出与媒体处理

所有文件导出从 `core/job-renderer.ts` 的 `renderExportJob` 进入。它读取已经校验的任务快照，选择具体渲染路径，再通过 `onFile` 返回带文件名、稳定 ID 和输出记录说明的 Blob。文件缓存、下载和重试由[后台队列](jobs-and-storage.md)负责。

## 导出类型与入口

| 请求或操作                   | 主要实现                                             | 输出                                 |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------ |
| `media`：原文件              | `core/media.ts`、`job-renderer.ts`                   | 原图或选中的 MP4 变体                |
| `media`：照片画框            | `core/frame.ts`                                      | 不透明图片为 JPEG，透明图片为 WebP   |
| `card`、`row-card`           | `core/card.ts`、`card-media.ts`、`card-tags.ts`      | 静态 PNG                             |
| `stitch`：静态拼图           | `core/stitch.ts`                                     | 无画框时为 PNG，加框时沿用画框编码   |
| 普通视频写入来源             | `core/mp4-source.ts`、`media-source-client.ts`       | 不重新编码的 MP4                     |
| GIF 转码、视频画框、动态拼图 | `background/video-render.ts`、`core/video-engine.ts` | GIF 或 MP4                           |
| GIF 写入来源                 | `core/gif-source.ts`、`media-source-client.ts`       | 保留动画结构的 GIF                   |
| 复制文字                     | `core/text-export.ts`                                | 当前页面的剪贴板文本，不进入文件队列 |

原文件选择由 `getMediaDownloadTarget` 统一决定。照片从 URL 读取实际格式；视频与 GIF 从 `video/mp4` 变体中选择码率最高的一项。不要把播放器当前清晰度或 X 的上传限制当作下载文件的编码参数。

## 静态渲染

### 卡片

`renderTweetCard` 使用正文、作者、时间、媒体预览、投票、译文与一层引用生成图像。网格卡片和单行卡片共用记录，媒体布局不同。卡片使用整条推文的媒体，不跟随面板勾选。

视频和 GIF 只能使用 X 已提供的静态预览，不在卡片渲染时下载视频提取帧。修改媒体布局时保留原顺序，不能通过省略某项来掩盖加载失败，也不能把不可见的投票结果补为默认值。

### 来源画框与拼图

`frame.ts` 包含文字折行、尺寸计算、头像与来源标记渲染，以及输出编码。左侧由模板生成，右侧的来源标记有固定布局。透明像素会影响输出格式，改尺寸或主题时需要同时验证透明图片和窄图。

`stitch.ts` 先计算横向布局，各项按统一高度等比缩放，不裁切。间距取决于无缝／画廊样式，来源画框应用到完整拼图一次，不逐项叠加。

### 图像资源生命周期

每次任务创建 `ImageResources`，压缩 Blob 缓存默认最多 32 MiB、16 项，合并相同 URL 的并发请求，并限制同时下载的数量。它不负责长期持有解码后的完整图像；解码图像由渲染器释放，任务结束或取消时调用 `dispose`。

新增图像资源时沿用同一任务的资源对象，处理失败也要释放图像和对象 URL。不要把这个按任务存在的缓存提升为后台永久缓存，否则连续导出会积累内存。

## 文件名与输出记录

`core/filename.ts` 负责展开模板、清理非法字符、限制长度，并按实际格式确定扩展名。带来源、画框、卡片和拼图的后缀也在这里生成。界面预览和真实保存应复用同一套命名函数。

`ExportJobFile` 同时包含 `id`、`filename`、`blob` 和 `output`。例如单项媒体使用 `任务ID:media:媒体序号` 作为文件 ID；重试后仍需得到同一个 ID，队列才能跳过已保存文件。

新增输出类型时，除了生成文件，还要同步检查：

1. `shared/export-jobs.ts` 的请求与文件协议，以及对应校验。
2. `shared/storage-model.ts` 的 `OutputType`，`core/storage.ts` 中允许的输出类型与归档校验。
3. `job-renderer.ts` 返回的输出说明、命名逻辑，以及 `options/records.ts` 中的展示映射。
4. 队列部分成功、重试和来源记录的行为。

渲染函数不得把零字节 Blob 当作有效输出；也不要通过改扩展名来掩盖编码器返回了错误格式。

## 写入与读取来源

来源结构定义在 `shared/media-source.ts`，包含来源推文、发布者、媒体序号、发布时间与工具版本。`parseMediaSourceMetadata` 校验版本、字段长度、推文链接和发布者信息，构造受限的普通对象；文件里出现的额外字段不能直接传播到界面或后台请求。

MP4 使用专用 UUID box 保存来源 JSON，并维护封装结构与相关偏移，不解码音视频。GIF 使用应用标识为 `STTSOURCE01` 的 GIF89a Application Extension；写入时保留图像、延迟与循环数据。两种格式共用来源 schema。

来源读写通过 `core/media-source-client.ts` 启动 `workers/media-source.worker.ts`，只能从扩展页面或后台调用，不在 X 的内容脚本环境中直接创建 Worker。客户端检查响应 ID、Blob 格式或来源结构，并在成功、失败、取消和超时后回收 Worker。

普通视频写入来源的默认下载保护上限为 512 MiB；来源文件默认限制为 2 GiB，Worker 默认超时为 120 秒。显式强制任务可跳过这三项保护；来源 JSON 的 16 KiB 契约和格式验证仍然执行。这些限制不同于 FFmpeg 实验选项。合法但没有来源的文件可以返回 `undefined`，损坏文件、不支持的封装或冲突来源应保留明确错误，不能都当作「没有来源」。

## 保护限制与强制执行

`core/export-preflight.ts` 用已有媒体元数据估算输出，导出面板确认后把 `force: true` 写入不可变任务快照。图像预算集中在 `shared/processing-limit.ts`；实际处理触发可放宽的保护时抛出 `ProcessingLimitError`，批量处理通过 `ExportItemsError` 保留是否可强制重试。

队列将保护阻断标为 `limited`，保留有效文件的未完成任务标为 `partial`。动态处理的默认回退输出带有可强制重试标记。`export-job-force-retry` 创建新的强制任务，保留旧任务和文件，避免已保存文件的去重逻辑阻止重新生成目标格式。普通重试继续复用任务 ID。

## 动态处理链路

```text
job-renderer：准备任务、诊断与回调
  → background/video-render：复核开关、下载输入、管理唯一活动 Worker
  → workers/video-render.worker：加载本地 ffmpeg-core.js / WASM
  → core/video-engine：探测输入，调用布局与编码计划
  → Worker 回报 layout：实际宽度、时长等信息
  → 后台用 Canvas 生成来源条 PNG，回传 frame
  → Worker 编码并返回结果，后台结束 Worker
```

`core/video-plan.ts` 负责 MP4 布局与 FFmpeg 参数，`core/gif-plan.ts` 负责单项 GIF 的尺寸、帧率和调色板参数。`video-engine.ts` 负责探测、写入临时素材、执行计划与清理，Worker 适配器负责实际调用 FFmpeg。

核心固定为 `@ffmpeg/core` 0.12.10，构建时复制到扩展自身目录，单线程运行，不从 CDN 加载。修改加载方式时要同时考虑扩展 CSP、经典 Worker 的 UMD 加载和本地 WASM 路径；不要让运行时依赖远程脚本。

Worker 的探测结果才是编码计划的依据。普通视频和 GIF 同时开始，以最长动态项为输出时长，较短项停在末帧；音轨来自第一条实际有音轨的普通视频，GIF 不提供声音。单项 GIF 使用单独的调色板与编码流程，不能套用 MP4 音轨或视频画框分支。

### 保护限制与回退

`shared/video-experiment.ts` 和 `shared/gif-experiment.ts` 定义限制及校验。源图像像素限制应在缩小输出前检查，最终输出像素还要计入画框。

后台开始执行时再次读取当前实验开关；尺寸、时长等处理限制使用任务携带的快照。排队期间关闭开关会阻止尚未开始的对应转码。

| 结果                       | 渲染器处理                                                       |
| -------------------------- | ---------------------------------------------------------------- |
| 正常完成                   | 返回生成的 Blob                                                  |
| 动态画框超限               | 保存已经下载的原媒体，报告回退原因                               |
| 动态拼图超限               | 使用现有静态预览生成拼图，报告回退原因；预览缺失仍报错           |
| GIF 转码超限               | 保存原始 MP4，报告原因；当前回退分支按原文件输出，不继续写入来源 |
| 下载、探测、解码或编码失败 | 报错，不按超限方式回退                                           |
| 用户取消                   | 终止 Worker，不触发补存                                          |

`VideoLimitError` 及对应 Worker 标记用于区分保护限制和真正的处理错误。不能把任意异常捕获后统一保存原文件，否则调用方会误以为请求的处理已完成。

动态处理不设自动编码超时，取消通过 `AbortSignal` 传播，并终止 Worker、释放图像资源。来源读写 Worker 的超时策略与此不同，修改时不要把两种处理混在一起。

## 诊断与验证

`video-diagnostics.ts` 从 FFmpeg 进度日志采样，`video-report.ts` 汇总报告。WASM 同步执行期间，普通 JavaScript 定时器不能可靠反映编码进度，因此进度与采样依赖 FFmpeg 回调。

报告区分阶段耗时、WASM 线性内存容量、MEMFS 文件大小、输出缓冲容量和输出副本大小。容量不是实际使用量，这些数字也不能简单相加当作进程内存。最多保留 2000 条样本，丢弃数量显式计数；诊断不保存媒体帧、推文正文或下载 URL。

静态尺寸与编码规则优先通过公开函数验证，涉及实际画面时补充 Firefox 人工回归。可从这些测试开始：

| 改动                       | 相关测试                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| 画框、卡片与静态拼图       | `frame`、`card`、`card-render`、`card-media`、`stitch`、`image-resources`                |
| 媒体变体与文件名           | `template`                                                                               |
| 来源元数据与 MP4／GIF 封装 | `media-source`、`mp4-source`、`gif-source`、`media-source-worker`、`media-source-client` |
| 动态处理计划与错误边界     | `video-plan`、`gif-render`、`video-background`、`video-experiment`、`gif-experiment`     |
| 任务分支与诊断             | `job-renderer`、`video-report`、`video-diagnostics`                                      |

测试文件位于 `tests/<名称>.test.ts`。FFmpeg 参数或 Worker 协议变化后，再执行[真实 WASM 验证](getting-started.md#涉及视频编码)，检查实际输出，不只验证参数数组。
