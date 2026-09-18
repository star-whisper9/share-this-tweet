import { IMAGE_PALETTES, detectImageTheme } from '../core/image-theme.js';
import { readMp4SourceInWorker } from '../core/media-source-client.js';
import { mountTemplateGuide } from './template-guide.js';
import { buildMediaFilename } from '../core/filename.js';
import { renderTemplate } from '../core/template.js';
import {
  buildTweetText,
  getDefaultTextTemplate,
  isDefaultTextTemplate,
} from '../core/text-export.js';
import {
  clearStoredRecords,
  deleteStoredTweetRecord,
  exportStorageRecords,
  importStorageRecords,
  listStorageRecords,
} from '../core/storage-client.js';
import type { FrameOrientation } from '../core/frame.js';
import type { MediaRecord, TweetRecord } from '../shared/model.js';
import type { OutputRecord, StorageArchive, StoredTweetRecord } from '../shared/storage-model.js';
import type { MediaSourceMetadata } from '../shared/media-source.js';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveLanguage,
  saveSettings,
  watchLanguage,
  type ExtensionSettings,
} from '../shared/settings.js';
import { getLocale, localizeDocument, t, type LanguagePreference } from '../shared/i18n.js';

type SettingKey = 'filenameTemplate' | 'frameTemplate' | 'textTemplate';
type Tab = 'frame' | 'filename' | 'text' | 'records';
type SettingsTab = Exclude<Tab, 'records'>;
interface Preset {
  label: string;
  description: string;
  value?: string;
}
const keys: SettingKey[] = ['frameTemplate', 'filenameTemplate', 'textTemplate'];
const fieldTabs: Record<SettingKey, SettingsTab> = {
  frameTemplate: 'frame',
  filenameTemplate: 'filename',
  textTemplate: 'text',
};
const frameOrientations: FrameOrientation[] = ['top', 'bottom'];
const form = document.querySelector<HTMLFormElement>('[data-settings-form]');
const status = document.querySelector<HTMLOutputElement>('[data-status]');
const editable = document.querySelector<HTMLFieldSetElement>('[data-editable]');
const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
const resetButton = document.querySelector<HTMLButtonElement>('[data-reset]');
const confirmation = document.querySelector<HTMLElement>('[data-reset-confirm]');
const inputs = {
  filenameTemplate: document.querySelector<HTMLInputElement>('[data-setting="filenameTemplate"]'),
  frameTemplate: document.querySelector<HTMLTextAreaElement>('[data-setting="frameTemplate"]'),
  textTemplate: document.querySelector<HTMLTextAreaElement>('[data-setting="textTemplate"]'),
};
const previews = {
  filename: document.querySelector<HTMLElement>('[data-preview="filename"]'),
  frame: document.querySelector<HTMLElement>('[data-preview="frame"]'),
  text: document.querySelector<HTMLElement>('[data-preview="text"]'),
};
const recordSearch = document.querySelector<HTMLInputElement>('[data-record-search]');
const recordList = document.querySelector<HTMLElement>('[data-record-list]');
const recordSummary = document.querySelector<HTMLElement>('[data-record-summary]');
const recordEmpty = document.querySelector<HTMLElement>('[data-record-empty]');
const recordStatus = document.querySelector<HTMLOutputElement>('[data-record-status]');
const recordDetail = document.querySelector<HTMLElement>('[data-record-detail]');
const recordDetailEmpty = document.querySelector<HTMLElement>('[data-record-detail-empty]');
const recordImport = document.querySelector<HTMLInputElement>('[data-record-import]');
const sourceMediaInput = document.querySelector<HTMLInputElement>('[data-source-media-input]');
const sourceMediaDrop = document.querySelector<HTMLElement>('[data-source-media-drop]');
const sourceMediaStatus = document.querySelector<HTMLOutputElement>('[data-source-media-status]');
const sourceMediaResult = document.querySelector<HTMLElement>('[data-source-media-result]');
const languageSelect = document.querySelector<HTMLSelectElement>('[data-language]');
let storedTweetRecords: StoredTweetRecord[] = [];
let storedOutputRecords: OutputRecord[] = [];
let selectedRecordId = '';
let recordsLoading = false;
let sourceReadController: AbortController | undefined;
let displayedSource: { source: MediaSourceMetadata; filename: string } | undefined;
// The reader only inspects bounded MP4 boxes in its Worker, so it can accept
// larger local files than the background network-download path buffers.
const MAX_LOCAL_SOURCE_FILE_SIZE = 2 * 1024 * 1024 * 1024;
function sampleRecordForLocale(): TweetRecord {
  return {
    tweetId: '1234567890',
    url: 'https://x.com/example/status/1234567890',
    text: t('options.sample.body'),
    author: {
      id: '7',
      handle: '@example',
      name: t('core.field.example.author.name'),
      avatarUrl: '/icons/x.png',
    },
    publishedAt: '2026-09-07T10:00:00.000Z',
    media: [],
  };
}
const sampleMedia: MediaRecord = {
  index: 1,
  type: 'photo',
  originalUrl: 'https://pbs.twimg.com/media/example.jpg?format=jpg&name=orig',
};
function getPresets(): Record<SettingKey, Preset[]> {
  const locale = getLocale();
  const original = t('core.translation.original', {}, locale);
  return {
    frameTemplate: [
      {
        label: t('options.preset.frame.classic.label'),
        description: t('options.preset.frame.classic.description'),
        value: DEFAULT_SETTINGS.frameTemplate,
      },
      {
        label: t('options.preset.frame.avatar.label'),
        description: t('options.preset.frame.avatar.description'),
        value: '{author.avatar} {author.name}',
      },
      {
        label: t('options.preset.frame.handle.label'),
        description: t('options.preset.frame.handle.description'),
        value: '@{author.handle}',
      },
    ],
    filenameTemplate: [
      {
        label: t('options.preset.filename.account.label'),
        description: t('options.preset.filename.account.description'),
        value: DEFAULT_SETTINGS.filenameTemplate,
      },
      {
        label: t('options.preset.filename.date.label'),
        description: t('options.preset.filename.date.description'),
        value:
          '{tweet.publishedAt:YYYYMMDD|undated}_{author.handle}_{tweet.id}_{media.index}.{extension}',
      },
      {
        label: t('options.preset.filename.id.label'),
        description: t('options.preset.filename.id.description'),
        value: '{tweet.id}_{media.index}.{extension}',
      },
    ],
    textTemplate: [
      {
        label: t('options.preset.text.bilingual.label'),
        description: t('options.preset.text.bilingual.description'),
        value: getDefaultTextTemplate(locale),
      },
      {
        label: t('options.preset.text.simple.label'),
        description: t('options.preset.text.simple.description'),
        value: `{?translation.text}{translation.text}\n\n${original}\n{/translation.text}{translation.originalText}\n\n{tweet.url}`,
      },
      {
        label: t('options.preset.text.source.label'),
        description: t('options.preset.text.source.description'),
        value: '{author.name} (@{author.handle})\n{tweet.publishedAt:YYYY-MM-DD}\n{tweet.url}',
      },
      {
        label: t('options.preset.text.custom.label'),
        description: t('options.preset.text.custom.description'),
      },
    ],
  };
}
let presets = getPresets();
let baseline: ExtensionSettings = { ...DEFAULT_SETTINGS };
let ready = false;
let saving = false;
let languageSaving = false;
let dirty = false;
let invalidFields: SettingKey[] = [];

