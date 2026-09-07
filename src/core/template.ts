import type { MediaRecord, TweetRecord } from '../shared/model.js';

export interface TemplateContext {
  tweet: TweetRecord;
  media: MediaRecord;
  extension: string;
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

type TemplateValue = keyof {
  'tweet.id': string;
  'tweet.url': string;
  'tweet.text': string;
  'tweet.publishedAt': string;
  'author.id': string;
  'author.handle': string;
  'author.name': string;
  'media.index': string;
  'media.type': string;
  extension: string;
};

function getTemplateValue(field: string, context: TemplateContext): string {
  switch (field as TemplateValue) {
    case 'tweet.id':
      return context.tweet.tweetId;
    case 'tweet.url':
      return context.tweet.url;
    case 'tweet.text':
      return context.tweet.text;
    case 'tweet.publishedAt':
      return context.tweet.publishedAt ?? '';
    case 'author.id':
      return context.tweet.author.id;
    case 'author.handle':
      return context.tweet.author.handle.replace(/^@+/, '');
    case 'author.name':
      return context.tweet.author.name;
    case 'media.index':
      return String(context.media.index);
    case 'media.type':
      return context.media.type;
    case 'extension':
      return context.extension;
    default:
      throw new TemplateError(`未知模板字段：{${field}}`);
  }
}

function formatTemplateValue(field: string, format: string | undefined, context: TemplateContext): string {
  const value = getTemplateValue(field, context);
  if (!format) {
    if (value.length === 0) throw new TemplateError(`模板字段没有可用值：{${field}}`);
    return value;
  }

  if (field !== 'tweet.publishedAt' || format !== 'YYYY-MM-DD') {
    throw new TemplateError(`不支持的模板格式：{${field}:${format}}`);
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new TemplateError(`日期字段无法格式化：{${field}:${format}}`);
  const date = new Date(timestamp);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

function renderPlaceholder(placeholder: string, context: TemplateContext): string {
  const separator = placeholder.indexOf(':');
  const field = separator === -1 ? placeholder : placeholder.slice(0, separator);
  const format = separator === -1 ? undefined : placeholder.slice(separator + 1);
  if (field.length === 0 || format === '') throw new TemplateError('模板占位符不能为空');
  return formatTemplateValue(field, format, context);
}

export function renderTemplate(template: string, context: TemplateContext): string {
  let output = '';
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf('{', cursor);
    const closeLiteral = template.indexOf('}', cursor);
    if (open === -1) {
      if (closeLiteral !== -1) throw new TemplateError('模板包含未匹配的 }');
      output += template.slice(cursor);
      break;
    }
    if (closeLiteral !== -1 && closeLiteral < open) {
      throw new TemplateError('模板包含未匹配的 }');
    }

    output += template.slice(cursor, open);
    const close = template.indexOf('}', open + 1);
    if (close === -1) throw new TemplateError('模板包含未匹配的 {');
    if (template.indexOf('{', open + 1) !== -1 && template.indexOf('{', open + 1) < close) {
      throw new TemplateError('模板占位符不能嵌套');
    }

    output += renderPlaceholder(template.slice(open + 1, close), context);
    cursor = close + 1;
  }

  return output;
}
