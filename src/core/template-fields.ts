import type { MediaRecord, TweetRecord } from '../shared/model.js';

export interface TemplateContext {
  tweet: TweetRecord;
  media?: MediaRecord;
  extension?: string;
  card?: boolean;
  /** Render an avatar marker only in a frame, after optional sections are evaluated. */
  avatarMarker?: string;
}
export type TemplateScope = 'filenameTemplate' | 'frameTemplate' | 'textTemplate';
export interface TemplateField {
  name: string;
  label: string;
  group: '推文' | '作者' | '媒体' | '引用' | '输出';
  example: string;
  description: string;
  date?: boolean;
  media?: boolean;
  read: (context: TemplateContext) => string | number | boolean | undefined;
}
const field = (
  name: string,
  label: string,
  group: TemplateField['group'],
  example: string,
  read: TemplateField['read'],
  description = '响应未提供时为空。',
  options: Partial<Pick<TemplateField, 'date' | 'media'>> = {},
): TemplateField => ({ name, label, group, example, read, description, ...options });
const base: TemplateField[] = [
  field('tweet.id', '推文 ID', '推文', '1234567890', ({ tweet }) => tweet.tweetId),
  field(
    'tweet.url',
    '原推链接',
    '推文',
    'https://x.com/example/status/1234567890',
    ({ tweet }) => tweet.url,
  ),
  field('tweet.text', '正文', '推文', '今天的照片', ({ tweet }) => tweet.text),
  field(
    'tweet.publishedAt',
    '发布时间',
    '推文',
    '2026-09-08T10:00:00.000Z',
    ({ tweet }) => tweet.publishedAt,
    '日期格式使用 UTC。',
    { date: true },
  ),
  field('tweet.language', '语言', '推文', 'zh', ({ tweet }) => tweet.language),
  field(
    'tweet.replyToTweetId',
    '回复目标 ID',
    '推文',
    '123456789',
    ({ tweet }) => tweet.replyToTweetId,
  ),
  field(
    'tweet.replyToUserId',
    '回复目标用户 ID',
    '推文',
    '12345',
    ({ tweet }) => tweet.replyToUserId,
  ),
  field(
    'tweet.sensitive',
    '敏感内容标记',
    '推文',
    'false',
    ({ tweet }) => tweet.sensitive,
    'X 响应中的布尔标记；false 不等同于缺失。',
  ),
  field(
    'tweet.editIds',
    '编辑版本 ID',
    '推文',
    '123, 456',
    ({ tweet }) => tweet.editIds?.join(', '),
    '按响应顺序以逗号分隔，不推断哪个版本最新。',
  ),
  field(
    'tweet.mediaCount',
    '媒体数量',
    '推文',
    '4',
    ({ tweet }) => tweet.media.length,
    '本次已取得的媒体数量，不代表未知媒体总数。',
  ),
  field(
    'tweet.observedAt',
    '数据采集时间',
    '推文',
    '2026-09-08T10:00:00.000Z',
    ({ tweet }) => tweet.observedAt,
    '本地接收数据的时间，不是 X 的修改时间；UTC。',
    { date: true },
  ),
  field('author.id', '作者 ID', '作者', '12345', ({ tweet }) => tweet.author.id),
  field(
    'author.handle',
    '作者账号',
    '作者',
    'example',
    ({ tweet }) => tweet.author.handle.replace(/^@+/, ''),
    '不含 @，需要时在变量前输入 @。',
  ),
  field('author.name', '作者名称', '作者', '晴日来信', ({ tweet }) => tweet.author.name),
  field(
    'author.avatar',
    '作者头像',
    '作者',
    'https://pbs.twimg.com/profile_images/example.png',
    ({ tweet }) => tweet.author.avatarUrl,
    '画框中插入头像；其他模板输出头像 URL。',
  ),
  field(
    'author.description',
    '作者简介',
    '作者',
    '记录日常',
    ({ tweet }) => tweet.author.description,
  ),
  field(
    'author.location',
    '作者自填位置',
    '作者',
    'Shanghai',
    ({ tweet }) => tweet.author.location,
    '作者自行填写，不是推文定位。',
  ),
  field('author.url', '作者主页', '作者', 'https://example.com/', ({ tweet }) => tweet.author.url),
  field(
    'author.createdAt',
    '账号创建时间',
    '作者',
    '2020-01-01T00:00:00.000Z',
    ({ tweet }) => tweet.author.createdAt,
    '日期格式使用 UTC。',
    { date: true },
  ),
  field(
    'media.index',
    '媒体序号',
    '媒体',
    '1',
    ({ media, card }) => media?.index ?? (card ? 0 : undefined),
    '从 1 开始；无照片卡片为 0。',
    { media: true },
  ),
  field(
    'media.type',
    '媒体类型',
    '媒体',
    'photo',
    ({ media }) => media?.type,
    'photo / video / animated_gif；需要单个媒体上下文。',
    { media: true },
  ),
  field(
    'media.url',
    '原图地址',
    '媒体',
    'https://pbs.twimg.com/media/example.jpg',
    ({ media }) => media?.originalUrl,
    '照片原图 URL；视频不强行选取变体作为原图。',
    { media: true },
  ),
  field(
    'media.width',
    '媒体宽度',
    '媒体',
    '1200',
    ({ media }) => media?.width,
    '源媒体像素宽度，不是输出画框宽度。',
    { media: true },
  ),
  field(
    'media.height',
    '媒体高度',
    '媒体',
    '800',
    ({ media }) => media?.height,
    '源媒体像素高度。',
    { media: true },
  ),
  field(
    'media.altText',
    '替代文本',
    '媒体',
    '海边的日落',
    ({ media }) => media?.altText,
    '媒体作者提供的描述。',
    { media: true },
  ),
  field(
    'media.durationMs',
    '视频时长（毫秒）',
    '媒体',
    '12500',
    ({ media }) => media?.durationMs,
    '响应未提供时为空，不估算。',
    { media: true },
  ),
  field(
    'media.variantCount',
    '视频变体数量',
    '媒体',
    '3',
    ({ media }) => media?.variants?.length,
    '变体数组不直接插值；可使用数量和最高 MP4 码率。',
    { media: true },
  ),
  field(
    'media.bitrate',
    '最高 MP4 码率',
    '媒体',
    '2176000',
    ({ media }) => {
      const rates =
        media?.variants
          ?.filter((v) => v.mime === 'video/mp4' && v.bitrate !== undefined)
          .map((v) => v.bitrate!) ?? [];
      return rates.length ? Math.max(...rates) : undefined;
    },
    '单位 bit/s；未知码率为空。',
    { media: true },
  ),
  field(
    'extension',
    '输出扩展名',
    '输出',
    'jpg',
    ({ extension }) => extension,
    '不带点；由实际输出格式决定。',
  ),
];
export const TEMPLATE_FIELDS: readonly TemplateField[] = [
  ...base,
  field(
    'quote.status',
    '引用状态',
    '引用',
    'available',
    ({ tweet }) => tweet.quote?.status,
    'available / pending / unavailable；无引用为空。',
  ),
  ...base
    .filter((item) => item.group === '推文' || item.group === '作者')
    .map((item): TemplateField => ({
      ...item,
      name: `quote.${item.name}`,
      label: `引用 · ${item.label}`,
      group: '引用',
      description: `${item.name === 'author.avatar' ? '引用头像仅输出 URL，不在画框中插入第二个头像。' : item.description} 固定一层引用；未取得引用内容时为空。`,
      read: (context) => {
        if (item.name === 'tweet.id') return context.tweet.quote?.tweetId;
        if (item.name === 'tweet.url') return context.tweet.quote?.url;
        const tweet = context.tweet.quote?.record;
        return tweet ? item.read({ tweet }) : undefined;
      },
    })),
];
export const DATE_FORMATS = ['YYYY-MM-DD', 'YYYYMMDD', 'YYYY-MM-DD HH:mm:ss'] as const;
export function fieldsForScope(scope: TemplateScope): readonly TemplateField[] {
  return TEMPLATE_FIELDS.filter(
    (item) => scope !== 'textTemplate' || (!item.media && item.name !== 'extension'),
  );
}
