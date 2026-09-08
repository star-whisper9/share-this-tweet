import { DATE_FORMATS, fieldsForScope, renderTemplate } from '../core/template.js';
import type { TemplateScope, TemplateContext } from '../core/template-fields.js';
import type { TweetRecord } from '../shared/model.js';

const example: TweetRecord = {
  tweetId: '1234567890',
  url: 'https://x.com/example/status/1234567890',
  text: '今天的照片。',
  author: {
    id: '7',
    handle: 'example',
    name: '晴日来信',
    description: '记录日常',
    location: 'Shanghai',
    url: 'https://example.com/',
    createdAt: '2020-01-01T00:00:00.000Z',
    avatarUrl: 'https://pbs.twimg.com/profile_images/example.png',
  },
  publishedAt: '2026-09-08T10:00:00.000Z',
  observedAt: '2026-09-08T11:00:00.000Z',
  language: 'zh',
  sensitive: false,
  editIds: ['1234567890'],
  media: [
    {
      index: 1,
      type: 'photo',
      originalUrl: 'https://pbs.twimg.com/media/example.jpg',
      width: 1200,
      height: 800,
      altText: '海边日落',
    },
  ],
};
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  return element;
}

/** The field registry is the only source of names, format support and help text. */
export function mountTemplateGuide(
  container: HTMLElement,
  input: HTMLInputElement | HTMLTextAreaElement,
  scope: TemplateScope,
  editable: () => boolean,
  changed: () => void,
): void {
  container.replaceChildren();
  container.className = 'template-guide';
  const guide = node('details');
  guide.append(node('summary', '填写指南与全部变量'));
  guide.append(
    node(
      'p',
      '点击变量插入光标或替换选区。变量缺失时为空；0 和 false 是有效值。日期格式统一使用 UTC。',
    ),
  );
  guide.append(
    node(
      'p',
      '默认值：{tweet.language|未知}。可选区块：{?quote.tweet.id}引用：{quote.tweet.url}{/quote.tweet.id}。区块按有无值显示，不支持嵌套；字面花括号与默认值中的 | 不支持转义。',
    ),
  );
  guide.append(
    node(
      'p',
      '复制模板未写引用变量时会自动追加一层引用；显式使用引用变量／区块后由模板控制。媒体变量只适用于命名和画框；引用媒体保存时，推文和作者变量指媒体所属推文。',
    ),
  );
  const search = node('input');
  search.type = 'search';
  search.placeholder = '搜索变量、说明或语法';
  search.setAttribute('aria-label', '搜索模板变量');
  guide.append(search);
  const list = node('div');
  list.className = 'template-variable-list';
  guide.append(list);
  const fields = fieldsForScope(scope);
  const insert = (value: string): void => {
    if (!editable()) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(value, start, end, 'end');
    input.focus();
    changed();
    updatePreview();
  };
  function insertButton(value: string, label = value): HTMLButtonElement {
    const button = node('button', label);
    button.type = 'button';
    button.className = 'token';
    button.title = `插入 ${value}`;
    button.addEventListener('click', () => insert(value));
    return button;
  }
  function renderList(): void {
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    for (const group of ['推文', '作者', '媒体', '引用', '输出']) {
      const matches = fields.filter(
        (field) =>
          field.group === group &&
          `${field.name} ${field.label} ${field.description}`.toLowerCase().includes(query),
      );
      if (!matches.length) continue;
      list.append(node('h4', group));
      for (const field of matches) {
        const row = node('div');
        row.className = 'template-variable';
        row.append(node('strong', field.label), insertButton(`{${field.name}}`));
        row.append(node('p', `${field.description} 示例：${field.example}`));
        const variants = node('div');
        variants.className = 'token-list';
        if (field.date)
          for (const format of DATE_FORMATS)
            variants.append(insertButton(`{${field.name}:${format}}`, format));
        variants.append(
          insertButton(`{${field.name}|未提供}`, '缺值默认'),
          insertButton(`{?${field.name}}内容{/${field.name}}`, '可选区块'),
        );
        row.append(variants);
        list.append(row);
      }
    }
    if (!list.childElementCount) list.append(node('p', '没有匹配的变量。'));
  }
  search.addEventListener('input', renderList);
  renderList();
  const scenario = node('select');
  scenario.setAttribute('aria-label', '模板试算场景');
  for (const [value, label] of [
    ['standard', '普通推文'],
    ['quote', '带引用'],
    ['empty', '缺少可选字段'],
    ['no-media', '没有媒体'],
    ['translated', '有 X 译文'],
  ]) {
    const option = node('option', label);
    option.value = value;
    scenario.append(option);
  }
  const preview = node('pre');
  preview.className = 'template-scenario-preview';
  preview.setAttribute('aria-live', 'polite');
  guide.append(
    node('h4', '场景试算'),
    scenario,
    node(
      'p',
      '试算不改变保存校验；上下文不适用会显示原因。此处显示变量展开结果，文件名保存时还会清理非法字符。',
    ),
    preview,
  );
  function updatePreview(): void {
    let tweet: TweetRecord = example;
    if (scenario.value === 'translated')
      tweet = {
        ...example,
        text: 'A photo from today.',
        language: 'en',
        translation: {
          status: 'available',
          originalText: 'A photo from today.',
          text: '今天的照片。',
          sourceLanguage: 'en',
          targetLanguage: 'zh',
        },
      };
    if (scenario.value === 'quote')
      tweet = {
        ...example,
        quote: {
          status: 'available',
          tweetId: '987654321',
          url: 'https://x.com/quoted/status/987654321',
          record: {
            ...example,
            tweetId: '987654321',
            url: 'https://x.com/quoted/status/987654321',
            author: { id: '8', handle: 'quoted', name: '引用作者' },
            text: '引用正文。',
          },
        },
      };
    if (scenario.value === 'empty')
      tweet = {
        tweetId: example.tweetId,
        url: example.url,
        text: example.text,
        author: { id: '7', name: '晴日来信', handle: 'example' },
        media: [{ index: 1, type: 'photo' }],
      };
    if (scenario.value === 'no-media') tweet = { ...example, media: [] };
    const context: TemplateContext = {
      tweet,
      media: scope === 'textTemplate' ? undefined : tweet.media[0],
      extension: scope === 'textTemplate' ? undefined : 'jpg',
    };
    try {
      preview.textContent = renderTemplate(input.value, context) || '（空结果）';
    } catch (error) {
      preview.textContent = error instanceof Error ? error.message : String(error);
    }
  }
  scenario.addEventListener('change', updatePreview);
  input.addEventListener('input', updatePreview);
  input.addEventListener('templatechange', updatePreview);
  guide.addEventListener('toggle', () => {
    if (guide.open) updatePreview();
  });
  const quick = node('div');
  quick.className = 'token-list';
  for (const name of [
    'translation.text',
    'translation.originalText',
    'translation.sourceLanguage',
    'translation.targetLanguage',
    'tweet.text',
    'author.name',
    'author.handle',
    'tweet.id',
    'tweet.url',
    'media.index',
    'extension',
  ]) {
    const field = fields.find((candidate) => candidate.name === name);
    if (field) quick.append(insertButton(`{${name}}`, `+ ${field.label}`));
  }
  container.append(quick, guide);
  updatePreview();
}
