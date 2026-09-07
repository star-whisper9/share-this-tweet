import { buildMediaFilename } from '../core/filename.js';
import { renderTemplate } from '../core/template.js';
import { buildTweetText } from '../core/text-export.js';
import type { FrameOrientation } from '../core/frame.js';
import type { MediaRecord, TweetRecord } from '../shared/model.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type ExtensionSettings } from '../shared/settings.js';

// Intentionally keeps the existing settings shape and template engine.
// Text variables are discovered from DEFAULT_SETTINGS, not an assumed grammar.
type SettingKey = 'filenameTemplate' | 'frameTemplate' | 'textTemplate';
type Tab = 'frame' | 'filename' | 'text';
interface Preset { label: string; description: string; value?: string }
const keys: SettingKey[] = ['frameTemplate', 'filenameTemplate', 'textTemplate'];
const fieldTabs: Record<SettingKey, Tab> = { frameTemplate: 'frame', filenameTemplate: 'filename', textTemplate: 'text' };
const frameOrientations: FrameOrientation[] = ['top', 'bottom', 'left', 'right'];
const form = document.querySelector<HTMLFormElement>('[data-settings-form]');
const status = document.querySelector<HTMLOutputElement>('[data-status]');
const editable = document.querySelector<HTMLFieldSetElement>('[data-editable]');
const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
const resetButton = document.querySelector<HTMLButtonElement>('[data-reset]');
const confirmation = document.querySelector<HTMLElement>('[data-reset-confirm]');
const inputs = {
  filenameTemplate: document.querySelector<HTMLInputElement>('[data-setting="filenameTemplate"]'),
  frameTemplate: document.querySelector<HTMLInputElement>('[data-setting="frameTemplate"]'),
  textTemplate: document.querySelector<HTMLTextAreaElement>('[data-setting="textTemplate"]')
};
const previews = {
  filename: document.querySelector<HTMLElement>('[data-preview="filename"]'),
  frame: document.querySelector<HTMLElement>('[data-preview="frame"]'),
  text: document.querySelector<HTMLElement>('[data-preview="text"]')
};
const sampleRecord: TweetRecord = {
  tweetId: '1234567890', url: 'https://x.com/example/status/1234567890',
  text: '把路上的光，留给每一个平常的日子。\n今天也有值得分享的小事。',
  author: { id: '7', handle: '@example', name: '晴日来信', avatarUrl: '/icons/x.png' },
  publishedAt: '2026-09-07T10:00:00.000Z', media: []
};
const sampleMedia: MediaRecord = {
  index: 1, type: 'photo', originalUrl: 'https://pbs.twimg.com/media/example.jpg?format=jpg&name=orig'
};
const presets: Record<SettingKey, Preset[]> = {
  frameTemplate: [
    { label: '经典署名', description: '左侧显示作者名称', value: DEFAULT_SETTINGS.frameTemplate },
    { label: '标记出处', description: '左侧显示来源文字和账号', value: '来源：{author.handle}' },
    { label: '仅账号', description: '左侧显示推主账号', value: '{author.handle}' }
  ],
  filenameTemplate: [
    { label: '完整信息', description: '使用默认规则', value: DEFAULT_SETTINGS.filenameTemplate },
    { label: '简洁命名', description: '账号 + 编号', value: 'X_{author.handle}_{tweet.id}_{media.index}.{extension}' },
    { label: '仅编号', description: '推文 ID + 序号', value: '{tweet.id}_{media.index}.{extension}' }
  ],
  textTemplate: [
    { label: '正文与来源', description: '沿用完整默认模板', value: DEFAULT_SETTINGS.textTemplate },
    { label: '我的排版', description: '自己安排文字与出处' }
  ]
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
  const selectedOrientation = document.querySelector<HTMLButtonElement>('[data-frame-orientation][aria-pressed="true"]')?.dataset.frameOrientation;
  return {
    filenameTemplate: inputs.filenameTemplate?.value ?? DEFAULT_SETTINGS.filenameTemplate,
    frameTemplate: inputs.frameTemplate?.value ?? DEFAULT_SETTINGS.frameTemplate,
    frameOrientation: frameOrientations.includes(selectedOrientation as FrameOrientation)
      ? selectedOrientation as FrameOrientation
      : DEFAULT_SETTINGS.frameOrientation,
    textTemplate: inputs.textTemplate?.value ?? DEFAULT_SETTINGS.textTemplate
  };
}
function setFrameOrientation(orientation: FrameOrientation): void {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-frame-orientation]'))) {
    button.setAttribute('aria-pressed', String(button.dataset.frameOrientation === orientation));
  }
}
function activateTab(tab: Tab, focus = false): void {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]'))) {
    const active = button.dataset.settingsTab === tab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  }
  for (const panel of Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'))) panel.hidden = panel.dataset.panel !== tab;
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
  const output = name === 'frameTemplate'
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
    const match = choices.findIndex(item => item.value !== undefined && item.value === settings[name]);
    const badge = document.querySelector<HTMLElement>(`[data-custom-badge="${name}"]`);
    if (badge) badge.hidden = match !== -1;
    const container = document.querySelector(`[data-presets="${name}"]`);
    container?.querySelectorAll<HTMLButtonElement>('[data-preset-index]').forEach(button => {
      const index = Number(button.dataset.presetIndex);
      button.setAttribute('aria-pressed', String(index === match || (match === -1 && choices[index]?.value === undefined)));
    });
  }
}
function updateDraft(announce = true): void {
  const settings = readSettings();
  const valid = validateAndPreview(settings);
  dirty = keys.some(key => settings[key] !== baseline[key]) || settings.frameOrientation !== baseline.frameOrientation;
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
    '{author.name}': '作者昵称', '{author.handle}': '推主账号', '{author.id}': '推主 ID', '{author.avatar}': '作者头像',
    '{tweet.id}': '推文 ID', '{tweet.text}': '推文正文', '{tweet.url}': '原文链接',
    '{text}': '推文正文', '{url}': '原文链接', '{tweetId}': '推文 ID',
    '{media.index}': '媒体序号', '{extension}': '扩展名'
  };
  return labels[token] ?? token;
}
function buildControls(): void {
  for (const name of keys) {
    const container = document.querySelector(`[data-presets="${name}"]`);
    presets[name].forEach((preset, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'preset'; button.dataset.presetIndex = String(index);
      button.setAttribute('aria-pressed', 'false');
      const check = document.createElement('span'); check.className = 'preset-check'; check.setAttribute('aria-hidden', 'true');
      const label = document.createElement('strong'); label.textContent = preset.label;
      const description = document.createElement('small'); description.textContent = preset.description;
      button.append(check, label, description);
      if (preset.value !== undefined) {
        // An incompatible preset is unavailable, rather than silently changing
        // the project's template grammar.
        try { renderValue(name, preset.value); }
        catch { button.disabled = true; description.textContent = '当前模板引擎不支持'; }
      }
      button.addEventListener('click', () => {
        if (!ready || saving) return;
        if (preset.value === undefined) { openEditor(name); return; }
        if (inputs[name]) inputs[name]!.value = preset.value;
        updateDraft();
      });
      container?.append(button);
    });
    const discovered = DEFAULT_SETTINGS[name].match(/\{[^{}]+\}/g) ?? [];
    const extras = name === 'filenameTemplate'
      ? ['{author.handle}', '{tweet.id}', '{media.index}', '{extension}']
      : name === 'frameTemplate' ? ['{author.handle}', '{author.avatar}'] : [];
    const tokenContainer = document.querySelector(`[data-tokens="${name}"]`);
    for (const token of new Set([...discovered, ...extras])) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'token'; button.textContent = `+ ${tokenLabel(token)}`;
      button.title = token; button.setAttribute('aria-label', `插入${tokenLabel(token)} ${token}`);
      button.addEventListener('click', () => {
        const input = inputs[name];
        if (!input || !ready || saving) return;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.setRangeText(token, start, end, 'end');
        input.focus(); updateDraft();
      });
      tokenContainer?.append(button);
    }
  }
}
for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]'))) {
  tab.addEventListener('click', () => activateTab(tab.dataset.settingsTab as Tab));
  tab.addEventListener('keydown', (event: KeyboardEvent) => {
    const order: Tab[] = ['frame', 'filename', 'text'];
    let index = order.indexOf(tab.dataset.settingsTab as Tab);
    if (event.key === 'ArrowRight') index = (index + 1) % order.length;
    else if (event.key === 'ArrowLeft') index = (index + order.length - 1) % order.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = order.length - 1;
    else return;
    event.preventDefault(); activateTab(order[index]!, true);
  });
}
for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-frame-orientation]'))) {
  button.addEventListener('click', () => {
    const orientation = button.dataset.frameOrientation;
    if (!ready || saving || !frameOrientations.includes(orientation as FrameOrientation)) return;
    setFrameOrientation(orientation as FrameOrientation);
    updateDraft();
  });
}
for (const input of Object.values(inputs)) input?.addEventListener('input', () => updateDraft());
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
form?.addEventListener('submit', async event => {
  event.preventDefault();
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
    baseline = { ...settings }; updateDraft(false);
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
window.addEventListener('beforeunload', event => {
  if (dirty) { event.preventDefault(); event.returnValue = ''; }
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
    baseline = { ...settings }; ready = true;
    writeSettings(settings);
    if (editable) editable.disabled = false;
    if (resetButton) resetButton.disabled = false;
    for (const key of keys) {
      if (!presets[key].some(item => item.value === settings[key])) {
        const details = document.querySelector<HTMLDetailsElement>(`[data-editor="${key}"]`);
        if (details) details.open = true;
      }
    }
  } catch (error) {
    const message = document.querySelector<HTMLElement>('[data-load-message]');
    if (message) message.textContent = `无法读取现有偏好，已暂停保存以免覆盖。${error instanceof Error ? error.message : String(error)}`;
    if (banner) banner.hidden = false;
    setStatus('error', '读取失败，请重试');
  } finally {
    if (retry) retry.disabled = false;
  }
}
buildControls();
writeSettings({ ...DEFAULT_SETTINGS });
document.querySelector('[data-retry-load]')?.addEventListener('click', () => { void initialize(); });
void initialize();
