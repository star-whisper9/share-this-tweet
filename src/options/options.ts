import { buildMediaFilename } from '../core/filename.js';
import { renderTemplate } from '../core/template.js';
import { buildTweetText } from '../core/text-export.js';
import type { MediaRecord, TweetRecord } from '../shared/model.js';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type ExtensionSettings
} from '../shared/settings.js';

const form = document.querySelector<HTMLFormElement>('[data-settings-form]');
const status = document.querySelector<HTMLOutputElement>('[data-status]');
const resetButton = document.querySelector<HTMLButtonElement>('[data-reset]');
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
  tweetId: '1234567890',
  url: 'https://x.com/example/status/1234567890',
  text: '示例推文正文\n保留换行和中文。',
  author: { id: '7', handle: '@example', name: '示例作者' },
  publishedAt: '2026-09-07T10:00:00.000Z',
  media: []
};
const sampleMedia: MediaRecord = {
  index: 1,
  type: 'photo',
  originalUrl: 'https://pbs.twimg.com/media/example.jpg?format=jpg&name=orig'
};

function readSettings(): ExtensionSettings {
  return {
    filenameTemplate: inputs.filenameTemplate?.value ?? DEFAULT_SETTINGS.filenameTemplate,
    frameTemplate: inputs.frameTemplate?.value ?? DEFAULT_SETTINGS.frameTemplate,
    textTemplate: inputs.textTemplate?.value ?? DEFAULT_SETTINGS.textTemplate
  };
}

function setError(name: keyof ExtensionSettings, message: string): void {
  const error = document.querySelector<HTMLElement>(`[data-error="${name}"]`);
  if (error) error.textContent = message;
}

function validateAndPreview(settings: ExtensionSettings): boolean {
  let valid = true;
  for (const name of Object.keys(settings) as Array<keyof ExtensionSettings>) setError(name, '');

  try {
    if (!settings.filenameTemplate.trim()) throw new Error('文件名模板不能为空');
    if (previews.filename) previews.filename.textContent = buildMediaFilename(sampleRecord, sampleMedia, settings.filenameTemplate);
  } catch (error) {
    valid = false;
    setError('filenameTemplate', error instanceof Error ? error.message : String(error));
    if (previews.filename) previews.filename.textContent = '—';
  }

  try {
    const frame = renderTemplate(settings.frameTemplate, { tweet: sampleRecord, media: sampleMedia, extension: 'png' });
    if (!frame.trim()) throw new Error('画框模板渲染后为空');
    if (previews.frame) previews.frame.textContent = frame;
  } catch (error) {
    valid = false;
    setError('frameTemplate', error instanceof Error ? error.message : String(error));
    if (previews.frame) previews.frame.textContent = '—';
  }

  try {
    const text = buildTweetText(sampleRecord, settings.textTemplate);
    if (!text.trim()) throw new Error('复制文本模板渲染后为空');
    if (previews.text) previews.text.textContent = text;
  } catch (error) {
    valid = false;
    setError('textTemplate', error instanceof Error ? error.message : String(error));
    if (previews.text) previews.text.textContent = '—';
  }
  return valid;
}

function writeSettings(settings: ExtensionSettings): void {
  if (inputs.filenameTemplate) inputs.filenameTemplate.value = settings.filenameTemplate;
  if (inputs.frameTemplate) inputs.frameTemplate.value = settings.frameTemplate;
  if (inputs.textTemplate) inputs.textTemplate.value = settings.textTemplate;
  validateAndPreview(settings);
}

for (const input of Object.values(inputs)) input?.addEventListener('input', () => validateAndPreview(readSettings()));

resetButton?.addEventListener('click', () => {
  writeSettings({ ...DEFAULT_SETTINGS });
  if (status) status.textContent = '已恢复默认值，点击保存设置后生效。';
});

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = readSettings();
  if (!validateAndPreview(settings)) {
    if (status) status.textContent = '请先修正模板错误。';
    return;
  }
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  if (status) status.textContent = '正在保存…';
  try {
    await saveSettings(settings);
    if (status) status.textContent = '设置已保存。';
  } catch (error) {
    if (status) status.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (submit) submit.disabled = false;
  }
});

void loadSettings()
  .then(writeSettings)
  .catch((error) => {
    if (status) status.textContent = `读取设置失败：${error instanceof Error ? error.message : String(error)}`;
    writeSettings({ ...DEFAULT_SETTINGS });
  });
