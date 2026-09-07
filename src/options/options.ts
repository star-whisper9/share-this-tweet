import { buildMediaFilename } from '../core/filename.js';
import { renderTemplate } from '../core/template.js';
import { buildTweetText } from '../core/text-export.js';
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
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type ExtensionSettings,
} from '../shared/settings.js';

// Intentionally keeps the existing settings shape and template engine.
// Text variables are discovered from DEFAULT_SETTINGS, not an assumed grammar.
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
  frameTemplate: document.querySelector<HTMLInputElement>('[data-setting="frameTemplate"]'),
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
let storedTweetRecords: StoredTweetRecord[] = [];
let storedOutputRecords: OutputRecord[] = [];
let selectedRecordId = '';
let recordsLoading = false;
const sampleRecord: TweetRecord = {
  tweetId: '1234567890',
  url: 'https://x.com/example/status/1234567890',
  text: '把路上的光，留给每一个平常的日子。\n今天也有值得分享的小事。',
  author: { id: '7', handle: '@example', name: '晴日来信', avatarUrl: '/icons/x.png' },
  publishedAt: '2026-09-07T10:00:00.000Z',
  media: [],
};
const sampleMedia: MediaRecord = {
  index: 1,
  type: 'photo',
  originalUrl: 'https://pbs.twimg.com/media/example.jpg?format=jpg&name=orig',
};
const presets: Record<SettingKey, Preset[]> = {
  frameTemplate: [
    { label: '经典署名', description: '左侧显示作者名称', value: DEFAULT_SETTINGS.frameTemplate },
    { label: '标记出处', description: '左侧显示来源文字和账号', value: '来源：{author.handle}' },
    { label: '仅账号', description: '左侧显示推主账号', value: '{author.handle}' },
  ],
  filenameTemplate: [
    { label: '完整信息', description: '使用默认规则', value: DEFAULT_SETTINGS.filenameTemplate },
    {
      label: '简洁命名',
      description: '账号 + 编号',
      value: 'X_{author.handle}_{tweet.id}_{media.index}.{extension}',
    },
    {
      label: '仅编号',
      description: '推文 ID + 序号',
      value: '{tweet.id}_{media.index}.{extension}',
    },
  ],
  textTemplate: [
    { label: '正文与来源', description: '沿用完整默认模板', value: DEFAULT_SETTINGS.textTemplate },
    { label: '我的排版', description: '自己安排文字与出处' },
  ],
};
let baseline: ExtensionSettings = { ...DEFAULT_SETTINGS };
let ready = false;
let saving = false;
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
    filenameTemplate: inputs.filenameTemplate?.value ?? DEFAULT_SETTINGS.filenameTemplate,
    frameTemplate: inputs.frameTemplate?.value ?? DEFAULT_SETTINGS.frameTemplate,
    frameOrientation: frameOrientations.includes(selectedOrientation as FrameOrientation)
      ? (selectedOrientation as FrameOrientation)
      : DEFAULT_SETTINGS.frameOrientation,
    textTemplate: inputs.textTemplate?.value ?? DEFAULT_SETTINGS.textTemplate,
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
  if (name === 'filenameTemplate') {
    if (!value.trim()) throw new Error('文件名不能为空，请选择一种命名方式或填写模板。');
    return buildMediaFilename(sampleRecord, sampleMedia, value);
  }
  const output =
    name === 'frameTemplate'
      ? renderTemplate(value, { tweet: sampleRecord, media: sampleMedia, extension: 'png' })
      : buildTweetText(sampleRecord, value);
  if (!output.trim()) throw new Error('预览内容为空，请至少保留文字或一个变量。');
  return name === 'frameTemplate'
    ? output.replace(sampleRecord.author.avatarUrl ?? '', '作者头像')
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
      if (preview) preview.textContent = '修正模板后，这里会显示预览。';
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
  const settings = readSettings();
  const valid = validateAndPreview(settings);
  dirty =
    keys.some((key) => settings[key] !== baseline[key]) ||
    settings.frameOrientation !== baseline.frameOrientation;
  updatePresetSelection(settings);
  // Keep Save enabled for invalid drafts: submitting reveals and focuses the
  // first invalid field even if it is currently in another tab.
  if (submit) submit.disabled = !ready || saving || !dirty;
  if (announce && ready) {
    if (!valid) setStatus('error', '有一处模板需要检查');
    else if (dirty) setStatus('dirty', '有尚未保存的更改');
    else setStatus('saved', '偏好已保存');
  }
}
function writeSettings(settings: ExtensionSettings): void {
  for (const key of keys) if (inputs[key]) inputs[key]!.value = settings[key];
  setFrameOrientation(settings.frameOrientation);
  updateDraft();
}
function openEditor(name: SettingKey, focus = true): void {
  activateTab(fieldTabs[name]);
  const editor = document.querySelector<HTMLDetailsElement>(`[data-editor="${name}"]`);
  if (editor) editor.open = true;
  if (focus) inputs[name]?.focus();
}
function tokenLabel(token: string): string {
  const labels: Record<string, string> = {
    '{author.name}': '作者昵称',
    '{author.handle}': '推主账号',
    '{author.id}': '推主 ID',
    '{author.avatar}': '作者头像',
    '{tweet.id}': '推文 ID',
    '{tweet.text}': '推文正文',
    '{tweet.url}': '原文链接',
    '{text}': '推文正文',
    '{url}': '原文链接',
    '{tweetId}': '推文 ID',
    '{media.index}': '媒体序号',
    '{extension}': '扩展名',
  };
  return labels[token] ?? token;
}

