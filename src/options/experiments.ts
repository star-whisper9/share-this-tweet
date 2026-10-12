import { isGifLimits, type GifLimits } from '../shared/gif-experiment.js';
import { VIDEO_LIMIT_PRESETS, type VideoLimits } from '../shared/video-experiment.js';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '../shared/settings.js';
import { t } from '../shared/i18n.js';

const videoLimitKeys = [
  'maxInputMiB',
  'maxDurationSeconds',
  'maxOutputPixels',
  'maxFrameRate',
] as const satisfies ReadonlyArray<keyof VideoLimits>;
const gifLimitKeys = ['maxInputMiB', 'maxDurationSeconds', 'maxSourcePixels'] as const;
type ExperimentSettings = Pick<
  ExtensionSettings,
  'experimentalGif' | 'gifLimits' | 'experimentalVideo' | 'videoLimits'
>;

export function mountExperimentControls({
  editable,
  changed,
  baseline,
}: {
  editable: () => boolean;
  changed: () => void;
  baseline: () => ExperimentSettings;
}) {
  const experimentalVideoInput = document.querySelector<HTMLInputElement>(
    '[data-experimental-video]',
  );
  const experimentalGifInput = document.querySelector<HTMLInputElement>('[data-experimental-gif]');
  const gifSettings = document.querySelector<HTMLElement>('[data-gif-settings]');
  const gifLimitsError = document.querySelector<HTMLElement>('[data-gif-limits-error]');
  const gifLimitInputs: Record<keyof GifLimits, HTMLInputElement | null> = {
    maxInputMiB: document.querySelector<HTMLInputElement>('[data-gif-limit="maxInputMiB"]'),
    maxDurationSeconds: document.querySelector<HTMLInputElement>(
      '[data-gif-limit="maxDurationSeconds"]',
    ),
    maxSourcePixels: document.querySelector<HTMLInputElement>('[data-gif-limit="maxSourcePixels"]'),
  };
  const experimentSettings = document.querySelector<HTMLElement>('[data-experiment-settings]');
  const experimentLimitsError = document.querySelector<HTMLElement>(
    '[data-experiment-limits-error]',
  );
  const videoLimitInputs: Record<keyof VideoLimits, HTMLInputElement | null> = {
    maxInputMiB: document.querySelector<HTMLInputElement>('[data-video-limit="maxInputMiB"]'),
    maxDurationSeconds: document.querySelector<HTMLInputElement>(
      '[data-video-limit="maxDurationSeconds"]',
    ),
    maxOutputPixels: document.querySelector<HTMLInputElement>(
      '[data-video-limit="maxOutputPixels"]',
    ),
    maxFrameRate: document.querySelector<HTMLInputElement>('[data-video-limit="maxFrameRate"]'),
  };
  function readVideoLimits(): VideoLimits {
    const read = (input: HTMLInputElement | null): number =>
      input?.value.trim() === '' ? Number.NaN : Number(input?.value);
    return {
      maxInputMiB: read(videoLimitInputs.maxInputMiB),
      maxDurationSeconds: read(videoLimitInputs.maxDurationSeconds),
      maxOutputPixels: read(videoLimitInputs.maxOutputPixels),
      maxFrameRate: read(videoLimitInputs.maxFrameRate),
    };
  }
  function sameVideoLimits(left: VideoLimits, right: VideoLimits): boolean {
    return videoLimitKeys.every((key) => left[key] === right[key]);
  }
  function validVideoLimits(limits: VideoLimits): boolean {
    return videoLimitKeys.every((key) => Number.isSafeInteger(limits[key]) && limits[key] >= 0);
  }
  function readGifLimits(): GifLimits {
    const read = (input: HTMLInputElement | null): number =>
      input?.value.trim() === '' ? Number.NaN : Number(input?.value);
    return {
      maxInputMiB: read(gifLimitInputs.maxInputMiB),
      maxDurationSeconds: read(gifLimitInputs.maxDurationSeconds),
      maxSourcePixels: read(gifLimitInputs.maxSourcePixels),
    };
  }
  function writeGifLimits(limits: GifLimits): void {
    for (const key of gifLimitKeys) {
      const input = gifLimitInputs[key];
      if (input) input.value = String(limits[key]);
    }
  }
  function setGifEnabled(enabled: boolean): void {
    if (experimentalGifInput) experimentalGifInput.checked = enabled;
    if (gifSettings) gifSettings.hidden = !enabled;
  }
  function validateExperimentSettings(settings: ExperimentSettings): boolean {
    const gifValid = isGifLimits(settings.gifLimits);
    if (gifLimitsError) gifLimitsError.textContent = gifValid ? '' : t('gif.invalidLimits');
    for (const key of gifLimitKeys)
      gifLimitInputs[key]?.setAttribute('aria-invalid', String(!gifValid));
    if (!settings.experimentalVideo) {
      if (experimentLimitsError) experimentLimitsError.textContent = '';
      for (const key of videoLimitKeys)
        videoLimitInputs[key]?.setAttribute('aria-invalid', 'false');
      return gifValid;
    }
    const valid = validVideoLimits(settings.videoLimits);
    if (experimentLimitsError)
      experimentLimitsError.textContent = valid ? '' : t('experiment.invalidLimits');
    for (const key of videoLimitKeys)
      videoLimitInputs[key]?.setAttribute('aria-invalid', String(!valid));
    return valid && gifValid;
  }
  function setExperimentEnabled(enabled: boolean): void {
    if (experimentalVideoInput) experimentalVideoInput.checked = enabled;
    if (experimentSettings) experimentSettings.hidden = !enabled;
  }
  function writeVideoLimits(limits: VideoLimits): void {
    for (const key of videoLimitKeys) {
      const input = videoLimitInputs[key];
      if (input) input.value = String(limits[key]);
    }
  }
  function videoPresetLabel(id: (typeof VIDEO_LIMIT_PRESETS)[number]['id']): string {
    switch (id) {
      case 'cautious':
        return t('experiment.preset.cautious');
      case 'standard':
        return t('experiment.preset.standard');
      case 'hd':
        return t('experiment.preset.hd');
      case 'unlimited':
        return t('experiment.preset.unlimited');
    }
  }
  function updateVideoPresetSelection(limits: VideoLimits): void {
    document.querySelectorAll<HTMLButtonElement>('[data-video-preset]').forEach((button) => {
      const preset = VIDEO_LIMIT_PRESETS.find((item) => item.id === button.dataset.videoPreset);
      button.setAttribute(
        'aria-pressed',
        String(Boolean(preset && sameVideoLimits(limits, preset.limits))),
      );
    });
  }
  function buildVideoControls(): void {
    const container = document.querySelector<HTMLElement>('[data-video-presets]');
    if (!container) return;
    container.replaceChildren();
    for (const preset of VIDEO_LIMIT_PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.videoPreset = preset.id;
      button.setAttribute('aria-pressed', 'false');
      button.textContent = videoPresetLabel(preset.id);
      button.addEventListener('click', () => {
        if (!editable()) return;
        writeVideoLimits(preset.limits);
        changed();
      });
      container.append(button);
    }
    updateVideoPresetSelection(readVideoLimits());
  }
  experimentalVideoInput?.addEventListener('change', () => {
    if (!editable()) return;
    if (!experimentalVideoInput.checked && !validVideoLimits(readVideoLimits()))
      writeVideoLimits(baseline().videoLimits);
    setExperimentEnabled(experimentalVideoInput.checked);
    changed();
  });
  experimentalGifInput?.addEventListener('change', () => {
    if (!editable()) return;
    if (!experimentalGifInput.checked && !isGifLimits(readGifLimits()))
      writeGifLimits(baseline().gifLimits);
    setGifEnabled(experimentalGifInput.checked);
    changed();
  });
  for (const input of Object.values(gifLimitInputs))
    input?.addEventListener('input', () => changed());
  for (const input of Object.values(videoLimitInputs))
    input?.addEventListener('input', () => changed());
  return {
    read(): ExperimentSettings {
      return {
        experimentalGif: experimentalGifInput?.checked ?? DEFAULT_SETTINGS.experimentalGif,
        gifLimits: readGifLimits(),
        experimentalVideo: experimentalVideoInput?.checked ?? DEFAULT_SETTINGS.experimentalVideo,
        videoLimits: readVideoLimits(),
      };
    },
    write(settings: ExperimentSettings): void {
      setGifEnabled(settings.experimentalGif);
      writeGifLimits(settings.gifLimits);
      setExperimentEnabled(settings.experimentalVideo);
      writeVideoLimits(settings.videoLimits);
    },
    validate: validateExperimentSettings,
    differs(settings: ExperimentSettings, baseline: ExperimentSettings): boolean {
      return (
        settings.experimentalGif !== baseline.experimentalGif ||
        gifLimitKeys.some((key) => settings.gifLimits[key] !== baseline.gifLimits[key]) ||
        settings.experimentalVideo !== baseline.experimentalVideo ||
        !sameVideoLimits(settings.videoLimits, baseline.videoLimits)
      );
    },
    updateSelection(settings: ExperimentSettings): void {
      updateVideoPresetSelection(settings.videoLimits);
    },
    relocalize(): void {
      buildVideoControls();
    },
    focusInvalid(settings: ExperimentSettings): void {
      (isGifLimits(settings.gifLimits)
        ? videoLimitInputs.maxInputMiB
        : gifLimitInputs.maxInputMiB
      )?.focus();
    },
  };
}
