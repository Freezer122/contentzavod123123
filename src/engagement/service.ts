import { GenerationQuality } from '../content/quality.js';
import { defaultReplyVoice, type ReplyVoice } from './reply-style.js';
import { freshness, type TimestampConfidence, type FeedSource } from './freshness.js';
import { tradingRelevance, type Strictness } from './relevance.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import { base, audit } from '../db/database.js';
import { getDocument, putDocument, listDocuments, hashDocument } from '../db/documents.js';
import { assert } from '../core/errors.js';
import type { ContentEngine } from '../content/service.js';
import { normalizeText, isRussian } from '../content/normalizer.js';
import { withProfileLease } from '../scheduler/lease.js';
import { AppError } from '../core/errors.js';
import {
  replyPrompt,
  normalizeReply,
  checkReply,
  REPLY_PROMPT_VERSION,
  replyPromptVersion,
} from './reply-style.js';
export interface SearchSchedule {
  nextSearchAt: string | null;
  lastSearchAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  lastErrorCode?: string;
  found?: number;
  eligible?: number;
  added?: number;
}
export const engagementSettings = z
  .object({
    enabled: z.boolean().default(false),
    categories: z.array(z.string().min(1).max(80)).min(1).max(10).default(['трейдинг']),
    keywords: z
      .array(z.string().min(2).max(80))
      .min(1)
      .max(30)
      .default(['торговая стратегия', 'трейдинг', 'котировки акций']),
    dailyLikes: z.number().int().min(0).max(20).default(3),
    dailyReplies: z.number().int().min(0).max(20).default(3),
    minIntervalMinutes: z.number().min(20).max(1440).default(60),
    maxIntervalMinutes: z.number().min(20).max(2880).default(180),
    maxCandidates: z.number().int().min(1).max(100).default(30),
    sessionsPerDay: z.number().int().min(1).max(6).default(3),
    likes: z.boolean().default(false),
    dailyLlmUsd: z.number().min(0).max(100).default(1),
    monthlyLlmUsd: z.number().min(0).max(1000).default(10),
    replyLength: z.enum(['VERY_SHORT', 'SHORT', 'EXPANDED']).default('SHORT'),
    replyManner: z.enum(['RESTRAINED', 'LIVELY', 'HARSH']).default('LIVELY'),
    replyProfanity: z.boolean().default(true),
    replySlang: z.boolean().default(true),
    replyHumor: z.boolean().default(true),
    automation: z.literal('OFF').default('OFF'),
    maxAgeHours: z.union([z.literal(24), z.literal(48), z.literal(72), z.literal(168)]).default(48),
    discoverySource: z.enum(['FEED', 'FOR_YOU', 'FOLLOWING', 'RECENT']).default('FEED'),
    viewLimit: z.number().int().min(1).max(100).default(40),
    strictness: z.enum(['STRICT', 'NORMAL', 'BROAD']).default('STRICT'),
    exclusions: z.array(z.string().min(2).max(80)).max(30).default([]),
  })
  .strict()
  .refine(
    (s) => s.maxIntervalMinutes >= s.minIntervalMinutes,
    'Максимальный интервал меньше минимального',
  );
