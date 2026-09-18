type StorageValues = Record<string, unknown>;

interface BrowserStorageArea {
  get(keys?: string | string[] | null): Promise<StorageValues>;
  set(values: StorageValues): Promise<void>;
}

interface BrowserPort {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
}

interface BrowserRuntime {
  connect(options: { name: string }): BrowserPort;
  onConnect?: { addListener(listener: (port: BrowserPort) => void): void };
  getURL(path: string): string;
  getManifest(): { version: string };
  sendMessage(message: unknown): Promise<unknown>;
  openOptionsPage(): Promise<void>;
  onMessage: {
    addListener(listener: (message: unknown, sender: unknown) => unknown): void;
  };
}

interface BrowserDownloads {
  cancel(downloadId: number): Promise<void>;
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
  i18n?: { getUILanguage(): string };
  storage: {
    local: BrowserStorageArea;
    onChanged?: {
      addListener(
        listener: (
          changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
          areaName: string,
        ) => void,
      ): void;
      removeListener(
        listener: (
          changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
          areaName: string,
        ) => void,
      ): void;
    };
  };
  downloads: BrowserDownloads;
  tabs: {
    query(query: {
      url?: string;
      active?: boolean;
      currentWindow?: boolean;
    }): Promise<Array<{ id?: number; windowId?: number; url?: string }>>;
    create(options: { url: string; active?: boolean }): Promise<{ id?: number; windowId?: number }>;
    update(id: number, options: { active?: boolean; url?: string }): Promise<unknown>;
  };
  windows?: { update(id: number, options: { focused: boolean }): Promise<unknown> };
};
