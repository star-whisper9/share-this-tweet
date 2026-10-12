import { mountExperimentControls } from './experiments.js';
import { mountRecordBrowser } from './records.js';
import { mountSourceReader } from './source-reader.js';
import { IMAGE_PALETTES, detectImageTheme } from '../core/image-theme.js';
import { mountTemplateGuide } from './template-guide.js';
import { buildMediaFilename } from '../core/filename.js';
import { renderTemplate } from '../core/template.js';
import {
  buildTweetText,
  getDefaultTextTemplate,
  isDefaultTextTemplate,
  ORIGINAL_TEXT_TEMPLATE,
} from '../core/text-export.js';
import type { FrameOrientation } from '../core/frame.js';
import type { MediaRecord, TweetRecord } from '../shared/model.js';
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
type Tab = 'frame' | 'filename' | 'text' | 'records' | 'experiment';
type SettingsTab = Exclude<Tab, 'records' | 'experiment'>;
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
const languageSelect = document.querySelector<HTMLSelectElement>('[data-language]');
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
  return {
    frameTemplate: [
      {
        label: t('options.preset.frame.handle.label'),
        description: t('options.preset.frame.handle.description'),
        value: DEFAULT_SETTINGS.frameTemplate,
      },
      {
        label: t('options.preset.frame.avatar.label'),
        description: t('options.preset.frame.avatar.description'),
        value: '{author.avatar} {author.name} (@{author.handle})',
      },
      {
        label: t('options.preset.frame.dated.label'),
        description: t('options.preset.frame.dated.description'),
        value:
          '{author.avatar} {author.name} (@{author.handle})\n{tweet.publishedAt:YYYY-MM-DD HH:mm:ss}',
      },
    ],
    filenameTemplate: [
      {
        label: t('options.preset.filename.date.label'),
        description: t('options.preset.filename.date.description'),
        value: DEFAULT_SETTINGS.filenameTemplate,
      },
      {
        label: t('options.preset.filename.account.label'),
        description: t('options.preset.filename.account.description'),
        value: 'X_{author.handle}_{tweet.id}_{media.index}.{extension}',
      },
      {
        label: t('options.preset.filename.id.label'),
        description: t('options.preset.filename.id.description'),
        value: 'X_{tweet.id}_{media.index}.{extension}',
      },
    ],
    textTemplate: [
      {
        label: t('options.preset.text.bilingual.label'),
        description: t('options.preset.text.bilingual.description'),
        value: getDefaultTextTemplate(locale),
      },
      {
        label: t('options.preset.text.original.label'),
        description: t('options.preset.text.original.description'),
        value: ORIGINAL_TEXT_TEMPLATE,
      },
      {
        label: t('options.preset.text.custom.label'),
        description: t('options.preset.text.custom.description'),
      },
    ],
  };
}
let presets = getPresets();
function copySettings(settings: ExtensionSettings): ExtensionSettings {
  return {
    ...settings,
    videoLimits: { ...settings.videoLimits },
    gifLimits: { ...settings.gifLimits },
  };
}
let baseline: ExtensionSettings = copySettings(DEFAULT_SETTINGS);
let ready = false;
let saving = false;
let languageSaving = false;
let dirty = false;
let invalidFields: SettingKey[] = [];
const recordBrowser = mountRecordBrowser();
const sourceReader = mountSourceReader();
const experiments = mountExperimentControls({
  editable: () => ready && !saving,
  changed: updateDraft,
  baseline: () => baseline,
});

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
    ...experiments.read(),
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
  if (tab === 'records') recordBrowser.ensureLoaded();
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
  const valid = validateAndPreview(settings) && experiments.validate(settings);
  dirty =
    keys.some((key) => settings[key] !== baseline[key]) ||
    settings.frameOrientation !== baseline.frameOrientation ||
    settings.stitchStyle !== baseline.stitchStyle ||
    experiments.differs(settings, baseline);
  updatePresetSelection(settings);
  experiments.updateSelection(settings);
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
  experiments.write(settings);
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

const disposeTemplateGuides: Array<() => void> = [];
function buildControls(): void {
  for (const dispose of disposeTemplateGuides.splice(0)) dispose();
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
      disposeTemplateGuides.push(
        mountTemplateGuide(tokenContainer, input, name, () => ready && !saving, updateDraft),
      );
  }
  experiments.relocalize();
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
  experiments.validate(settings);
  updatePresetSelection(settings);
  experiments.updateSelection(settings);
  recordBrowser.render();
  sourceReader.relocalize();
  if (ready && !saving && form?.dataset.state !== 'error') updateDraft();
}
for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]'))) {
  tab.addEventListener('click', () => activateTab(tab.dataset.settingsTab as Tab));
  tab.addEventListener('keydown', (event: KeyboardEvent) => {
    const order: Tab[] = ['frame', 'filename', 'text', 'records', 'experiment'];
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
  const templatesValid = validateAndPreview(settings);
  const experimentValid = experiments.validate(settings);
  if (!templatesValid || !experimentValid) {
    setStatus('error', t('options.status.fixFirst'));
    if (invalidFields[0]) openEditor(invalidFields[0]);
    else {
      activateTab('experiment');
      experiments.focusInvalid(settings);
    }
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
    baseline = copySettings(settings);
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
    baseline = copySettings(settings);
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
recordBrowser.render();
document.querySelector('[data-retry-load]')?.addEventListener('click', () => {
  void initialize();
});
void initialize();
const unwatchLanguage = watchLanguage((language) => {
  if (languageSelect) languageSelect.value = language;
  baseline = { ...baseline, language };
  refreshLocalizedUi();
  if (ready) updateDraft(false);
});

window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  unwatchLanguage();
  sourceReader.dispose();
  for (const dispose of disposeTemplateGuides.splice(0)) dispose();
});

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
