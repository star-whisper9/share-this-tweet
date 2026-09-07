export interface ShareNavigator {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
}

export class ShareCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareCapabilityError';
  }
}

export class ShareCancelledError extends Error {
  constructor(message = '用户取消了系统分享') {
    super(message);
    this.name = 'ShareCancelledError';
  }
}

export class ShareFailedError extends Error {
  constructor(
    message: string,
    public readonly file?: File,
  ) {
    super(message);
    this.name = 'ShareFailedError';
  }
}

function getNavigator(): ShareNavigator {
  if (typeof navigator === 'undefined') return {};
  return navigator as ShareNavigator;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function canShareText(shareNavigator: ShareNavigator = getNavigator()): boolean {
  return typeof shareNavigator.share === 'function';
}

export function canShareFile(file: File, shareNavigator: ShareNavigator = getNavigator()): boolean {
  if (typeof shareNavigator.share !== 'function' || typeof shareNavigator.canShare !== 'function') {
    return false;
  }
  try {
    return shareNavigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export async function shareText(
  text: string,
  shareNavigator: ShareNavigator = getNavigator(),
): Promise<void> {
  if (typeof shareNavigator.share !== 'function') {
    throw new ShareCapabilityError('当前环境不支持文本分享');
  }
  try {
    await shareNavigator.share({ text });
  } catch (error) {
    if (isAbortError(error)) throw new ShareCancelledError();
    throw new ShareFailedError(error instanceof Error ? error.message : String(error));
  }
}

export async function shareImage(
  file: File,
  shareNavigator: ShareNavigator = getNavigator(),
): Promise<void> {
  if (!canShareFile(file, shareNavigator)) {
    throw new ShareCapabilityError('当前环境不支持图片文件分享');
  }
  try {
    await shareNavigator.share!({ files: [file] });
  } catch (error) {
    if (isAbortError(error)) throw new ShareCancelledError();
    throw new ShareFailedError(error instanceof Error ? error.message : String(error), file);
  }
}
