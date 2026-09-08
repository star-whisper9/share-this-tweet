import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const { capture, start } = vi.hoisted(() => ({ capture: vi.fn(), start: vi.fn() }));
vi.mock('../src/content/capture.js', () => ({ startTweetCapture: capture }));
vi.mock('../src/content/ui.js', () => ({
  ShareEnhancerController: class {
    start = start;
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('installs capture at document_start and defers UI until the DOM is ready', async () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'),
  );
  expect(manifest.content_scripts[0].run_at).toBe('document_start');
  vi.stubGlobal('location', { hostname: 'x.com' });
  const document = Object.assign(new EventTarget(), { readyState: 'loading' });
  vi.stubGlobal('document', document);
  await import('../src/content/bootstrap.js');
  expect(capture).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  document.dispatchEvent(new Event('DOMContentLoaded'));
  document.dispatchEvent(new Event('DOMContentLoaded'));
  expect(start).toHaveBeenCalledOnce();
});