function setStatus(state: string, message: string): void {
  if (form) form.dataset.state = state;
  if (status) status.textContent = message;
}
function readSettings(): ExtensionSettings {
  const selectedOrientation = document.querySelector<HTMLButtonElement>(
    '[data-frame-orientation][aria-pressed="true"]',
  )?.dataset.frameOrientation;
  return {
    language: (languageSelect?.value as LanguagePreference) ?? baseline.language,
    filenameTemplate: inputs.filenameTemplate?.value ?? DEFAULT_SETTINGS.filenameTemplate,
    frameTemplate: inputs.frameTemplate?.value ?? DEFAULT_SETTINGS.frameTemplate,
    frameOrientation: frameOrientations.includes(selectedOrientation as FrameOrientation)
      ? (selectedOrientation as FrameOrientation)
      : DEFAULT_SETTINGS.frameOrientation,
    textTemplate: inputs.textTemplate?.value ?? DEFAULT_SETTINGS.textTemplate,
    stitchStyle:
      document.querySelector<HTMLButtonElement>('[data-stitch-style][aria-pressed="true"]')?.dataset
        .stitchStyle === 'gallery'
        ? 'gallery'
        : 'seamless',
  };
}
function setFrameOrientation(orientation: FrameOrientation): void {
  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-frame-orientation]'),
  )) {
    button.setAttribute('aria-pressed', String(button.dataset.frameOrientation === orientation));
  }
}
function activateTab(tab: Tab, focus = false): void {
  if (form) form.dataset.activeTab = tab;
  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]'),
  )) {
    const active = button.dataset.settingsTab === tab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  }
  for (const panel of Array.from(document.querySelectorAll<HTMLElement>('[data-panel]')))
    panel.hidden = panel.dataset.panel !== tab;
}
function setError(name: SettingKey, message: string): void {
  const error = document.querySelector<HTMLElement>(`[data-error="${name}"]`);
  if (error) error.textContent = message;
  inputs[name]?.setAttribute('aria-invalid', String(Boolean(message)));
  if (message) {
    const details = document.querySelector<HTMLDetailsElement>(`[data-editor="${name}"]`);
    if (details) details.open = true;
  }
}
function renderValue(name: SettingKey, value: string): string {
  const sampleRecord = sampleRecordForLocale();
  if (name === 'filenameTemplate') {
    if (!value.trim()) throw new Error(t('options.error.filenameEmpty'));
    return buildMediaFilename(sampleRecord, sampleMedia, value);
  }
  const output =
    name === 'frameTemplate'
      ? renderTemplate(value, { tweet: sampleRecord, media: sampleMedia, extension: 'png' })
      : buildTweetText(sampleRecord, value);
  if (!output.trim()) throw new Error(t('options.error.previewEmpty'));
  return name === 'frameTemplate'
    ? output.replace(sampleRecord.author.avatarUrl ?? '', t('options.preview.avatar'))
    : output;
}
function validateAndPreview(settings: ExtensionSettings): boolean {
  invalidFields = [];
  for (const name of keys) {
    setError(name, '');
    const preview = previews[fieldTabs[name]];
    try {
      if (preview) preview.textContent = renderValue(name, settings[name]);
    } catch (error) {
      invalidFields.push(name);
      setError(name, error instanceof Error ? error.message : String(error));
      if (preview) preview.textContent = t('options.status.previewFix');
    }
  }
  return invalidFields.length === 0;
}
function updatePresetSelection(settings: ExtensionSettings): void {
  for (const name of keys) {
    const choices = presets[name];
    const match = choices.findIndex(
      (item) => item.value !== undefined && item.value === settings[name],
    );
    const badge = document.querySelector<HTMLElement>(`[data-custom-badge="${name}"]`);
    if (badge) badge.hidden = match !== -1;
    const container = document.querySelector(`[data-presets="${name}"]`);
    container?.querySelectorAll<HTMLButtonElement>('[data-preset-index]').forEach((button) => {
      const index = Number(button.dataset.presetIndex);
      button.setAttribute(
        'aria-pressed',
        String(index === match || (match === -1 && choices[index]?.value === undefined)),
      );
    });
  }
}
function updateDraft(announce = true): void {
  for (const key of keys) inputs[key]?.dispatchEvent(new Event('templatechange'));
  const settings = readSettings();
  const valid = validateAndPreview(settings);
  dirty =
    keys.some((key) => settings[key] !== baseline[key]) ||
    settings.frameOrientation !== baseline.frameOrientation ||
    settings.stitchStyle !== baseline.stitchStyle;
  updatePresetSelection(settings);
  // Keep Save enabled for invalid drafts: submitting reveals and focuses the
  // first invalid field even if it is currently in another tab.
  if (submit) submit.disabled = !ready || saving || languageSaving || !dirty;
  if (announce && ready) {
    if (!valid) setStatus('error', t('options.status.invalid'));
    else if (dirty) setStatus('dirty', t('options.status.dirty'));
    else setStatus('saved', t('options.status.saved'));
  }
}
function writeSettings(settings: ExtensionSettings): void {
  for (const key of keys) if (inputs[key]) inputs[key]!.value = settings[key];
  setFrameOrientation(settings.frameOrientation);
  if (languageSelect) languageSelect.value = settings.language;
  for (const [attribute, value] of [['data-stitch-style', settings.stitchStyle]]) {
    for (const button of Array.from(document.querySelectorAll(`[${attribute}]`)))
      button.setAttribute('aria-pressed', String(button.getAttribute(attribute!) === value));
  }
  updateDraft();
}
function openEditor(name: SettingKey, focus = true): void {
  activateTab(fieldTabs[name]);
  const editor = document.querySelector<HTMLDetailsElement>(`[data-editor="${name}"]`);
  if (editor) editor.open = true;
  if (focus) inputs[name]?.focus();
}

