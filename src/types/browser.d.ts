type StorageValues = Record<string, unknown>;

interface BrowserStorageArea {
  get(keys?: string | string[] | null): Promise<StorageValues>;
  set(values: StorageValues): Promise<void>;
}

interface BrowserRuntime {
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  openOptionsPage(): Promise<void>;
  onMessage: {
    addListener(listener: (message: unknown, sender: unknown) => unknown): void;
  };
}

interface BrowserDownloads {
  download(options: {
    url: string;
    filename?: string;
    saveAs?: boolean;
  }): Promise<number>;
}

declare const browser: {
  runtime: BrowserRuntime;
  storage: {
    local: BrowserStorageArea;
  };
  downloads: BrowserDownloads;
};