function setRecordStatus(message: string): void {
  if (recordStatus) recordStatus.textContent = message;
}

function formatRecordDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
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
  update('[data-record-author]', record.author.name || record.author.handle || '未知作者');
  update(
    '[data-record-handle]',
    record.author.handle ? `@${record.author.handle.replace(/^@+/, '')}` : '',
  );
  update('[data-record-tweet-id]', record.tweetId);
  update('[data-record-saved-at]', formatRecordDate(record.savedAt));
  const link = document.querySelector<HTMLAnchorElement>('[data-record-link]');
  if (link) link.href = record.url;
  update('[data-record-text]', record.text || '这条推文没有正文。');
  const outputs = getRecordOutputs(record.tweetId);
  const outputLabels: Record<string, string> = {
    'original-media': '原始媒体',
    'framed-image': '来源画框',
    'tweet-card': '推文卡片',
    'shared-text': '分享文本',
    'shared-image': '分享图像',
    'copied-text': '复制文本',
  };
  update(
    '[data-record-output-summary]',
    outputs.length === 0
      ? '尚无输出记录。'
      : `已记录 ${outputs.length} 次输出：${outputs.map((output) => outputLabels[output.outputType] ?? output.outputType).join('、')}`,
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
      ? '正在读取来源记录…'
      : `共 ${storedTweetRecords.length} 条推文记录，当前显示 ${filtered.length} 条`;
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
      title.textContent = `${record.author.name || '未知作者'} · ${record.author.handle ? `@${record.author.handle.replace(/^@+/, '')}` : '未知账号'}`;
      const meta = document.createElement('span');
      meta.textContent = `${record.tweetId} · ${formatRecordDate(record.savedAt)} · ${getRecordOutputs(record.tweetId).length} 条输出`;
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
    setRecordStatus(`读取失败：${error instanceof Error ? error.message : String(error)}`);
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
    setRecordStatus('来源记录已导出。');
  } catch (error) {
    setRecordStatus(`导出失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function importRecords(file: File): Promise<void> {
  try {
    const archive = JSON.parse(await file.text()) as StorageArchive;
    await importStorageRecords(archive);
    selectedRecordId = '';
    setRecordStatus('来源记录已导入。');
    await loadRecords();
  } catch (error) {
    setRecordStatus(`导入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function deleteSelectedRecord(): Promise<void> {
  if (!selectedRecordId || !window.confirm('删除这条来源记录及其输出记录？')) return;
  try {
    await deleteStoredTweetRecord(selectedRecordId);
    selectedRecordId = '';
    setRecordStatus('来源记录已删除。');
    await loadRecords();
  } catch (error) {
    setRecordStatus(`删除失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function clearRecords(): Promise<void> {
  if (!window.confirm('清空全部来源记录和输出记录？已保存到设备的媒体文件不会被删除。')) return;
  try {
    await clearStoredRecords();
    selectedRecordId = '';
    setRecordStatus('来源记录已清空。');
    await loadRecords();
  } catch (error) {
    setRecordStatus(`清空失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildControls(): void {
  for (const name of keys) {
    const container = document.querySelector(`[data-presets="${name}"]`);
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
          description.textContent = '当前模板引擎不支持';
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
    const discovered = DEFAULT_SETTINGS[name].match(/\{[^{}]+\}/g) ?? [];
    const extras =
      name === 'filenameTemplate'
        ? ['{author.handle}', '{tweet.id}', '{media.index}', '{extension}']
        : name === 'frameTemplate'
          ? ['{author.handle}', '{author.avatar}']
          : [];
    const tokenContainer = document.querySelector(`[data-tokens="${name}"]`);
    for (const token of new Set([...discovered, ...extras])) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'token';
      button.textContent = `+ ${tokenLabel(token)}`;
      button.title = token;
      button.setAttribute('aria-label', `插入${tokenLabel(token)} ${token}`);
      button.addEventListener('click', () => {
        const input = inputs[name];
        if (!input || !ready || saving) return;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.setRangeText(token, start, end, 'end');
        input.focus();
        updateDraft();
      });
      tokenContainer?.append(button);
    }
  }
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
for (const input of Object.values(inputs)) input?.addEventListener('input', () => updateDraft());
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
  writeSettings({ ...DEFAULT_SETTINGS });
  setStatus(dirty ? 'dirty' : 'saved', dirty ? '已恢复默认，保存后生效' : '当前已经是默认偏好');
  resetButton?.focus();
});
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (form.dataset.activeTab === 'records') return;
  if (!ready || saving || !dirty) return;
  const settings = readSettings();
  if (!validateAndPreview(settings)) {
    setStatus('error', '请先修正标出的模板');
    if (invalidFields[0]) openEditor(invalidFields[0]);
    return;
  }
  saving = true;
  if (editable) editable.disabled = true;
  if (submit) submit.disabled = true;
  if (resetButton) resetButton.disabled = true;
  if (confirmation) confirmation.hidden = true;
  setStatus('saving', '正在保存偏好…');
  try {
    await saveSettings(settings);
    baseline = { ...settings };
    updateDraft(false);
    setStatus('saved', '已保存，重新打开分享面板时生效');
  } catch (error) {
    setStatus('error', `未能保存：${error instanceof Error ? error.message : String(error)}`);
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
  if (resetButton) resetButton.disabled = true;
  if (submit) submit.disabled = true;
  const banner = document.querySelector<HTMLElement>('[data-load-error]');
  const retry = document.querySelector<HTMLButtonElement>('[data-retry-load]');
  if (retry) retry.disabled = true;
  if (banner) banner.hidden = true;
  setStatus('loading', '正在读取偏好…');
  try {
    const settings = await loadSettings();
    baseline = { ...settings };
    ready = true;
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
      message.textContent = `无法读取现有偏好，已暂停保存以免覆盖。${error instanceof Error ? error.message : String(error)}`;
    if (banner) banner.hidden = false;
    setStatus('error', '读取失败，请重试');
  } finally {
    if (retry) retry.disabled = false;
  }
}
buildControls();
writeSettings({ ...DEFAULT_SETTINGS });
renderRecords();
document.querySelector('[data-retry-load]')?.addEventListener('click', () => {
  void initialize();
});
void initialize();
void loadRecords();