function setRecordStatus(message: string): void {
  if (recordStatus) recordStatus.textContent = message;
}

function setSourceMediaStatus(message: string): void {
  if (sourceMediaStatus) sourceMediaStatus.textContent = message;
}

function verifiedSourceUrl(source: MediaSourceMetadata): string {
  const url = new URL(source.tweetUrl);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'x.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new RegExp(`^/(?:[A-Za-z0-9_]{1,15}|i)/status/${source.tweetId}$`).test(url.pathname)
  )
    throw new Error(t('options.records.invalidUrl'));
  return url.href;
}

function renderSourceMedia(source: MediaSourceMetadata, filename: string): void {
  displayedSource = { source, filename };
  const update = (selector: string, value: string): void => {
    const element = sourceMediaResult?.querySelector<HTMLElement>(selector);
    if (element) element.textContent = value;
  };
  update('[data-source-file]', filename);
  update('[data-source-publisher]', `${source.publisher.name} · ${source.publisher.handle}`);
  update('[data-source-tweet-id]', source.tweetId);
  update(
    '[data-source-media-kind]',
    t(
      source.media.type === 'animated_gif'
        ? 'options.records.source.kindGif'
        : 'options.records.source.kindVideo',
      { index: source.media.index },
    ),
  );
  update(
    '[data-source-published-at]',
    source.publishedAt ? formatRecordDate(source.publishedAt) : t('options.records.unknown'),
  );
  update('[data-source-tool]', `${source.tool.name} ${source.tool.version}`);
  const link = sourceMediaResult?.querySelector<HTMLAnchorElement>('[data-source-link]');
  if (link) link.href = verifiedSourceUrl(source);
  if (sourceMediaResult) sourceMediaResult.hidden = false;
}

