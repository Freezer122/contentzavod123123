export type AccountStatus = 'ACTIVE' | 'PAUSED' | 'AUTH_REQUIRED' | 'ERROR' | 'RESTRICTED';
export type JobStatus =
  'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'NEEDS_REVIEW';
export type SendStatus =
  'PENDING' | 'SENDING' | 'PUBLISHED' | 'FAILED' | 'UNCERTAIN' | 'DISABLED' | 'COMMENT_FAILED';
export interface Base {
  id: string;
  createdAt: Date;
}
export interface User extends Base {
  telegramId: string;
  timezone: string;
}
export interface BrowserProfile extends Base {
  provider: 'ADSPOWER' | 'DOLPHIN' | 'MOCK';
  externalId: string;
  name: string;
}
export interface Style extends Base {
  ownerAccountId?: string | null;
  name: string;
  instruction: string;
  maxLength: number;
  maxParagraphs: number;
  punctuation: string;
  emoji: boolean;
  slang: boolean;
  profanity: boolean;
  forbidden: string[];
  opening: string;
  ending: string;
  extra: string;
}
export interface StyleExample extends Base {
  styleId: string;
  text: string;
}
export interface Account extends Base {
  templateId?: string | null;
  username: string;
  profileUrl: string;
  name: string;
  profileId: string;
  styleId: string;
  status: AccountStatus;
  autoApprove: boolean;
  followers: number | null;
  lastPublishedAt: Date | null;
  ctaId: string | null;
  insightsUserId: string | null;
}
export interface Source extends Base {
  topic?: string;
  format?: string;
  hook?: string;
  url: string | null;
  fingerprint: string;
  text: string;
  author: string | null;
  rights: 'OWN' | 'PERMITTED' | 'REVIEW';
}
export interface Generated extends Base {
  templateId?: string | null;
  templateSnapshot?: string | null;
  styleSnapshot?: string | null;
  promptVersion?: string | null;
  model?: string | null;
  aiRequestId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  tokenScope?: string;
  cacheKey?: string | null;
  validationErrors?: string[];
  sourceId: string;
  styleId: string;
  accountId: string;
  text: string;
  version: number;
  valid: boolean;
  approved: boolean;
}
export interface Batch extends Base {
  mode?: PublicationMode;
  adaptation?: BroadcastAdaptation;
  cycleSeconds?: number;
  intervalSeconds?: number;
  name: string;
  approval: 'MANUAL_APPROVAL' | 'AUTO_APPROVED';
}
export interface PublishJob extends Base {
  postSubmitAt?: Date | null;
  postConfirmedAt?: Date | null;
  ctaScheduledAt?: Date | null;
  ctaSubmitAt?: Date | null;
  ctaConfirmedAt?: Date | null;
  ctaDelayNotifiedAt?: Date | null;
  ctaMediaPath?: string | null;
  ctaMediaSha256?: string | null;
  ctaCapturedAt?: Date | null;
  ctaEnabled?: boolean | null;
  plannedAt?: Date | null;
  sequence?: number;
  delayMs?: number;
  delayReason?: string | null;
  lastAttemptAt?: Date | null;
  ctaUrl?: string | null;
  ctaVersion?: number;
  ctaUpdatedAt?: Date | null;
  commentNotBefore?: Date | null;
  batchId: string;
  accountId: string;
  generatedId: string;
  scheduledAt: Date;
  status: JobStatus;
  postStatus: SendStatus;
  commentStatus: SendStatus;
  ctaText: string | null;
  attempts: number;
  lastError: string | null;
  startedAt: Date | null;
  updatedAt: Date;
  revision: number;
}
export interface Post extends Base {
  jobId: string;
  accountId: string;
  generatedId: string;
  url: string;
  externalId: string | null;
  publishedAt: Date;
}
export interface Comment extends Base {
  postId: string;
  text: string;
  url: string | null;
  status: SendStatus;
}
export interface PostMetric extends Base {
  postId: string;
  measuredAt: Date;
  targetHours: number | null;
  source: string;
  status: string;
  views: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
}
export interface AccountMetric extends Base {
  accountId: string;
  measuredAt: Date;
  followers: number | null;
  source: string;
}
export interface Cta extends Base {
  mediaPath?: string | null;
  mediaSha256?: string | null;
  accountId?: string | null;
  url?: string;
  updatedAt?: Date;
  version?: number;
  name: string;
  text: string;
  enabled: boolean;
}
export interface TrackingLink extends Base {
  permanent?: boolean;
  code: string;
  accountId: string;
  postId: string | null;
  ctaId: string | null;
  destination: string;
}
export interface Click extends Base {
  linkId: string;
  visitorHash: string;
}
export interface Invite extends Base {
  active?: boolean;
  accountId: string;
  linkId: string | null;
  inviteUrl: string;
  channelId: string;
}
export interface Membership extends Base {
  origin?: string;
  eventKey: string;
  channelId: string;
  userHash: string;
  kind: 'JOIN' | 'LEAVE';
  inviteId: string | null;
  occurredAt: Date;
}
export interface Conversion extends Base {
  eventId: string;
  linkId: string;
  accountId: string;
  postId: string | null;
}
export interface AiRequest extends Base {
  providerResponseId?: string | null;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  reasoningEffort?: string | null;
  usageJson?: string | null;
  purpose?: 'POST' | 'BIO' | 'REPLY';
  accountIds?: string[];
  accountId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: string;
  reservedUsd: number;
}
export interface SystemEvent extends Base {
  level: string;
  code: string;
  message: string;
}
export interface Audit extends Base {
  actor: string;
  action: string;
  entityId: string;
  detail: string;
}
export interface Lease extends Base {
  token: string;
  expiresAt: Date;
}
export interface Setting extends Base {
  value: string;
}
export interface EntityMap {
  contentTemplate: ContentTemplate;
  templateExample: TemplateExample;
  generationFeedback: GenerationFeedback;
  adaptationCache: AdaptationCache;
  contentPerformance: ContentPerformance;
  memberIdentity: MemberIdentity;
  memberCohort: MemberCohort;
  user: User;
  browserProfile: BrowserProfile;
  style: Style;
  styleExample: StyleExample;
  account: Account;
  source: Source;
  generated: Generated;
  batch: Batch;
  publishJob: PublishJob;
  post: Post;
  comment: Comment;
  postMetric: PostMetric;
  accountMetric: AccountMetric;
  cta: Cta;
  trackingLink: TrackingLink;
  click: Click;
  invite: Invite;
  membership: Membership;
  conversion: Conversion;
  aiRequest: AiRequest;
  systemEvent: SystemEvent;
  audit: Audit;
  lease: Lease;
  setting: Setting;
}
export type Table = keyof EntityMap;
export const tables: Table[] = [
  'contentTemplate',
  'templateExample',
  'generationFeedback',
  'adaptationCache',
  'contentPerformance',
  'memberIdentity',
  'memberCohort',
  'user',
  'browserProfile',
  'style',
  'styleExample',
  'account',
  'source',
  'generated',
  'batch',
  'publishJob',
  'post',
  'comment',
  'postMetric',
  'accountMetric',
  'cta',
  'trackingLink',
  'click',
  'invite',
  'membership',
  'conversion',
  'aiRequest',
  'systemEvent',
  'audit',
  'lease',
  'setting',
];