export function classifyCategory(text: string, categories: string[]) {
  if (categories.some((c) => /трейд|торгов|рынк/i.test(c)) && tradingRelevance(text).accepted)
    return categories.find((c) => /трейд|торгов|рынк/i.test(c))!;
  return (
    categories.find((category) => {
      if (/трейд|торгов|рынк/i.test(category)) return tradingRelevance(text).accepted;
      if (/крипт/i.test(category)) return /крипт|биткоин|BTC|ETH|блокчейн|USDT/i.test(text);
      return text.toLowerCase().includes(category.toLowerCase());
    }) ?? 'другое'
  );
}
export type EngagementSettings = z.infer<typeof engagementSettings>;
export interface Candidate {
  id: string;
  accountId: string;
  url: string;
  author: string;
  text: string;
  language: string;
  category: string;
  discoveredAt: string;
  lastObservedAt?: string;
  publishedAt?: string;
  ageHours?: number | null;
  timestampConfidence?: TimestampConfidence;
  feedSource?: FeedSource;
  repliesAvailable: boolean;
  status: 'NEW' | 'DRAFTED' | 'REJECTED' | 'HANDLED';
  tradingRelevanceScore?: number;
  acceptedReasons?: string[];
  rejectionReasons?: string[];
  relevanceVersion?: string;
  extractionVersion?: string;
  domMetadata?: { interfaceText: string[]; counts: { label: string; text: string }[] };
}
export interface ReplyDraft {
  id: string;
  accountId: string;
  candidateId: string;
  text: string;
  hash: string;
  status: 'DRAFT' | 'APPROVED' | 'REJECTED';
  requestId?: string;
  actor?: string;
  approvedAt?: string;
  createdAt?: string;
  version?: number;
  approvalStatus?: 'DRAFT' | 'APPROVED' | 'REJECTED';
  generationState?: 'READY' | 'NEEDS_EDIT' | 'DECLINED';
  validationErrors?: string[];
  promptVersion?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  humanExampleIds?: string[];
  voiceSnapshot?: ReplyVoice;
}
export interface EngagementJob {
  executionScope?: 'AUTOPILOT';
  id: string;
  accountId: string;
  candidateId: string;
  draftId?: string;
  kind: 'REPLY' | 'LIKE';
  hash: string;
  actor: string;
  status: 'QUEUED' | 'PREVIEWED' | 'SENDING' | 'PUBLISHED' | 'UNCERTAIN' | 'FAILED';
  scheduledAt: string;
  submittedAt?: string;
  confirmedAt?: string;
  url?: string;
  error?: string;
  createdAt?: string;
  approvalStatus?: 'DRAFT' | 'APPROVED' | 'REJECTED';
  executionStatus?: 'WAITING' | 'PUBLISHING' | 'PUBLISHED' | 'UNCERTAIN' | 'FAILED';
  dryRunAt?: string;
  dryRunHash?: string;
  permissionId?: string;
  phase?:
    | 'QUEUED'
    | 'OPENING'
    | 'EDITOR_READY'
    | 'SENDING'
    | 'VERIFYING'
    | 'PUBLISHED'
    | 'UNCERTAIN'
    | 'FAILED';
  phaseAt?: string;
  clickCompletedAt?: string;
}
export interface EngagementPort {
  readPost?(
    accountId: string,
    url: string,
  ): Promise<
    Pick<
      Candidate,
      'text' | 'extractionVersion' | 'domMetadata' | 'publishedAt' | 'timestampConfidence'
    >
  >;
  search(
    accountId: string,
    settings: EngagementSettings,
    options?: { targetCandidates?: number },
  ): Promise<Omit<Candidate, 'id' | 'accountId' | 'status'>[]>;
  reply(
    job: EngagementJob,
    draft: ReplyDraft,
    candidate: Candidate,
    commit: boolean,
    beforeSend: () => Promise<void>,
    progress?: (phase: NonNullable<EngagementJob['phase']>) => Promise<void>,
  ): Promise<{ url: string | null }>;
  like(
    job: EngagementJob,
    candidate: Candidate,
    commit: boolean,
    beforeSend: () => Promise<void>,
  ): Promise<void>;
  verify?(
    job: EngagementJob,
    draft: ReplyDraft,
    candidate: Candidate,
  ): Promise<{ url: string | null }>;
}
export const executionOf = (j: EngagementJob): NonNullable<EngagementJob['executionStatus']> =>
  j.executionStatus ??
  (
    {
      SENDING: 'PUBLISHING',
      PUBLISHED: 'PUBLISHED',
      UNCERTAIN: 'UNCERTAIN',
      FAILED: 'FAILED',
    } as const
  )[j.status as 'SENDING' | 'PUBLISHED' | 'UNCERTAIN' | 'FAILED'] ??
  'WAITING';
