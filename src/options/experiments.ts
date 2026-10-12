import { isGifLimits, type GifLimits } from '../shared/gif-experiment.js';
import {
  estimateVideoProcessing,
  VIDEO_LIMIT_PRESETS,
  type VideoLimits,
} from '../shared/video-experiment.js';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '../shared/settings.js';
import { getLocale, t } from '../shared/i18n.js';

const videoLimitKeys = [
  'maxInputMiB',
  'maxDurationSeconds',
  'maxOutputPixels',
  'maxFrameRate',
] as const satisfies ReadonlyArray<keyof VideoLimits>;
const gifLimitKeys = ['maxInputMiB', 'maxDurationSeconds', 'maxSourcePixels'] as const;
const calculatorPresets = {
  '480p': { width: 854, height: 480, durationSeconds: 140, frameRate: 30, bitrateMbps: 1.25 },
  '720p': { width: 1280, height: 720, durationSeconds: 140, frameRate: 30, bitrateMbps: 2.5 },
  '1080p': { width: 1920, height: 1080, durationSeconds: 140, frameRate: 30, bitrateMbps: 5 },
  long1080p: { width: 1920, height: 1080, durationSeconds: 600, frameRate: 30, bitrateMbps: 5 },
} as const;
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
  const calculatorInputs = {
    width: document.querySelector<HTMLInputElement>('[data-calculator="width"]'),
    height: document.querySelector<HTMLInputElement>('[data-calculator="height"]'),
    durationSeconds: document.querySelector<HTMLInputElement>(
      '[data-calculator="durationSeconds"]',
    ),
    frameRate: document.querySelector<HTMLInputElement>('[data-calculator="frameRate"]'),
    bitrateMbps: document.querySelector<HTMLInputElement>('[data-calculator="bitrateMbps"]'),
  };
  const videoEstimate = document.querySelector<HTMLOutputElement>('[data-video-estimate]');
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
  function formatEstimateNumber(value: number): string {
    return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(value);
  }
  function updateCalculatorPresetSelection(id?: keyof typeof calculatorPresets): void {
    document
      .querySelectorAll<HTMLButtonElement>('[data-calculator-preset]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.calculatorPreset === id)),
      );
  }
  function updateVideoEstimate(): void {
    const input = {
      width: Number(calculatorInputs.width?.value),
      height: Number(calculatorInputs.height?.value),
      durationSeconds: Number(calculatorInputs.durationSeconds?.value),
      frameRate: Number(calculatorInputs.frameRate?.value),
      bitrateMbps: Number(calculatorInputs.bitrateMbps?.value),
    };
    try {
      const estimate = estimateVideoProcessing(input);
      if (videoEstimate)
        videoEstimate.textContent = t('experiment.calculator.result', {
          min: formatEstimateNumber(Math.ceil(estimate.minSeconds)),
          max: formatEstimateNumber(Math.ceil(estimate.maxSeconds)),
          input: formatEstimateNumber(estimate.inputMiB),
        });
    } catch (error) {
      if (videoEstimate)
        videoEstimate.textContent =
          error instanceof Error ? error.message : t('experiment.invalidEstimate');
    }
  }
  function applyCalculatorPreset(id: keyof typeof calculatorPresets): void {
    const preset = calculatorPresets[id];
    for (const [key, value] of Object.entries(preset)) {
      const input = calculatorInputs[key as keyof typeof calculatorInputs];
      if (input) input.value = String(value);
    }
    updateCalculatorPresetSelection(id);
    updateVideoEstimate();
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
  for (const input of Object.values(calculatorInputs)) {
    input?.addEventListener('input', () => {
      updateCalculatorPresetSelection();
      updateVideoEstimate();
    });
  }
  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-calculator-preset]'),
  )) {
    button.addEventListener('click', () => {
      const id = button.dataset.calculatorPreset as keyof typeof calculatorPresets | undefined;
      if (id && id in calculatorPresets) applyCalculatorPreset(id);
    });
  }

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
      updateVideoEstimate();
    },
    focusInvalid(settings: ExperimentSettings): void {
      (isGifLimits(settings.gifLimits)
        ? videoLimitInputs.maxInputMiB
        : gifLimitInputs.maxInputMiB
      )?.focus();
    },
  };
}