async function readSourceMedia(file: File): Promise<void> {
  displayedSource = undefined;
  sourceReadController?.abort(new Error(t('options.source.cancelled')));
  const controller = new AbortController();
  sourceReadController = controller;
  if (sourceMediaResult) sourceMediaResult.hidden = true;
  if (file.size > MAX_LOCAL_SOURCE_FILE_SIZE) {
    setSourceMediaStatus(t('options.records.source.failedLarge'));
    if (sourceReadController === controller) sourceReadController = undefined;
    return;
  }
  setSourceMediaStatus(t('options.records.source.reading', { filename: file.name }));
  try {
    const source = await readMp4SourceInWorker(file, { signal: controller.signal });
    if (sourceReadController !== controller) return;
    if (!source) {
      setSourceMediaStatus(t('options.records.source.none'));
      return;
    }
    renderSourceMedia(source, file.name);
    setSourceMediaStatus(t('options.records.source.done'));
  } catch (error) {
    if (sourceReadController !== controller) return;
    setSourceMediaStatus(
      t('options.records.source.failed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    if (sourceReadController === controller) sourceReadController = undefined;
  }
}

function formatRecordDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getLocale());
}

function getRecordOutputs(tweetId: string): OutputRecord[] {
  return storedOutputRecords.filter((output) => output.tweetId === tweetId);
}

