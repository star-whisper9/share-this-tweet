export type ImageTheme = 'light' | 'dark';

export interface ImagePalette {
  background: string;
  imageBackground: string;
  text: string;
  muted: string;
  border: string;
}

export const IMAGE_PALETTES: Record<ImageTheme, ImagePalette> = {
  light: {
    background: '#fbfaf7',
    imageBackground: '#edf0f2',
    text: '#17202a',
    muted: '#687582',
    border: '#dfe3e8',
  },
  dark: {
    background: '#111820',
    imageBackground: '#202b35',
    text: '#f1f4f7',
    muted: '#a9b6c2',
    border: '#354352',
  },
};

export function resolveImageTheme(
  explicitMode: string | undefined,
  systemDark: boolean,
): ImageTheme {
  if (explicitMode?.toLowerCase().includes('dark')) return 'dark';
  if (explicitMode?.toLowerCase().includes('light')) return 'light';
  return systemDark ? 'dark' : 'light';
}

export function detectImageTheme(root: HTMLElement = document.documentElement): ImageTheme {
  const explicitMode = [
    root.getAttribute('data-color-mode'),
    root.getAttribute('data-theme'),
    root.ownerDocument.body?.getAttribute('data-color-mode'),
    root.ownerDocument.body?.getAttribute('data-theme'),
  ].find((value) => value);
  const systemDark =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  return resolveImageTheme(explicitMode ?? undefined, systemDark);
}
