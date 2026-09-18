import { DATE_FORMATS, fieldsForScope, renderTemplate } from '../core/template.js';
import type { TemplateScope, TemplateContext } from '../core/template-fields.js';
import { getLocale, t } from '../shared/i18n.js';
import type { TweetRecord } from '../shared/model.js';

function exampleForLocale(): TweetRecord {
  const english = getLocale() === 'en';
  return {
    tweetId: '1234567890',
    url: 'https://x.com/example/status/1234567890',
    text: t('core.field.example.tweet.text'),
    author: {
      id: '7',
      handle: 'example',
      name: t('core.field.example.author.name'),
      description: t('core.field.example.author.description'),
      location: 'Shanghai',
      url: 'https://example.com/',
      createdAt: '2020-01-01T00:00:00.000Z',
      avatarUrl: 'https://pbs.twimg.com/profile_images/example.png',
    },
    publishedAt: '2026-09-08T10:00:00.000Z',
    observedAt: '2026-09-08T11:00:00.000Z',
    language: english ? 'en' : 'zh',
    sensitive: false,
    editIds: ['1234567890'],
    media: [
      {
        index: 1,
        type: 'photo',
        originalUrl: 'https://pbs.twimg.com/media/example.jpg',
        width: 1200,
        height: 800,
        altText: t('core.field.example.media.altText'),
      },
    ],
  };
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  return element;
}

const groupKeys = {
  推文: 'options.guide.group.tweet',
  作者: 'options.guide.group.author',
  媒体: 'options.guide.group.media',
  引用: 'options.guide.group.quote',
  输出: 'options.guide.group.output',
} as const;

/** The field registry is the source of template grammar and availability. */
export function mountTemplateGuide(
  container: HTMLElement,
  input: HTMLInputElement | HTMLTextAreaElement,
  scope: TemplateScope,
  editable: () => boolean,
  changed: () => void,
): void {
  const example = exampleForLocale();
  container.replaceChildren();
  container.className = 'template-guide';
  const guide = node('details');
  guide.append(node('summary', t('options.guide.title')));
  guide.append(node('p', t('options.guide.intro')));
  guide.append(node('p', t('options.guide.syntax')));
  guide.append(node('p', t('options.guide.quote')));
  const search = node('input');
  search.type = 'search';
  search.placeholder = t('options.guide.search');
  search.setAttribute('aria-label', t('options.guide.searchLabel'));
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
    button.title = t('options.guide.insert', { value });
    button.addEventListener('click', () => insert(value));
    return button;
  }
  function renderList(): void {
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    for (const group of Object.keys(groupKeys) as Array<keyof typeof groupKeys>) {
      const matches = fields.filter(
        (field) =>
          field.group === group &&
          `${field.name} ${field.label} ${field.description}`.toLowerCase().includes(query),
      );
      if (!matches.length) continue;
      list.append(node('h4', t(groupKeys[group])));
      for (const field of matches) {
        const row = node('div');
        row.className = 'template-variable';
        row.append(node('strong', field.label), insertButton(`{${field.name}}`));
        row.append(
          node('p', `${field.description} ${t('options.guide.example', { value: field.example })}`),
        );
        const variants = node('div');
        variants.className = 'token-list';
        if (field.date)
          for (const format of DATE_FORMATS)
            variants.append(insertButton(`{${field.name}:${format}}`, format));
        variants.append(
          insertButton(
            `{${field.name}|${t('options.guide.fallbackValue')}}`,
            t('options.guide.missingDefault'),
          ),
          insertButton(
            `{?${field.name}}${t('options.guide.optionalContent')}{/${field.name}}`,
            t('options.guide.optionalBlock'),
          ),
        );
        row.append(variants);
        list.append(row);
      }
    }
    if (!list.childElementCount) list.append(node('p', t('options.guide.noMatches')));
  }
  search.addEventListener('input', renderList);
  renderList();
  const scenario = node('select');
  scenario.setAttribute('aria-label', t('options.guide.scenarioLabel'));
  for (const [value, label] of [
    ['standard', t('options.guide.standard')],
    ['quote', t('options.guide.quoteScenario')],
    ['empty', t('options.guide.empty')],
    ['no-media', t('options.guide.noMedia')],
    ['translated', t('options.guide.translated')],
  ]) {
    const option = node('option', label);
    option.value = value;
    scenario.append(option);
  }
  const preview = node('pre');
  preview.className = 'template-scenario-preview';
  preview.setAttribute('aria-live', 'polite');
  guide.append(
    node('h4', t('options.guide.scenario')),
    scenario,
    node('p', t('options.guide.scenarioHelp')),
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
          text: t('core.field.example.tweet.text'),
          sourceLanguage: 'en',
          targetLanguage: getLocale() === 'en' ? 'en' : 'zh',
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
            author: {
              id: '8',
              handle: 'quoted',
              name: t('options.guide.quoteAuthor'),
            },
            text: t('options.guide.quoteText'),
          },
        },
      };
    if (scenario.value === 'empty')
      tweet = {
        tweetId: example.tweetId,
        url: example.url,
        text: example.text,
        author: { id: '7', name: example.author.name, handle: 'example' },
        media: [{ index: 1, type: 'photo' }],
      };
    if (scenario.value === 'no-media') tweet = { ...example, media: [] };
    const context: TemplateContext = {
      tweet,
      media: scope === 'textTemplate' ? undefined : tweet.media[0],
      extension: scope === 'textTemplate' ? undefined : 'jpg',
    };
    try {
      preview.textContent = renderTemplate(input.value, context) || t('options.guide.emptyResult');
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
