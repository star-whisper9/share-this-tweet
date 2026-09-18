import { loadSettings, saveLanguage, watchLanguage } from '../shared/settings.js';
import { isLanguagePreference, localizeDocument, t } from '../shared/i18n.js';

const openSettings = document.querySelector<HTMLButtonElement>('[data-open-settings]');
const error = document.querySelector<HTMLElement>('[data-error]');
const language = document.querySelector<HTMLSelectElement>('[data-language]');
let savingLanguage = false;
let refreshVersion = 0;

function shorten(value: string, maxLength = 42): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
function showError(message: string): void {
  if (!error) return;
  error.hidden = false;
  error.textContent = message;
}
async function refresh(): Promise<void> {
  const version = ++refreshVersion;
  try {
    const settings = await loadSettings();
    if (version !== refreshVersion) return;
    localizeDocument();
    if (language) {
      language.value = settings.language;
      language.disabled = savingLanguage;
    }
    const values = {
      frame: settings.frameTemplate,
      orientation: t(settings.frameOrientation === 'top' ? 'popup.top' : 'popup.bottom'),
      filename: settings.filenameTemplate,
      text: settings.textTemplate,
    };
    for (const [key, value] of Object.entries(values)) {
      const element = document.querySelector<HTMLElement>(`[data-template="${key}"]`);
      if (element) {
        element.removeAttribute('data-i18n');
        element.textContent = shorten(value);
        element.title = value;
      }
    }
    if (error) error.hidden = true;
  } catch (reason) {
    if (version !== refreshVersion) return;
    showError(
      t('popup.loadError', { error: reason instanceof Error ? reason.message : String(reason) }),
    );
  }
}
openSettings?.addEventListener('click', () => {
  void browser.runtime.openOptionsPage().catch((reason: unknown) => {
    showError(
      t('popup.openError', { error: reason instanceof Error ? reason.message : String(reason) }),
    );
  });
});
language?.addEventListener('change', async () => {
  if (!isLanguagePreference(language.value) || savingLanguage) return;
  const selected = language.value;
  savingLanguage = true;
  language.disabled = true;
  try {
    await saveLanguage(selected);
    await refresh();
  } catch (reason) {
    await refresh();
    showError(
      t('common.language.error', {
        error: reason instanceof Error ? reason.message : String(reason),
      }),
    );
  } finally {
    savingLanguage = false;
    language.disabled = false;
  }
});
const stopWatching = watchLanguage(() => {
  void refresh();
});
window.addEventListener('pagehide', stopWatching, { once: true });
void refresh();
