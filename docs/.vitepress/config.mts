import { defineConfig } from 'vitepress';

const userGuide = [
  {
    text: '用户指南',
    items: [
      { text: '快速开始', link: '/guide/getting-started' },
      { text: '功能介绍', link: '/guide/features' },
      { text: '安装', link: '/guide/installation' },
      { text: '设置', link: '/guide/settings' },
      { text: '使用', link: '/guide/usage' },
      { text: '实验性功能', link: '/guide/experimental' },
    ],
  },
];

const developerGuide = [
  {
    text: '开发指南',
    items: [
      { text: '本地开发', link: '/development/getting-started' },
      { text: '项目结构与数据流', link: '/development/architecture' },
      { text: '导出与媒体处理', link: '/development/media-processing' },
      { text: '后台任务与存储', link: '/development/jobs-and-storage' },
      { text: '设置与本地化', link: '/development/settings-and-localization' },
    ],
  },
];

export default defineConfig({
  lang: 'zh-CN',
  title: '分享有据',
  description: '分享有据 Firefox 扩展的使用指南与开发文档。',
  base: '/share-this-tweet/',
  cleanUrls: true,
  themeConfig: {
    siteTitle: '分享有据',
    nav: [
      { text: '用户指南', link: '/guide/getting-started', activeMatch: '/guide/' },
      {
        text: '开发指南',
        link: '/development/getting-started',
        activeMatch: '/development/',
      },
      { text: 'ChangeLog', link: '/changelog' },
    ],
    sidebar: {
      '/guide/': userGuide,
      '/development/': developerGuide,
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/star-whisper9/share-this-tweet' }],
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '没有找到相关内容',
                resetButtonTitle: '清除搜索',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
        },
      },
    },
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一篇', next: '下一篇' },
    darkModeSwitchLabel: '外观',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '返回顶部',
  },
});