function recordMatches(record: StoredTweetRecord, query: string): boolean {
  if (!query) return true;
  const outputs = getRecordOutputs(record.tweetId);
  const haystack = [
    record.tweetId,
    record.url,
    record.text,
    record.author.handle,
    record.author.name,
    ...outputs.map((output) => output.filename ?? ''),
  ]
    .join('\n')
    .toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

function renderRecordDetail(): void {
  const record = storedTweetRecords.find((item) => item.tweetId === selectedRecordId);
  if (!record) {
    if (recordDetail) recordDetail.hidden = true;
    if (recordDetailEmpty) recordDetailEmpty.hidden = false;
    return;
  }
  if (recordDetail) recordDetail.hidden = false;
  if (recordDetailEmpty) recordDetailEmpty.hidden = true;
  const update = (selector: string, value: string): void => {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) element.textContent = value;
  };
  update(
    '[data-record-author]',
    record.author.name || record.author.handle || t('options.records.unknownAuthor'),
  );
  update(
    '[data-record-handle]',
    record.author.handle ? `@${record.author.handle.replace(/^@+/, '')}` : '',
  );
  update('[data-record-tweet-id]', record.tweetId);
  update('[data-record-saved-at]', formatRecordDate(record.savedAt));
  const link = document.querySelector<HTMLAnchorElement>('[data-record-link]');
  if (link) link.href = record.url;
  const quote = record.quote;
  update(
    '[data-record-text]',
    [
      record.text || t('options.records.noText'),
      quote
        ? [
            t('options.records.quote'),
            quote.record ? `${quote.record.author.name} · @${quote.record.author.handle}` : '',
            (quote.record?.text ?? quote.status === 'unavailable')
              ? t('options.records.quoteUnavailable')
              : t('options.records.quotePending'),
            quote.tweetId ? `https://x.com/i/status/${quote.tweetId}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  const outputs = getRecordOutputs(record.tweetId);
  const outputLabels: Record<string, string> = {
    'original-media': t('options.records.output.originalMedia'),
    'sourced-media': t('options.records.output.sourcedMedia'),
    'framed-image': t('options.records.output.framedImage'),
    'tweet-card': t('options.records.output.tweetCard'),
    'row-tweet-card': t('options.records.output.rowTweetCard'),
    'stitched-video': t('dynamic.stitchedVideo'),
    'framed-video': t('dynamic.framedVideo'),
    'stitched-image': t('options.records.output.stitchedImage'),
    'shared-text': t('options.records.output.sharedText'),
    'shared-image': t('options.records.output.sharedImage'),
    'copied-text': t('options.records.output.copiedText'),
  };
  update(
    '[data-record-output-summary]',
    outputs.length === 0
      ? t('options.records.noOutputs')
      : t('options.records.outputSummary', {
          count: outputs.length,
          outputs: outputs
            .map((output) => outputLabels[output.outputType] ?? output.outputType)
            .join(getLocale() === 'en' ? ', ' : '、'),
        }),
  );
  const outputList = document.querySelector<HTMLElement>('[data-record-output-list]');
  outputList?.replaceChildren();
  for (const output of outputs) {
    const item = document.createElement('div');
    item.className = 'record-output-item';
    const label = document.createElement('strong');
    label.textContent = outputLabels[output.outputType] ?? output.outputType;
    const detail = document.createElement('span');
    detail.textContent = [output.filename, formatRecordDate(output.createdAt)]
      .filter(Boolean)
      .join(' · ');
    item.append(label, detail);
    outputList?.append(item);
  }
}

function renderRecords(): void {
  const query = recordSearch?.value.trim() ?? '';
  const filtered = storedTweetRecords.filter((record) => recordMatches(record, query));
  if (recordSummary) {
    recordSummary.textContent = recordsLoading
      ? t('options.records.loading')
      : t('options.records.summary', { total: storedTweetRecords.length, shown: filtered.length });
  }
  if (recordList) recordList.replaceChildren();
  if (filtered.length === 0) {
    if (recordEmpty) recordEmpty.hidden = false;
  } else {
    if (recordEmpty) recordEmpty.hidden = true;
    if (!filtered.some((record) => record.tweetId === selectedRecordId)) {
      selectedRecordId = filtered[0]!.tweetId;
    }
    for (const record of filtered) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'record-item';
      button.setAttribute('role', 'listitem');
      button.setAttribute('aria-pressed', String(record.tweetId === selectedRecordId));
      const title = document.createElement('strong');
      title.textContent = `${record.author.name || t('options.records.unknownAuthor')} · ${record.author.handle ? `@${record.author.handle.replace(/^@+/, '')}` : t('options.records.unknownHandle')}`;
      const meta = document.createElement('span');
      meta.textContent = `${record.tweetId} · ${formatRecordDate(record.savedAt)} · ${t('options.records.outputs', { count: getRecordOutputs(record.tweetId).length })}`;
      button.append(title, meta);
      button.addEventListener('click', () => {
        selectedRecordId = record.tweetId;
        renderRecords();
      });
      recordList?.append(button);
    }
  }
  renderRecordDetail();
}

async function loadRecords(): Promise<void> {
  recordsLoading = true;
  renderRecords();
  try {
    const records = await listStorageRecords();
    storedTweetRecords = records.tweetRecords;
    storedOutputRecords = records.outputRecords;
    setRecordStatus('');
  } catch (error) {
    storedTweetRecords = [];
    storedOutputRecords = [];
    setRecordStatus(
      t('options.records.source.failed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    recordsLoading = false;
    renderRecords();
  }
}

function downloadJsonArchive(archive: StorageArchive): void {
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `share-this-tweet-records-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportRecords(): Promise<void> {
  try {
    downloadJsonArchive(await exportStorageRecords());
    setRecordStatus(t('options.records.exported'));
  } catch (error) {
    setRecordStatus(
      t('options.records.exportFailed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function importRecords(file: File): Promise<void> {
  try {
    const archive = JSON.parse(await file.text()) as StorageArchive;
    await importStorageRecords(archive);
    selectedRecordId = '';
    setRecordStatus(t('options.records.imported'));
    await loadRecords();
  } catch (error) {
    setRecordStatus(
      t('options.records.importFailed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function deleteSelectedRecord(): Promise<void> {
  if (!selectedRecordId || !window.confirm(t('options.records.deleteConfirm'))) return;
  try {
    await deleteStoredTweetRecord(selectedRecordId);
    selectedRecordId = '';
    setRecordStatus(t('options.records.deleted'));
    await loadRecords();
  } catch (error) {
    setRecordStatus(
      t('options.records.deleteFailed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function clearRecords(): Promise<void> {
  if (!window.confirm(t('options.records.clearConfirm'))) return;
  try {
    await clearStoredRecords();
    selectedRecordId = '';
    setRecordStatus(t('options.records.cleared'));
    await loadRecords();
  } catch (error) {
    setRecordStatus(
      t('options.records.clearFailed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function buildControls(): void {
  for (const name of keys) {
    const container = document.querySelector(`[data-presets="${name}"]`);
    container?.replaceChildren();
    presets[name].forEach((preset, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset';
      button.dataset.presetIndex = String(index);
      button.setAttribute('aria-pressed', 'false');
      const check = document.createElement('span');
      check.className = 'preset-check';
      check.setAttribute('aria-hidden', 'true');
      const label = document.createElement('strong');
      label.textContent = preset.label;
      const description = document.createElement('small');
      description.textContent = preset.description;
      button.append(check, label, description);
      if (preset.value !== undefined) {
        // An incompatible preset is unavailable, rather than silently changing
        // the project's template grammar.
        try {
          renderValue(name, preset.value);
        } catch {
          button.disabled = true;
          description.textContent = t('options.preset.unsupported');
        }
      }
      button.addEventListener('click', () => {
        if (!ready || saving) return;
        if (preset.value === undefined) {
          openEditor(name);
          return;
        }
        if (inputs[name]) inputs[name]!.value = preset.value;
        updateDraft();
      });
      container?.append(button);
    });
    const tokenContainer = document.querySelector<HTMLElement>(`[data-tokens="${name}"]`);
    const input = inputs[name];
    if (tokenContainer && input)
      mountTemplateGuide(tokenContainer, input, name, () => ready && !saving, updateDraft);
  }
}

function refreshLocalizedUi(): void {
  const textTemplate = inputs.textTemplate;
  if (
    textTemplate &&
    textTemplate.value === baseline.textTemplate &&
    isDefaultTextTemplate(textTemplate.value)
  ) {
    const localizedDefault = getDefaultTextTemplate(getLocale());
    textTemplate.value = localizedDefault;
    baseline = { ...baseline, textTemplate: localizedDefault };
  }
  localizeDocument();
  presets = getPresets();
  buildControls();
  const settings = readSettings();
  validateAndPreview(settings);
  updatePresetSelection(settings);
  renderRecords();
  if (displayedSource && !sourceMediaResult?.hidden)
    renderSourceMedia(displayedSource.source, displayedSource.filename);
  if (ready && !saving && form?.dataset.state !== 'error') updateDraft();
}
for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]'))) {
  tab.addEventListener('click', () => activateTab(tab.dataset.settingsTab as Tab));
  tab.addEventListener('keydown', (event: KeyboardEvent) => {
    const order: Tab[] = ['frame', 'filename', 'text', 'records'];
    let index = order.indexOf(tab.dataset.settingsTab as Tab);
    if (event.key === 'ArrowRight') index = (index + 1) % order.length;
    else if (event.key === 'ArrowLeft') index = (index + order.length - 1) % order.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = order.length - 1;
    else return;
    event.preventDefault();
    activateTab(order[index]!, true);
  });
}
for (const button of Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-frame-orientation]'),
)) {
  button.addEventListener('click', () => {
    const orientation = button.dataset.frameOrientation;
    if (!ready || saving || !frameOrientations.includes(orientation as FrameOrientation)) return;
    setFrameOrientation(orientation as FrameOrientation);
    updateDraft();
  });
}
for (const attribute of ['data-stitch-style']) {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>(`[${attribute}]`))) {
    button.addEventListener('click', () => {
      if (!ready || saving) return;
      for (const item of Array.from(document.querySelectorAll(`[${attribute}]`)))
        item.setAttribute('aria-pressed', String(item === button));
      updateDraft();
    });
  }
}
for (const input of Object.values(inputs)) input?.addEventListener('input', () => updateDraft());
languageSelect?.addEventListener('change', () => {
  const language = languageSelect.value as LanguagePreference;
  if (!ready || saving || languageSaving) return;
  const previousLanguage = baseline.language;
  languageSaving = true;
  languageSelect.disabled = true;
  if (submit) submit.disabled = true;
  void saveLanguage(language)
    .then(() => {
      baseline = { ...baseline, language };
      refreshLocalizedUi();
      updateDraft(false);
    })
    .catch((error) => {
      languageSelect.value = previousLanguage;
      setStatus(
        'error',
        t('common.language.error', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    })
    .finally(() => {
      languageSaving = false;
      languageSelect.disabled = false;
      updateDraft(false);
    });
});
recordSearch?.addEventListener('input', () => renderRecords());
document.querySelector('[data-record-refresh]')?.addEventListener('click', () => {
  void loadRecords();
});
document.querySelector('[data-record-export]')?.addEventListener('click', () => {
  void exportRecords();
});
document.querySelector('[data-record-import-button]')?.addEventListener('click', () => {
  recordImport?.click();
});
recordImport?.addEventListener('change', () => {
  const file = recordImport.files?.[0];
  recordImport.value = '';
  if (file) void importRecords(file);
});
sourceMediaInput?.addEventListener('change', () => {
  const file = sourceMediaInput.files?.[0];
  sourceMediaInput.value = '';
  if (file) void readSourceMedia(file);
});
sourceMediaDrop?.addEventListener('click', () => sourceMediaInput?.click());
sourceMediaDrop?.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  sourceMediaInput?.click();
});
for (const type of ['dragenter', 'dragover'] as const)
  sourceMediaDrop?.addEventListener(type, (event: DragEvent) => {
    event.preventDefault();
    if (sourceMediaDrop) sourceMediaDrop.dataset.dragging = 'true';
  });
for (const type of ['dragleave', 'drop'] as const)
  sourceMediaDrop?.addEventListener(type, (event: DragEvent) => {
    event.preventDefault();
    if (sourceMediaDrop) delete sourceMediaDrop.dataset.dragging;
    if (type === 'drop') {
      const file = event.dataTransfer?.files[0];
      if (file) void readSourceMedia(file);
    }
  });
document.querySelector('[data-record-delete]')?.addEventListener('click', () => {
  void deleteSelectedRecord();
});
document.querySelector('[data-record-clear]')?.addEventListener('click', () => {
  void clearRecords();
});
resetButton?.addEventListener('click', () => {
  if (!ready || saving || !confirmation) return;
  confirmation.hidden = false;
  document.querySelector<HTMLButtonElement>('[data-reset-cancel]')?.focus();
});
document.querySelector('[data-reset-cancel]')?.addEventListener('click', () => {
  if (confirmation) confirmation.hidden = true;
  resetButton?.focus();
});
document.querySelector('[data-reset-confirm-button]')?.addEventListener('click', () => {
  if (!ready || saving) return;
  if (confirmation) confirmation.hidden = true;
  writeSettings({
    ...DEFAULT_SETTINGS,
    language: baseline.language,
    textTemplate: getDefaultTextTemplate(getLocale()),
  });
  setStatus(
    dirty ? 'dirty' : 'saved',
    dirty ? t('options.status.resetDirty') : t('options.status.resetCurrent'),
  );
  resetButton?.focus();
});
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (form.dataset.activeTab === 'records') return;
  if (!ready || saving || languageSaving || !dirty) return;
  const settings = readSettings();
  if (!validateAndPreview(settings)) {
    setStatus('error', t('options.status.fixFirst'));
    if (invalidFields[0]) openEditor(invalidFields[0]);
    return;
  }
  saving = true;
  if (editable) editable.disabled = true;
  if (submit) submit.disabled = true;
  if (resetButton) resetButton.disabled = true;
  if (confirmation) confirmation.hidden = true;
  setStatus('saving', t('options.status.saving'));
  try {
    await saveSettings(settings);
    baseline = { ...settings };
    updateDraft(false);
    setStatus('saved', t('options.status.savedApply'));
  } catch (error) {
    setStatus(
      'error',
      t('options.status.saveFailed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    saving = false;
    if (editable) editable.disabled = false;
    if (resetButton) resetButton.disabled = false;
    if (submit) submit.disabled = !dirty;
  }
});
window.addEventListener('beforeunload', (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
async function initialize(): Promise<void> {
  ready = false;
  if (editable) editable.disabled = true;
  if (languageSelect) languageSelect.disabled = true;
  if (resetButton) resetButton.disabled = true;
  if (submit) submit.disabled = true;
  const banner = document.querySelector<HTMLElement>('[data-load-error]');
  const retry = document.querySelector<HTMLButtonElement>('[data-retry-load]');
  if (retry) retry.disabled = true;
  if (banner) banner.hidden = true;
  setStatus('loading', t('options.status.loading'));
  try {
    const settings = await loadSettings();
    baseline = { ...settings };
    ready = true;
    refreshLocalizedUi();
    writeSettings(settings);
    if (editable) editable.disabled = false;
    if (resetButton) resetButton.disabled = false;
    for (const key of keys) {
      if (!presets[key].some((item) => item.value === settings[key])) {
        const details = document.querySelector<HTMLDetailsElement>(`[data-editor="${key}"]`);
        if (details) details.open = true;
      }
    }
  } catch (error) {
    const message = document.querySelector<HTMLElement>('[data-load-message]');
    if (message)
      message.textContent = t('options.status.loadProtected', {
        message: error instanceof Error ? error.message : String(error),
      });
    if (banner) banner.hidden = false;
    setStatus('error', t('options.status.readFailed'));
  } finally {
    if (retry) retry.disabled = false;
    if (languageSelect) languageSelect.disabled = !ready || languageSaving;
  }
}
localizeDocument();
buildControls();
writeSettings({ ...DEFAULT_SETTINGS });
renderRecords();
document.querySelector('[data-retry-load]')?.addEventListener('click', () => {
  void initialize();
});
void initialize();
void loadRecords();
const unwatchLanguage = watchLanguage((language) => {
  if (languageSelect) languageSelect.value = language;
  baseline = { ...baseline, language };
  refreshLocalizedUi();
  if (ready) updateDraft(false);
});

window.addEventListener('pagehide', unwatchLanguage, { once: true });

function updateFramePreviewTheme(): void {
  const preview = document.querySelector<HTMLElement>('.print-caption');
  if (!preview) return;
  const palette = IMAGE_PALETTES[detectImageTheme()];
  preview.style.backgroundColor = palette.background;
  preview.style.color = palette.text;
  preview.style.setProperty('--frame-preview-muted', palette.muted);
  preview.style.setProperty('--frame-preview-border', palette.border);
}
updateFramePreviewTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateFramePreviewTheme);
