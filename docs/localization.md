# 本地化维护

界面语言独立保存在 `share-this-tweet.language`，值为 `auto`、`zh-CN` 或 `en`。两个语言入口即时保存该键；保存模板只更新 `share-this-tweet.settings`。`watchLanguage` 用于同步打开的页面，返回函数用于注销监听。

`src/shared/i18n.ts` 提供 `t`、`getLocale`、`resolveLocale` 和 `localizeDocument`。文案集中在 `src/shared/locales/`，按 common、content、options、core 分组。使用稳定的语义键，不把中文文案当标识。英文词典通过类型检查覆盖中文的全部键，自动化检查还会验证中英占位参数一致。

动态值通过 `t('key', { count, error })` 传入，用 `{count}` 插值；`{{` 和 `}}` 表示字面花括号。插值只执行一次，不重新解析用户输入。HTML 用 `data-i18n` 标记纯文本节点；属性使用 `data-i18n-placeholder`、`data-i18n-title`、`data-i18n-aria-label`。不要标记包含子元素的父节点，不使用 innerHTML 注入翻译，也不要扫描替换用户内容。

新增语言：

1. 在各词典模块增加覆盖全部键的语言表，再在 `i18n.ts` 注册语言、浏览器语言映射和合并后的 catalog。
2. 在弹窗及设置页语言选择器中添加原生语言名称。
3. 补充 `src/_locales/<browser_locale>/messages.json`，让扩展管理器显示对应语言。浏览器管理的扩展名称随浏览器语言，不受应用内语言选择影响。
4. 提供内置复制模板的对应版本；保留已有版本识别，绝不改写自定义模板。
5. 运行格式、类型、测试、构建与扩展清单检查；人工确认长文案、窄屏、键盘操作、日期和导出图像布局。

推文原文、作者、URL、用户文件、协议字段、模板变量名称以及用户自定义模板都不是界面文案。内置默认模板可随语言切换，用户修改后的模板按原样保存和使用。生成图片的标签使用导出开始时的语言；异步后台/Worker 请求需携带 locale，以便返回正确语言的错误提示。
