import {
  TEMPLATE_FIELDS,
  DATE_FORMATS,
  fieldsForScope,
  type TemplateContext,
  type TemplateScope,
} from './template-fields.js';
import { t } from '../shared/i18n.js';
export type { TemplateContext, TemplateScope } from './template-fields.js';
export { TEMPLATE_FIELDS, DATE_FORMATS, fieldsForScope } from './template-fields.js';

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}
const fields = new Map(TEMPLATE_FIELDS.map((field) => [field.name, field]));
const scopedFields = {
  filenameTemplate: new Set(fieldsForScope('filenameTemplate').map((field) => field.name)),
  frameTemplate: new Set(fieldsForScope('frameTemplate').map((field) => field.name)),
  textTemplate: new Set(fieldsForScope('textTemplate').map((field) => field.name)),
};

function validateScope(segments: readonly TemplateSegment[], scope: TemplateScope): void {
  for (const segment of segments) {
    if (segment.type === 'literal') continue;
    const name = segment.value.replace(/^[?/]/, '').split(/[|:]/, 1)[0];
    if (!fields.has(name)) throw new TemplateError(t('core.template.unknownField', { name }));
    if (!scopedFields[scope].has(name))
      throw new TemplateError(t(`core.template.forbidden.${scope}`, { name }));
  }
}

/** Validate allowed variables without reading tweet data or changing stored templates. */
export function validateTemplateScope(template: string, scope: TemplateScope): void {
  validateScope(parseTemplate(template), scope);
}

function valueFor(expression: string, context: TemplateContext, marker = true): string {
  const [formatted, ...defaults] = expression.split('|');
  if (defaults.length > 1) throw new TemplateError(t('core.template.defaultContainsPipe'));
  const separator = formatted.indexOf(':');
  const name = separator < 0 ? formatted : formatted.slice(0, separator);
  const format = separator < 0 ? undefined : formatted.slice(separator + 1);
  const field = fields.get(name);
  if (!field) throw new TemplateError(t('core.template.unknownField', { name }));
  if (
    format !== undefined &&
    (!field.date || !(DATE_FORMATS as readonly string[]).includes(format))
  )
    throw new TemplateError(t('core.template.unsupportedFormat', { format: formatted }));
  if (field.media && !context.media && !(name === 'media.index' && context.card))
    throw new TemplateError(t('core.template.needsMedia', { name }));
  const raw = field.read(context);
  if (marker && name === 'author.avatar' && context.avatarMarker) return context.avatarMarker;
  let value = raw === undefined ? '' : String(raw);
  if (value && format) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()))
      throw new TemplateError(t('core.template.invalidDate', { name }));
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
export function renderTemplate(
  template: string,
  context: TemplateContext,
  scope?: TemplateScope,
): string {
  const segments = parseTemplate(template);
  if (scope) validateScope(segments, scope);
  let condition: string | undefined;
  let visible = true;
  const result: string[] = [];
  for (const segment of segments) {
    if (segment.type === 'literal') {
      if (visible) result.push(segment.value);
      continue;
    }
    const expression = segment.value;
    if (expression.startsWith('?')) {
      if (condition !== undefined) throw new TemplateError(t('core.template.nestedOptional'));
      condition = expression.slice(1);
      if (!fields.has(condition))
        throw new TemplateError(t('core.template.unknownOptionalField', { name: condition }));
      visible = valueFor(condition, context, false) !== '';
    } else if (expression.startsWith('/')) {
      if (condition !== expression.slice(1))
        throw new TemplateError(t('core.template.optionalEndMismatch'));
      condition = undefined;
      visible = true;
    } else {
      const value = valueFor(expression, context);
      if (visible) result.push(value);
    }
  }
  if (condition !== undefined) throw new TemplateError(t('core.template.optionalUnclosed'));
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
      if (closeLiteral !== -1) throw new TemplateError(t('core.template.unmatchedClose'));
      if (cursor < template.length)
        segments.push({ type: 'literal', value: template.slice(cursor) });
      break;
    }
    if (closeLiteral !== -1 && closeLiteral < open) {
      throw new TemplateError(t('core.template.unmatchedClose'));
    }

    if (cursor < open) segments.push({ type: 'literal', value: template.slice(cursor, open) });
    const close = template.indexOf('}', open + 1);
    if (close === -1) throw new TemplateError(t('core.template.unmatchedOpen'));
    if (template.indexOf('{', open + 1) !== -1 && template.indexOf('{', open + 1) < close) {
      throw new TemplateError(t('core.template.nestedPlaceholder'));
    }

    segments.push({ type: 'placeholder', value: template.slice(open + 1, close) });
    cursor = close + 1;
  }

  return segments;
}
