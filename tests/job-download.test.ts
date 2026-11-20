import { afterEach, expect, it, vi } from 'vitest';
import { saveExportJobFile } from '../src/core/job-download.js';
import { downloadBlob } from '../src/core/download.js';

vi.mock('../src/core/download.js', () => ({ downloadBlob: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(['Mozilla/5.0 (X11; Linux x86_64) Firefox/160.0', 'Firefox Android'])(
  'saves Android files through the page regardless of user agent: %s',
  async (userAgent) => {
    const blob = new Blob(['image']);
    const sendMessage = vi.fn(async (message) =>
      message.type === 'export-job-file' ? { ok: true, blob } : { ok: true },
    );
    vi.stubGlobal('navigator', { userAgent });
    vi.stubGlobal('browser', {
      runtime: { getPlatformInfo: async () => ({ os: 'android' }), sendMessage },
    });
    await saveExportJobFile('job', 'file', 'card.png');
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'export-job-file',
      'export-job-file-saved',
    ]);
    expect(downloadBlob).toHaveBeenCalledWith(blob, 'card.png');
  },
);

it('uses confirmed background downloads on desktop even with an Android user agent', async () => {
  const sendMessage = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('navigator', { userAgent: 'Firefox Android' });
  vi.stubGlobal('browser', {
    runtime: { getPlatformInfo: async () => ({ os: 'linux' }), sendMessage },
  });
  await saveExportJobFile('job', 'file', 'card.png');
  expect(sendMessage).toHaveBeenCalledWith({
    type: 'export-job-download',
    id: 'job',
    fileId: 'file',
  });
  expect(downloadBlob).not.toHaveBeenCalled();
});

it('does not route downloads when platform detection fails', async () => {
  const sendMessage = vi.fn();
  const error = new Error('platform unavailable');
  vi.stubGlobal('browser', {
    runtime: {
      getPlatformInfo: async () => {
        throw error;
      },
      sendMessage,
    },
  });
  await expect(saveExportJobFile('job', 'file', 'card.png')).rejects.toBe(error);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(downloadBlob).not.toHaveBeenCalled();
});