export type PublicationMode = 'ACCOUNT_SPECIFIC' | 'BROADCAST';
export type BroadcastAdaptation = 'COMMON' | 'PER_ACCOUNT';
export interface AdaptationCache extends Base {
  aiRequestId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  tokenScope?: string;
  text: string;
  model: string;
  instructionVersion: string;
  styleFingerprint: string;
  valid: boolean;
}
export interface ContentPerformance extends Base {
  templateId?: string | null;
  templateSnapshot?: string | null;
  postId: string;
  sourceText: string;
  finalText: string;
  topic: string;
  format: string;
  hook: string;
  textLength: number;
  hasQuestion: boolean;
}
export interface MemberIdentity extends Base {
  channelId: string;
  userHash: string;
  encryptedUserId: string;
}
export interface MemberCohort extends Base {
  exitConfirmed?: boolean;
  joinEventId: string;
  channelId: string;
  userHash: string;
  accountId: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  d7Member: boolean | null;
  d7MeasuredAt: Date | null;
  d7Status: string;
  d30Member: boolean | null;
  d30MeasuredAt: Date | null;
  d30Status: string;
}

export interface ContentTemplate extends Base {
  updatedAt: Date;
  name: string;
  instruction: string;
  version: number;
  enabled: boolean;
}
export interface TemplateExample extends Base {
  templateId: string;
  text: string;
}
export interface GenerationFeedback extends Base {
  ratedAt: Date;
  generatedId: string;
  userId: string;
  rating: 'GOOD' | 'BAD';
  sourceText: string;
  finalText: string;
  accountId: string;
  styleId: string;
  styleSnapshot: string | null;
  templateId: string | null;
  templateSnapshot: string | null;
  promptVersion: string | null;
  model: string | null;
  aiRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokenScope: string;
}
