# 安装

## 支持的浏览器

| 使用环境        | 最低版本 |
| --------------- | -------- |
| 桌面 Firefox    | 140      |
| Firefox Android | 142      |

Android 已做初步适配，兼容性仍在完善。扩展只能在 Firefox 中的 X 网页运行，不能用于 X 的独立 App。

## （推荐）从附加组件商店安装

用 Firefox 打开[分享有据的 AMO 商店页面](https://addons.mozilla.org/zh-CN/firefox/addon/share-this-tweet/)，点击「添加到 Firefox」，按提示确认即可。桌面和 Android 均可使用这一方式，无需手动下载文件或开启隐藏安装菜单。

安装后打开 X 的推文详情页。若该页面在安装前就已打开，先刷新，再寻找导出入口。首次使用可跟随[快速开始](getting-started.md)完成一次导出。

商店版本支持 Firefox 自动更新，日常使用建议保持自动更新开启。AMO 与 GitHub Releases 的版本可能不同，以各渠道发布页面显示的版本为准。

## 从 GitHub Releases 安装

无法使用 AMO，或需要 GitHub 发布的安装包时，可以从 [Releases](https://github.com/star-whisper9/share-this-tweet/releases) 下载 Mozilla 签名的 Unlisted 版本。Unlisted 表示由开发者自行分发；安装包仍经过 Mozilla 签名。

在所需版本的 **Assets** 中下载 `.xpi` 文件。保持文件原样，无需解压；源码压缩包不能直接作为扩展安装。

### 桌面 Firefox

1. 打开 Firefox 的「附加组件和主题」，或在地址栏输入 `about:addons`。
2. 点击齿轮菜单，选择「从文件安装附加组件」。
3. 选择下载的 `.xpi`，按提示确认安装。

### Android Firefox

首次从文件安装，需要解锁 Firefox 自己的隐藏安装菜单：

1. 先将 `.xpi` 下载到手机。
2. 打开 Firefox 菜单 →「设置」→「关于 Firefox」。
3. 快速连续点击 Firefox 标志五次。
4. 返回设置页，选择新出现的「从文件安装扩展」（Install Extension from File）。
5. 选择 `.xpi`，按提示完成安装。

无需开启 Android 系统开发者选项或 USB 调试。未出现安装入口时，确认 Firefox 已更新，再重复以上步骤。可参考 [Mozilla 的自行分发扩展安装说明](https://extensionworkshop.com/documentation/publish/install-self-distributed/)。

### 更新 Unlisted 版本

GitHub Releases 版本当前不会自动从 GitHub 获取更新。需要手动下载新版 `.xpi`，重复对应平台的安装步骤，**无需先卸载**。

卸载会影响本地设置与来源记录。更新前如需备份，可在设置的「来源记录」中导出 JSON；该备份不包含偏好设置或媒体文件。

GitHub 安装包使用 `0.6.0.1` 这样的四段版本号：前三段对应 AMO 版本，最后一段区分同一版本的不同次构建签名。

## 从源码临时加载

需要修改扩展或验证本地构建时，按[本地开发](../development/getting-started.md)构建，再通过 Firefox 的 `about:debugging#/runtime/this-firefox` 临时加载 `dist/manifest.json`。

临时加载的扩展会在 Firefox 重启后移除，普通安装需要签名安装包。
