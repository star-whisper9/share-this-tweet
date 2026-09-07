import { loadSettings } from '../shared/settings.js';

const openSettings = document.querySelector<HTMLButtonElement>('[data-open-settings]');
const error = document.querySelector<HTMLElement>('[data-error]');

function shorten(value: string, maxLength = 42): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function orientationLabel(value: string): string {
  return ({ top: '上', bottom: '下' } as Record<string, string>)[value] ?? '下';
}

function showError(message: string): void {
  if (!error) return;
  error.hidden = false;
  error.textContent = message;
}

openSettings?.addEventListener('click', () => {
  void browser.runtime.openOptionsPage().catch((reason: unknown) => {
    showError(`无法打开设置：${reason instanceof Error ? reason.message : String(reason)}`);
  });
});

void loadSettings()
  .then((settings) => {
    const values = {
      frame: settings.frameTemplate,
      orientation: orientationLabel(settings.frameOrientation),
      filename: settings.filenameTemplate,
      text: settings.textTemplate,
    };
    for (const [key, value] of Object.entries(values)) {
      const element = document.querySelector<HTMLElement>(`[data-template="${key}"]`);
      if (element) element.textContent = shorten(value);
    }
  })
  .catch((reason: unknown) => {
    showError(`无法读取设置：${reason instanceof Error ? reason.message : String(reason)}`);
  });