export class EngagementManager {
  constructor(
    public db: Database,
    public port: EngagementPort,
    private content: ContentEngine,
  ) {}
  async migrateStates() {
    await this.db.transaction(async (tx) => {
      for (const row of await tx.list('setting')) {
        if (row.id.startsWith('engagement-draft-')) {
          const d = JSON.parse(row.value) as ReplyDraft;
          if (!d.approvalStatus)
            await putDocument(tx, row.id, {
              ...d,
              approvalStatus: d.status,
              version: d.version ?? 1,
              createdAt: d.createdAt ?? row.createdAt.toISOString(),
            });
        }
        if (row.id.startsWith('engagement-job-')) {
          const j = JSON.parse(row.value) as EngagementJob;
          if (!j.executionStatus) {
            const d = j.draftId
              ? await getDocument<ReplyDraft>(tx, `engagement-draft-${j.accountId}-${j.draftId}`)
              : null;
            await putDocument(tx, row.id, {
              ...j,
              approvalStatus: d?.status ?? 'APPROVED',
              executionStatus: executionOf(j),
              createdAt: j.createdAt ?? row.createdAt.toISOString(),
            });
          }
        }
      }
    });
  }
  async jobView(id: string) {
    const job = await getDocument<EngagementJob>(this.db, `engagement-job-${id}`);
    assert(job, 'NOT_FOUND', 'Задача не найдена');
    const draft = job.draftId ? await this.draft(job.accountId, job.draftId) : null;
    const candidate = await this.candidate(job.accountId, job.candidateId);
    return {
      job,
      draft,
      candidate,
      account: (await this.db.get('account', job.accountId))!,
      approvalStatus: draft?.status ?? job.approvalStatus ?? 'APPROVED',
      executionStatus: executionOf(job),
    };
  }
  async settings(accountId: string) {
    assert(await this.db.get('account', accountId), 'NOT_FOUND', 'Аккаунт не найден');
    return engagementSettings.parse(
      (await getDocument(this.db, `engagement-config-${accountId}`)) ?? {},
    );
  }
  async configure(accountId: string, patch: Partial<EngagementSettings>, actor: string) {
    const settings = engagementSettings.parse({ ...(await this.settings(accountId)), ...patch });
    await this.db.transaction(async (tx) => {
      await putDocument(tx, `engagement-config-${accountId}`, settings);
      await putDocument(tx, `llm-budget-${accountId}-REPLY`, {
        dailyUsd: settings.dailyLlmUsd,
        monthlyUsd: settings.monthlyLlmUsd,
      });
      await audit(tx, actor, 'ENGAGEMENT_CONFIG', accountId, JSON.stringify(settings));
      const schedule = await getDocument<SearchSchedule>(tx, `engagement-schedule-${accountId}`);
      await putDocument(tx, `engagement-schedule-${accountId}`, {
        ...schedule,
        nextSearchAt: settings.enabled
          ? (schedule?.nextSearchAt ?? new Date().toISOString())
          : null,
      });
    });
    return settings;
  }
  async schedule(accountId: string): Promise<SearchSchedule> {
    const saved = await getDocument<SearchSchedule>(this.db, `engagement-schedule-${accountId}`);
    if (saved) return saved;
    const config = await this.settings(accountId),
      day = new Date().toISOString().slice(0, 10);
    const previous = await getDocument<{ times: number[] }>(
      this.db,
      `engagement-search-${accountId}-${day}`,
    );
    const last = previous?.times.at(-1);
    return putDocument(this.db, `engagement-schedule-${accountId}`, {
      nextSearchAt: config.enabled
        ? new Date(
            Math.max(Date.now(), last ? last + 86400000 / config.sessionsPerDay : 0),
          ).toISOString()
        : null,
      ...(last ? { lastSearchAt: new Date(last).toISOString() } : {}),
    });
  }
  async diagnostics(accountId: string) {
    const config = await this.settings(accountId),
      schedule = await this.schedule(accountId);
    const paused = (await this.db.get('setting', 'factoryPaused'))?.value === 'true';
    const account = (await this.db.get('account', accountId))!;
    const candidates = await this.candidates(accountId),
      drafts = await this.drafts(accountId),
      jobs = await this.jobs(accountId);
    const generationError = (
      await listDocuments<{
        kind: string;
        accountId?: string;
        error?: string;
        finishedAt?: string;
        status: string;
      }>(this.db, 'generation-task-')
    )
      .filter(
        (t) =>
          t.accountId === accountId &&
          t.kind === 'REPLY' &&
          ['FAILED', 'NEEDS_REVIEW'].includes(t.status),
      )
      .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''))
      .at(-1)?.error;
    const today = new Date().toISOString().slice(0, 10),
      sent = jobs.filter((j) => j.status === 'PUBLISHED' && j.submittedAt?.startsWith(today));
    return {
      config,
      schedule,
      factoryPaused: paused,
      accountStatus: account.status,
      candidates: candidates.length,
      awaitingApproval: drafts.filter((d) => d.status === 'DRAFT').length,
      approvedQueued: jobs.filter(
        (j) =>
          j.kind === 'REPLY' &&
          executionOf(j) === 'WAITING' &&
          j.approvalStatus !== 'REJECTED' &&
          /^\d+$/.test(j.actor),
      ).length,
      approvedCount: drafts.filter((d) => d.status === 'APPROVED' && /^\d+$/.test(d.actor ?? ''))
        .length,
      publishedCount: jobs.filter((j) => executionOf(j) === 'PUBLISHED').length,
      uncertainCount: jobs.filter((j) => executionOf(j) === 'UNCERTAIN').length,
      repliesToday: sent.filter((j) => j.kind === 'REPLY').length,
      likesToday: sent.filter((j) => j.kind === 'LIKE').length,
      llm: await this.content.readiness(accountId, 'REPLY'),
      generationError,
      heartbeat: await getDocument<{ lastTickAt: string; reason: string }>(
        this.db,
        'engagement-queue-state',
      ),
    };
  }
  candidates(accountId: string) {
    return listDocuments<Candidate>(this.db, `engagement-candidate-${accountId}-`);
  }
  drafts(accountId: string) {
    return listDocuments<ReplyDraft>(this.db, `engagement-draft-${accountId}-`);
  }
  jobs(accountId?: string) {
    return listDocuments<EngagementJob>(this.db, 'engagement-job-').then((rows) =>
      accountId ? rows.filter((x) => x.accountId === accountId) : rows,
    );
  }
  async candidate(accountId: string, id: string) {
    const c = await getDocument<Candidate>(this.db, `engagement-candidate-${accountId}-${id}`);
    assert(c, 'NOT_FOUND', 'Публикация не найдена');
    return c;
  }
  async draft(accountId: string, id: string) {
    const d = await getDocument<ReplyDraft>(this.db, `engagement-draft-${accountId}-${id}`);
    assert(d, 'NOT_FOUND', 'Черновик не найден');
    return d;
  }
  assess(
    c: Pick<Candidate, 'text' | 'repliesAvailable' | 'publishedAt' | 'timestampConfidence'>,
    config: EngagementSettings,
  ) {
    const trading = config.categories.some((c) => /трейд|торгов|рынк|крипт/i.test(c));
    const result = trading
      ? tradingRelevance(
          c.text,
          config.strictness as Strictness,
          config.exclusions,
          config.keywords,
        )
      : {
          tradingRelevanceScore: 0,
          accepted: config.categories.some((x) => c.text.toLowerCase().includes(x.toLowerCase())),
          acceptedReasons: [],
          rejectionReasons: [],
          threshold: 0,
        };
    const fresh = freshness(c, config.maxAgeHours);
    const rejected = [...(fresh.reason ? [fresh.reason] : []), ...result.rejectionReasons];
    if (!isRussian(c.text)) rejected.push('Нужен русский язык');
    if (!c.repliesAvailable) rejected.push('Ответы недоступны');
    if (c.text.trim().length < 20) rejected.push('Недостаточно содержательного текста');
    if (!result.accepted && !rejected.length) rejected.push('Категория не совпадает');
    return { ...result, ...fresh, accepted: !rejected.length, rejectionReasons: rejected };
  }
  async eligibleCandidates(accountId: string) {
    const config = await this.settings(accountId);
    return (await this.candidates(accountId)).filter(
      (c) => ['NEW', 'DRAFTED'].includes(c.status) && this.assess(c, config).accepted,
    );
  }
  async refreshRelevance(accountId: string) {
    const config = await this.settings(accountId);
    const results = [];
    for (const c of await this.candidates(accountId)) {
      const r = this.assess(c, config);
      await putDocument(this.db, `engagement-candidate-${accountId}-${c.id}`, {
        ...c,
        ...r,
        relevanceVersion: 'trading-v112',
      });
      results.push({ id: c.id, url: c.url, ...r });
    }
    return results;
  }
  async search(
    accountId: string,
    actor: string,
    options: {
      manual?: boolean;
      targetCandidates?: number;
      viewLimit?: number;
      source?: EngagementSettings['discoverySource'];
      maxAgeHours?: 24 | 48;
      strictness?: Strictness;
    } = {},
  ) {
    return withProfileLease(this.db, `search-dispatch-${accountId}`, () =>
      this.runSearch(accountId, actor, options.manual ?? false, options),
    );
  }
  private async runSearch(
    accountId: string,
    actor: string,
    manual: boolean,
    options: {
      targetCandidates?: number;
      viewLimit?: number;
      source?: EngagementSettings['discoverySource'];
      maxAgeHours?: 24 | 48;
      strictness?: Strictness;
    } = {},
  ) {
    assert(
      options.targetCandidates === undefined ||
        (Number.isInteger(options.targetCandidates) &&
          options.targetCandidates >= 1 &&
          options.targetCandidates <= 20),
      'DISCOVERY_LIMIT',
      'Цель поиска: от 1 до 20',
    );
    const stored = await this.settings(accountId);
    const config = {
        ...stored,
        ...(options.source ? { discoverySource: options.source } : {}),
        ...(options.maxAgeHours ? { maxAgeHours: options.maxAgeHours } : {}),
        ...(options.strictness ? { strictness: options.strictness } : {}),
        ...(options.viewLimit ? { viewLimit: Math.min(100, Math.max(1, options.viewLimit)) } : {}),
      },
      account = (await this.db.get('account', accountId))!;
    assert(
      manual || config.enabled,
      'ENGAGEMENT_DISABLED',
      'Автопоиск выключен; можно выполнить ручной поиск без публикации',
    );
    const schedule = await this.schedule(accountId);
    assert(
      manual || (schedule.nextSearchAt && Date.parse(schedule.nextSearchAt) <= Date.now()),
      'SEARCH_INTERVAL',
      'Поисковая сессия ещё не наступила',
    );
    const day = new Date().toISOString().slice(0, 10),
      key = `engagement-search-${accountId}-${day}`;
    await this.db.transaction(async (tx) => {
      const state = (await getDocument<{ times: number[] }>(tx, key)) ?? { times: [] };
      assert(
        state.times.length < config.sessionsPerDay,
        'SEARCH_LIMIT',
        'Лимит поисковых сессий за сутки',
      );
      assert(
        manual ||
          !state.times.length ||
          Date.now() - state.times.at(-1)! >= 86400000 / config.sessionsPerDay,
        'SEARCH_INTERVAL',
        'Поисковая сессия ещё не наступила',
      );
    });
    await putDocument(this.db, `engagement-schedule-${accountId}`, {
      ...schedule,
      lastAttemptAt: new Date().toISOString(),
    });
    let found: Awaited<ReturnType<EngagementPort['search']>>;
    try {
      found = await this.port.search(accountId, config, {
        targetCandidates: options.targetCandidates,
      });
    } catch (e) {
      const message = e instanceof AppError ? e.message : 'Поиск завершился технической ошибкой';
      await putDocument(this.db, `engagement-schedule-${accountId}`, {
        ...schedule,
        lastAttemptAt: new Date().toISOString(),
        lastError: message,
        lastErrorCode: e instanceof AppError ? e.code : 'SEARCH_FAILED',
        nextSearchAt: config.enabled ? new Date(Date.now() + 15 * 60000).toISOString() : null,
      });
      throw e;
    }
    return this.db.transaction(async (tx) => {
      const old = await this.candidates(accountId);
      let added = 0;
      const suitable = new Set<string>();
      let freshCount = 0,
        thematicCount = 0;
      const observed = new Set<string>();
      for (const row of found.slice(0, config.viewLimit)) {
        let url: URL;
        try {
          url = new URL(row.url);
        } catch {
          continue;
        }
        const match = url.pathname.match(/^\/@([\w.]+)\/post\/([\w-]+)\/?$/);
        if (
          url.protocol !== 'https:' ||
          !['www.threads.com', 'threads.com'].includes(url.hostname) ||
          !match ||
          match[1]!.toLowerCase() === account.username.toLowerCase() ||
          row.author.toLowerCase() !== match[1]!.toLowerCase() ||
          !row.text.trim()
        )
          continue;
        const canonical = `https://www.threads.com/@${match[1]!.toLowerCase()}/post/${match[2]}`,
          id = hashDocument({ accountId, url: canonical }).slice(0, 24),
          doc = `engagement-candidate-${accountId}-${id}`;
        if (observed.has(canonical)) continue;
        observed.add(canonical);
        const assessment = this.assess(row, config);
        if (freshness(row, config.maxAgeHours).accepted) {
          freshCount++;
          if (assessment.accepted) thematicCount++;
        }
        if (assessment.accepted) suitable.add(canonical);
        const existingCandidate = await getDocument<Candidate>(tx, doc);
        if (existingCandidate && row.extractionVersion === 'threads-body-v115') {
          if (!existingCandidate.extractionVersion)
            await putDocument(tx, `source-extraction-before-${id}`, existingCandidate);
          await putDocument(tx, doc, {
            ...existingCandidate,
            text: row.text,
            extractionVersion: row.extractionVersion,
            domMetadata: row.domMetadata,
            lastObservedAt: row.discoveredAt,
            publishedAt: row.publishedAt ?? existingCandidate.publishedAt,
            timestampConfidence:
              row.timestampConfidence === 'EXACT' ? 'EXACT' : existingCandidate.timestampConfidence,
          });
        }
        if (
          existingCandidate ||
          old.some(
            (c) =>
              c.url
                .replace('https://threads.com/', 'https://www.threads.com/')
                .replace(/\/$/, '') === canonical,
          )
        )
          continue;
        const active = old.filter(
          (c) => ['NEW', 'DRAFTED'].includes(c.status) && this.assess(c, config).accepted,
        ).length;
        if (assessment.accepted && active + added >= config.maxCandidates) continue;
        await putDocument(tx, doc, {
          ...row,
          url: canonical,
          id,
          accountId,
          language: isRussian(row.text) ? 'ru' : 'other',
          category: classifyCategory(row.text, config.categories),
          ...assessment,
          relevanceVersion: 'trading-v112',
          status: assessment.accepted ? 'NEW' : 'REJECTED',
        } satisfies Candidate);
        if (assessment.accepted) added++;
      }
      await audit(
        tx,
        actor,
        'ENGAGEMENT_SEARCH',
        accountId,
        `Найдено ${found.length}; сохранено ${added}`,
      );
      const now = new Date();
      const state = (await getDocument<{ times: number[] }>(tx, key)) ?? { times: [] };
      state.times.push(now.getTime());
      await putDocument(tx, key, state);
      await putDocument(tx, `engagement-schedule-${accountId}`, {
        nextSearchAt: config.enabled
          ? new Date(now.getTime() + 86400000 / config.sessionsPerDay).toISOString()
          : null,
        lastSearchAt: now.toISOString(),
        lastAttemptAt: now.toISOString(),
        found: found.length,
        viewed: found.length,
        fresh: freshCount,
        thematic: thematicCount,
        eligible: suitable.size,
        added,
      });
      return {
        found: found.length,
        viewed: found.length,
        fresh: freshCount,
        thematic: thematicCount,
        added,
        eligible: suitable.size,
        drafts: (await this.drafts(accountId)).filter((d) => d.status !== 'REJECTED').length,
      };
    });
  }
  async generate(
    accountId: string,
    id: string,
    actor: string,
    options?: { force?: boolean; nonce?: string; recoverOnly?: boolean },
  ) {
    return withProfileLease(this.db, `reply-generation-${accountId}-${id}`, async () => {
      let candidate = await this.candidate(accountId, id);
      const saved = (await this.drafts(accountId)).find(
        (d) => d.candidateId === id && d.status !== 'REJECTED' && d.requestId,
      );
      if (saved && !options?.force) return saved;
      if (
        candidate.extractionVersion !== 'threads-body-v115' &&
        candidate.text.startsWith(candidate.author + '\n')
      ) {
        assert(
          this.port.readPost && !options?.recoverOnly,
          'LEGACY_SOURCE_NEEDS_REFRESH',
          'Требуется READ_ONLY-проверка старого исходника. Платного запроса нет',
        );
        const clean = await this.port.readPost(accountId, candidate.url);
        assert(
          clean.extractionVersion === 'threads-body-v115' && clean.text.trim(),
          'SOURCE_UNCERTAIN',
          'Текст исходника не подтверждён. LLM не вызвана',
        );
        await this.db.transaction(async (tx) => {
          if (!(await tx.get('setting', `source-extraction-before-${id}`)))
            await putDocument(tx, `source-extraction-before-${id}`, candidate);
          const latest = (await getDocument<Candidate>(
            tx,
            `engagement-candidate-${accountId}-${id}`,
          ))!;
          candidate = { ...latest, ...clean };
          await putDocument(tx, `engagement-candidate-${accountId}-${id}`, candidate);
        });
      }
      const assessment = this.assess(candidate, await this.settings(accountId));
      assert(
        assessment.accepted,
        'IRRELEVANT_CANDIDATE',
        'Публикация не подходит: ' + assessment.rejectionReasons.join('; '),
      );
      const existing = (await this.drafts(accountId)).find(
        (d) => d.candidateId === id && d.status !== 'REJECTED' && d.requestId,
      );
      if (existing && !options?.force) return existing;
      assert(
        !existing ||
          !options?.force ||
          !(await this.jobs(accountId)).some(
            (j) =>
              j.draftId === existing.id && ['SENDING', 'PUBLISHED', 'UNCERTAIN'].includes(j.status),
          ),
        'APPROVED_IMMUTABLE',
        'Одобренный ответ не перегенерируется автоматически; измените текст отдельно',
      );
      const c = await this.candidate(accountId, id);
      assert(c.status === 'NEW' || c.status === 'DRAFTED', 'HANDLED', 'Публикация уже обработана');
      const config = await this.settings(accountId);
      const examples = await new GenerationQuality(this.db).selectHuman(accountId, c.text, config);
      const response = await this.content.auxiliary(
        accountId,
        'REPLY',
        c.text,
        replyPrompt(config.replyLength, config, examples),
        {
          version: REPLY_PROMPT_VERSION,
          maxTokens: 180,
          allowInvalid: true,
          ...(options?.recoverOnly ? { cacheOnly: true } : {}),
          ...(options?.force ? { cacheSalt: options.nonce ?? new Date().toISOString() } : {}),
        },
      );
      return this.edit(
        accountId,
        id,
        response.text,
        actor,
        existing?.id,
        response.requestId,
        true,
        REPLY_PROMPT_VERSION,
        examples.map((e) => e.id),
        config,
      );
    });
  }
  async previewReply(accountId: string, source: string, actor: string) {
    assert(
      source.trim() && source.length <= 5000,
      'SOURCE_LENGTH',
      'Нужен исходный пост до 5000 символов',
    );
    const config = await this.settings(accountId),
      examples = await new GenerationQuality(this.db).selectHuman(accountId, source, config);
    const result = await this.content.auxiliary(
      accountId,
      'REPLY',
      source,
      replyPrompt(config.replyLength, config, examples),
      { version: REPLY_PROMPT_VERSION, maxTokens: 180, allowInvalid: true },
    );
    const text = normalizeReply(result.text),
      errors = checkReply(text, source, config.replyLength, config);
    if (
      examples.some(
        (e) =>
          normalizeReply(e.answer) === text && normalizeReply(e.source) !== normalizeReply(source),
      )
    )
      errors.push('Дословное повторение человеческого примера');
    const request = await this.db.get('aiRequest', result.requestId),
      id = hashDocument({
        accountId,
        source,
        voice: config,
        text,
        requestId: result.requestId,
      }).slice(0, 32);
    return putDocument(this.db, `reply-preview-${id}`, {
      id,
      accountId,
      source,
      text,
      actor,
      errors,
      settings: config,
      humanExampleIds: examples.map((e) => e.id),
      promptVersion: REPLY_PROMPT_VERSION,
      requestId: result.requestId,
      inputTokens: request?.inputTokens,
      outputTokens: request?.outputTokens,
      costUsd: request?.costUsd,
      model: request?.model,
      createdAt: new Date().toISOString(),
      kind: 'STYLE_PREVIEW_NO_PUBLICATION',
    });
  }
  async edit(
    accountId: string,
    candidateId: string,
    text: string,
    actor: string,
    draftId?: string,
    requestId?: string,
    generated = false,
    promptVersion = REPLY_PROMPT_VERSION,
    humanExampleIds: string[] = [],
    voiceSnapshot?: ReplyVoice,
  ) {
    text = normalizeReply(text);
    const config = await this.settings(accountId),
      c = await this.candidate(accountId, candidateId);
    const errors = checkReply(text, c.text, config.replyLength, config);
    const skipped = text === '[skip]';
    if (
      generated &&
      (await new GenerationQuality(this.db).humanExamples(accountId)).some(
        (e) =>
          normalizeReply(e.answer) === text && normalizeReply(e.source) !== normalizeReply(c.text),
      )
    )
      errors.push('Дословное повторение человеческого примера в другом обсуждении');
    const request = requestId ? await this.db.get('aiRequest', requestId) : null;
    if (!generated)
      assert(
        isRussian(text) &&
          [...text].length > 0 &&
          [...text].length <= 500 &&
          !/t\.me\/|подпиш|шапке профиля|мой канал/i.test(text),
        'INVALID_REPLY',
        'Нужен содержательный русский ответ без рекламы',
      );
    return this.db.transaction(async (tx) => {
      const currentCandidate = (await getDocument<Candidate>(
        tx,
        `engagement-candidate-${accountId}-${candidateId}`,
      ))!;
      assert(
        currentCandidate && !['HANDLED', 'REJECTED'].includes(currentCandidate.status),
        'HANDLED',
        'Публикация уже обработана',
      );
      const jobs = await listDocuments<EngagementJob>(tx, 'engagement-job-');
      assert(
        !jobs.some(
          (j) =>
            j.draftId === draftId &&
            draftId &&
            ['SENDING', 'PUBLISHED', 'UNCERTAIN'].includes(j.status),
        ),
        'ALREADY_SENT',
        'Отправляемый или опубликованный ответ нельзя изменить',
      );
      const previous = draftId
        ? await getDocument<ReplyDraft>(tx, `engagement-draft-${accountId}-${draftId}`)
        : null;
      if (draftId)
        assert(
          previous && previous.status !== 'REJECTED',
          'REJECTED',
          'Черновик отклонён или не найден',
        );
      const all = await listDocuments<ReplyDraft>(tx, `engagement-draft-${accountId}-`);
      const duplicate = all.some(
        (d) => d.candidateId !== candidateId && d.text === text && d.status !== 'REJECTED',
      );
      if (duplicate) {
        if (generated) errors.push('Повтор другого ответа');
        else assert(false, 'DUPLICATE_REPLY', 'Такой ответ уже использован');
      }
      const id = draftId ?? randomUUID();
      const draft: ReplyDraft = {
        id,
        accountId,
        candidateId,
        text,
        hash: hashDocument({ url: currentCandidate.url, text }),
        status: 'DRAFT',
        approvalStatus: 'DRAFT',
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        version: (previous?.version ?? 0) + 1,
        requestId: requestId ?? previous?.requestId,
        generationState: skipped ? 'DECLINED' : errors.length ? 'NEEDS_EDIT' : 'READY',
        validationErrors: skipped ? ['Нет уместного содержательного ответа'] : errors,
        ...(generated
          ? {
              promptVersion,
              humanExampleIds,
              voiceSnapshot,
              model: request?.model,
              inputTokens: request?.inputTokens,
              outputTokens: request?.outputTokens,
              costUsd: request?.costUsd,
            }
          : {}),
      };
      await putDocument(tx, `engagement-draft-${accountId}-${id}`, draft);
      for (const j of jobs.filter(
        (j) => j.draftId === id && ['QUEUED', 'PREVIEWED'].includes(j.status),
      ))
        await putDocument(tx, `engagement-job-${j.id}`, {
          ...j,
          status: 'FAILED',
          approvalStatus: 'DRAFT',
          executionStatus: 'FAILED',
          error: 'Текст изменён; требуется новое одобрение',
        });
      await putDocument(tx, `engagement-candidate-${accountId}-${candidateId}`, {
        ...currentCandidate,
        status: 'DRAFTED',
      });
      await audit(tx, actor, 'ENGAGEMENT_DRAFT', id, draft.hash);
      return draft;
    });
  }
  async reject(accountId: string, id: string, actor: string) {
    await this.db.transaction(async (tx) => {
      const d = await getDocument<ReplyDraft>(tx, `engagement-draft-${accountId}-${id}`);
      assert(d, 'NOT_FOUND', 'Черновик не найден');
      const jobs = await listDocuments<EngagementJob>(tx, 'engagement-job-');
      assert(
        !jobs.some(
          (j) => j.draftId === id && ['SENDING', 'PUBLISHED', 'UNCERTAIN'].includes(j.status),
        ),
        'ALREADY_SENT',
        'Результат отправки уже фиксируется',
      );
      await putDocument(tx, `engagement-draft-${accountId}-${id}`, {
        ...d,
        status: 'REJECTED',
        approvalStatus: 'REJECTED',
      });
      for (const j of jobs.filter((j) => j.draftId === id))
        await putDocument(tx, `engagement-job-${j.id}`, {
          ...j,
          status: 'FAILED',
          approvalStatus: 'REJECTED',
          executionStatus: 'FAILED',
          error: 'Отклонено пользователем',
        });
      const c = await getDocument<Candidate>(
        tx,
        `engagement-candidate-${accountId}-${d.candidateId}`,
      );
      await putDocument(tx, `engagement-candidate-${accountId}-${d.candidateId}`, {
        ...c,
        status: 'REJECTED',
      });
      await audit(tx, actor, 'ENGAGEMENT_REJECTED', id);
    });
  }
  async approveLike(accountId: string, candidateId: string, hash: string, actor: string) {
    const candidate = await this.candidate(accountId, candidateId),
      expected = hashDocument({ kind: 'LIKE', url: candidate.url });
    assert(hash === expected, 'STALE_APPROVAL', 'Предпросмотр лайка устарел');
    const config = await this.settings(accountId);
    assert(config.likes && config.enabled, 'LIKES_DISABLED', 'Лайки отключены');
    return this.db.transaction(async (tx) => {
      const candidate = await this.candidate(accountId, candidateId);
      assert(
        candidate.status !== 'REJECTED' && candidate.status !== 'HANDLED',
        'HANDLED',
        'Публикация уже обработана',
      );
      const jobs = (await listDocuments<EngagementJob>(tx, 'engagement-job-')).filter(
        (j) =>
          j.accountId === accountId &&
          j.kind === 'LIKE' &&
          !['FAILED', 'PREVIEWED'].includes(j.status),
      );
      assert(
        !jobs.some((j) => j.candidateId === candidateId),
        'DUPLICATE_LIKE',
        'Лайк уже подтверждён или его результат неизвестен',
      );
      assert(
        jobs.filter((j) => j.scheduledAt.startsWith(new Date().toISOString().slice(0, 10))).length <
          config.dailyLikes,
        'DAILY_LIMIT',
        'Лимит лайков',
      );
      const last = jobs.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).at(-1);
      const job: EngagementJob = {
        id: randomUUID(),
        accountId,
        candidateId,
        kind: 'LIKE',
        hash,
        actor,
        status: 'QUEUED',
        scheduledAt: new Date(
          Math.max(
            Date.now(),
            last ? Date.parse(last.scheduledAt) + config.minIntervalMinutes * 60000 : 0,
          ),
        ).toISOString(),
      };
      await putDocument(tx, `engagement-job-${job.id}`, job);
      await audit(tx, actor, 'ENGAGEMENT_LIKE_APPROVED', job.id, hash);
      return job;
    });
  }
  async approve(accountId: string, id: string, hash: string, actor: string) {
    return this.db.transaction(async (tx) => {
      const d = await getDocument<ReplyDraft>(tx, `engagement-draft-${accountId}-${id}`);
      if (d?.status === 'APPROVED' && d.hash === hash) {
        const old = (await listDocuments<EngagementJob>(tx, 'engagement-job-')).find(
          (j) => j.draftId === id && j.hash === hash && j.status !== 'FAILED',
        );
        if (old) return old;
      }
      assert(
        d && d.hash === hash && d.status === 'DRAFT',
        'STALE_APPROVAL',
        'Предпросмотр устарел',
      );
      assert(
        !d.generationState || d.generationState === 'READY',
        'NEEDS_EDIT',
        'Ответ требует ручной правки перед одобрением',
      );
      const candidate = await this.candidate(accountId, d.candidateId);
      const voice = await this.settings(accountId);
      const errors = checkReply(d.text, candidate.text, voice.replyLength, voice);
      assert(!errors.length, 'NEEDS_EDIT', 'Ответ требует ручной правки: ' + errors.join('; '));
      assert(
        candidate.status !== 'REJECTED' && candidate.status !== 'HANDLED',
        'HANDLED',
        'Публикация уже обработана',
      );
      const jobs = (await listDocuments<EngagementJob>(tx, 'engagement-job-')).filter(
        (j) => j.accountId === accountId,
      );
      assert(
        !jobs.some(
          (j) =>
            j.candidateId === d.candidateId &&
            j.kind === 'REPLY' &&
            !['FAILED', 'PREVIEWED'].includes(j.status),
        ),
        'DUPLICATE_REPLY',
        'Для публикации уже есть задача или неопределённый результат',
      );
      const config = await this.settings(accountId),
        today = new Date().toISOString().slice(0, 10),
        daily = jobs.filter(
          (j) =>
            j.kind === 'REPLY' &&
            j.scheduledAt.startsWith(today) &&
            !['FAILED', 'PREVIEWED'].includes(j.status),
        );
      assert(daily.length < config.dailyReplies, 'DAILY_LIMIT', 'Дневной лимит ответов');
      const last = jobs
        .filter((j) => !['FAILED', 'PREVIEWED'].includes(j.status))
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
        .at(-1);
      const interval =
        (config.minIntervalMinutes +
          Math.random() * (config.maxIntervalMinutes - config.minIntervalMinutes)) *
        60000;
      const scheduledAt = new Date(
        Math.max(Date.now(), last ? Date.parse(last.scheduledAt) + interval : 0),
      ).toISOString();
      const job: EngagementJob = {
        id: randomUUID(),
        accountId,
        candidateId: d.candidateId,
        draftId: id,
        kind: 'REPLY',
        approvalStatus: 'APPROVED',
        executionStatus: 'WAITING',
        createdAt: new Date().toISOString(),
        hash,
        actor,
        status: 'QUEUED',
        scheduledAt,
      };
      await putDocument(tx, `engagement-draft-${accountId}-${id}`, {
        ...d,
        status: 'APPROVED',
        approvalStatus: 'APPROVED',
        actor,
        approvedAt: new Date().toISOString(),
      });
      await putDocument(tx, `engagement-job-${job.id}`, job);
      await audit(tx, actor, 'ENGAGEMENT_APPROVED', job.id, hash);
      return job;
    });
  }
}
