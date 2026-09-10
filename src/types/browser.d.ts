type StorageValues = Record<string, unknown>;

interface BrowserStorageArea {
  get(keys?: string | string[] | null): Promise<StorageValues>;
  set(values: StorageValues): Promise<void>;
}

interface BrowserRuntime {
  getURL(path: string): string;
  getManifest(): { version: string };
  sendMessage(message: unknown): Promise<unknown>;
  openOptionsPage(): Promise<void>;
  onMessage: {
    addListener(listener: (message: unknown, sender: unknown) => unknown): void;
  };
}

interface BrowserDownloads {
  download(options: { url: string; filename?: string; saveAs?: boolean }): Promise<number>;
  search(query: { id: number }): Promise<BrowserDownloadItem[]>;
  onChanged: {
    addListener(listener: (delta: BrowserDownloadDelta) => void): void;
  };
}

interface BrowserDownloadItem {
  id: number;
  state: 'in_progress' | 'complete' | 'interrupted';
  error?: string;
}

interface BrowserDownloadDelta {
  id: number;
  state?: { current?: 'in_progress' | 'complete' | 'interrupted' };
  error?: { current?: string };
}

declare const browser: {
  runtime: BrowserRuntime;
  storage: {
    local: BrowserStorageArea;
  };
  downloads: BrowserDownloads;
};
