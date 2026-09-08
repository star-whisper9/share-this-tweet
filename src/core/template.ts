import { TEMPLATE_FIELDS, DATE_FORMATS, type TemplateContext } from './template-fields.js';
export type { TemplateContext } from './template-fields.js';
export { TEMPLATE_FIELDS, DATE_FORMATS, fieldsForScope } from './template-fields.js';

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}
const fields = new Map(TEMPLATE_FIELDS.map((field) => [field.name, field]));

function valueFor(expression: string, context: TemplateContext, marker = true): string {
  const [formatted, ...defaults] = expression.split('|');
  if (defaults.length > 1) throw new TemplateError('默认值不能包含 |');
  const separator = formatted.indexOf(':');
  const name = separator < 0 ? formatted : formatted.slice(0, separator);
  const format = separator < 0 ? undefined : formatted.slice(separator + 1);
  const field = fields.get(name);
  if (!field) throw new TemplateError(`未知模板字段：{${name}}`);
  if (
    format !== undefined &&
    (!field.date || !(DATE_FORMATS as readonly string[]).includes(format))
  )
    throw new TemplateError(`不支持的模板格式：{${formatted}}`);
  if (field.media && !context.media && !(name === 'media.index' && context.card))
    throw new TemplateError(`模板字段需要媒体上下文：{${name}}`);
  const raw = field.read(context);
  if (marker && name === 'author.avatar' && context.avatarMarker) return context.avatarMarker;
  let value = raw === undefined ? '' : String(raw);
  if (value && format) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TemplateError(`日期字段无法格式化：{${name}}`);
    const iso = date.toISOString();
    value =
      format === 'YYYYMMDD'
        ? iso.slice(0, 10).replace(/-/g, '')
        : format === 'YYYY-MM-DD'
          ? iso.slice(0, 10)
          : iso.slice(0, 19).replace('T', ' ');
  }
  return value || defaults[0] || '';
}

/** Optional blocks are deliberately non-nesting and never evaluate JavaScript. */
export function renderTemplate(template: string, context: TemplateContext): string {
  let condition: string | undefined;
  let visible = true;
  const result: string[] = [];
  for (const segment of parseTemplate(template)) {
    if (segment.type === 'literal') {
      if (visible) result.push(segment.value);
      continue;
    }
    const expression = segment.value;
    if (expression.startsWith('?')) {
      if (condition !== undefined) throw new TemplateError('可选区块不能嵌套');
      condition = expression.slice(1);
      if (!fields.has(condition)) throw new TemplateError(`未知区块字段：${condition}`);
      visible = valueFor(condition, context, false) !== '';
    } else if (expression.startsWith('/')) {
      if (condition !== expression.slice(1)) throw new TemplateError('可选区块结束标记不匹配');
      condition = undefined;
      visible = true;
    } else {
      const value = valueFor(expression, context);
      if (visible) result.push(value);
    }
  }
  if (condition !== undefined) throw new TemplateError('可选区块缺少结束标记');
  return result.join('');
}

export interface TemplateSegment {
  type: 'literal' | 'placeholder';
  value: string;
}

export function parseTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf('{', cursor);
    const closeLiteral = template.indexOf('}', cursor);
    if (open === -1) {
      if (closeLiteral !== -1) throw new TemplateError('模板包含未匹配的 }');
      if (cursor < template.length)
        segments.push({ type: 'literal', value: template.slice(cursor) });
      break;
    }
    if (closeLiteral !== -1 && closeLiteral < open) {
      throw new TemplateError('模板包含未匹配的 }');
    }

    if (cursor < open) segments.push({ type: 'literal', value: template.slice(cursor, open) });
    const close = template.indexOf('}', open + 1);
    if (close === -1) throw new TemplateError('模板包含未匹配的 {');
    if (template.indexOf('{', open + 1) !== -1 && template.indexOf('{', open + 1) < close) {
      throw new TemplateError('模板占位符不能嵌套');
    }

    segments.push({ type: 'placeholder', value: template.slice(open + 1, close) });
    cursor = close + 1;
  }

  return segments;
}
