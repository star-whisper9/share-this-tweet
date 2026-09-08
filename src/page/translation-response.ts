export interface TranslationRequest {
  tweetId: string;
  targetLanguage: string;
}
export function isTranslationUrl(url: string): boolean {
  try {
    const parsed = new URL(url, 'https://x.com');
    return (
      parsed.protocol === 'https:' &&
      ['x.com', 'api.x.com'].includes(parsed.hostname) &&
      ['/2/grok/translation.json', '/i/api/2/grok/translation.json'].includes(parsed.pathname)
    );
  } catch {
    return false;
  }
}
export function translationRequest(url: string, body: unknown): TranslationRequest | undefined {
  try {
    if (!isTranslationUrl(url)) return undefined;
    if (typeof body !== 'string' || body.length > 10000) return undefined;
    const data = JSON.parse(body) as Record<string, unknown>;
    if (
      data.content_type !== 'POST' ||
      typeof data.id !== 'string' ||
      !/^\d+$/.test(data.id) ||
      typeof data.dst_lang !== 'string' ||
      !data.dst_lang.trim() ||
      data.dst_lang.length > 100
    )
      return undefined;
    return { tweetId: data.id, targetLanguage: data.dst_lang };
  } catch {
    return undefined;
  }
}

/** X returns adjacent JSON objects, not a JSON array or a single JSON document. */
export function translationResponse(text: string): string {
  if (text.length > 1000000) throw new Error('Translation response too large');
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  const chunks: string[] = [];
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start === -1) {
      if (/\s/.test(char)) continue;
      if (char !== '{') throw new Error('Invalid translation stream');
      start = index;
      depth = 1;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}') depth--;
    if (depth !== 0) continue;
    const data = JSON.parse(text.slice(start, index + 1)) as {
      result?: { content_type?: unknown; text?: unknown };
    };
    if (data.result?.content_type !== 'POST' || typeof data.result.text !== 'string')
      throw new Error('Invalid translation chunk');
    chunks.push(data.result.text);
    length += data.result.text.length;
    if (length > 100000 || chunks.length > 10000) throw new Error('Translation output too large');
    start = -1;
  }
  if (start !== -1) throw new Error('Incomplete translation stream');
  return chunks.join('');
}
