import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import { audit, base } from '../db/database.js';
import { getDocument, putDocument, listDocuments, hashDocument } from '../db/documents.js';
import { assert, AppError } from '../core/errors.js';
import { assertNotEmergency } from '../policy/manual.js';
import { localTime, minutes, nextDay, remainingSlots } from './schedule.js';
import { canonicalText, qualityGate, operationalQuality, similarity } from './quality.js';
import type { EngagementJob, Candidate, ReplyDraft } from '../engagement/service.js';
import { CtaService, ctaSignature, renderCta } from '../cta/service.js';
import { ctaKey, type CtaTask } from '../cta/tasks.js';
export const autopilotConfig = z
  .object({
    posts: z.number().int().min(0).max(10).default(5),
    replies: z.number().int().min(0).max(20).default(20),
    timezone: z
      .string()
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, 'Неизвестный часовой пояс')
      .default('Europe/Moscow'),
    start: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .default('09:00'),
    end: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .default('22:00'),
    postIntervalMinutes: z.number().int().min(20).max(1440).default(90),
    replyIntervalMinutes: z.number().int().min(20).max(1440).default(30),
    allowCTA: z.boolean().default(false),
    quiet: z.boolean().default(true),
    maxAgeHours: z.union([z.literal(24), z.literal(48)]).default(48),
    viralThreshold: z.number().min(0).max(100).default(45),
    sources: z
      .array(z.enum(['FEED', 'FOR_YOU', 'FOLLOWING', 'RECENT']))
      .min(1)
      .max(4)
      .default(['FOR_YOU', 'RECENT']),
    formats: z
      .array(z.enum(['OBSERVATION', 'IRONY', 'OPINION', 'THESIS', 'JOKE', 'QUESTION', 'ANALYSIS']))
      .min(1)
      .max(7)
      .default(['OBSERVATION', 'IRONY', 'OPINION', 'QUESTION']),
    topic: z.literal('трейдинг').default('трейдинг'),
  })
  .strict()
  .refine((c) => minutes(c.start) < minutes(c.end), 'Начало окна должно быть раньше конца');
export type AutopilotConfig = z.infer<typeof autopilotConfig>;
export interface AutopilotState {
  accountId: string;
  state: 'OFF' | 'READY' | 'RUNNING' | 'PAUSED' | 'ERROR';
  config: AutopilotConfig;
  version: number;
  epoch: number;
  enabledAt?: string;
  enabledBy?: string;
  mode: 'DRY_RUN' | 'LIVE';
  error?: string;
  consecutiveErrors: number;
  updatedAt: string;
}
export interface AutoGrant {
  jobId: string;
  kind: 'POST' | 'REPLY';
  accountId: string;
  epoch: number;
  version: number;
  enabledAt: string;
  createdAt: string;
  mode: 'DRY_RUN' | 'LIVE';
  hash: string;
  textVersion: number;
  sourceUrl: string;
  sourceText: string;
  sourcePublishedAt: string;
  sourceConfidence: string;
  sourceId: string;
  generatedId?: string;
  draftId?: string;
  quality: ReturnType<typeof qualityGate>;
  topic: string;
  format: string;
  ctaHash?: string;
  evergreen?: boolean;
}
export interface AutoWork {
  dryRevalidateFrom?: string;
  slotId?: string;
  evergreen?: boolean;
  id: string;
  accountId: string;
  epoch: number;
  version: number;
  enabledAt: string;
  createdAt: string;
  scheduledAt: string;
  kind: 'DISCOVER' | 'POST' | 'REPLY' | 'STATS';
  mode: 'DRY_RUN' | 'LIVE';
  status:
    | 'QUEUED'
    | 'RUNNING'
    | 'SCHEDULED'
    | 'PREVIEWED'
    | 'PUBLISHED'
    | 'NEEDS_REVIEW'
    | 'REJECTED'
    | 'SKIPPED'
    | 'ERROR'
    | 'UNCERTAIN';
  candidateId?: string;
  resultId?: string;
  reasons?: string[];
  error?: string;
  generationStartedAt?: string;
  requestId?: string;
  text?: string;
  finishedAt?: string;
}
export class AutopilotPolicy {
  constructor(
    public db: Database,
    private owner: string,
    private allowedProfiles: string[] = [],
  ) {}
  async settings(accountId: string, db = this.db): Promise<AutopilotState> {
    const saved = await getDocument<AutopilotState>(db, `autopilot-account-${accountId}`);
    return (
      saved ?? {
        accountId,
        state: 'OFF',
        config: autopilotConfig.parse({}),
        version: 1,
        epoch: 0,
        mode: 'DRY_RUN',
        consecutiveErrors: 0,
        updatedAt: new Date().toISOString(),
      }
    );
  }
  private assertOwner(actor: string) {
    assert(
      actor === this.owner && /^\d+$/.test(actor),
      'OWNER_REQUIRED',
      'Автопилотом управляет только владелец',
    );
  }
  private async revokePending(accountId: string, tx: Database) {
    for (const grant of await listDocuments<AutoGrant>(tx, 'autopilot-grant-')) {
      if (grant.accountId !== accountId) continue;
      if (grant.kind === 'POST') {
        const job = await tx.get('publishJob', grant.jobId);
        if (job?.status === 'QUEUED' && !job.postSubmitAt)
          await tx.update('publishJob', job.id, {
            status: 'PAUSED',
            revision: job.revision + 1,
            lastError: 'AUTOPILOT_REVOKED: очередь прежнего запуска не возобновляется',
            updatedAt: new Date(),
          });
      } else {
        const job = await getDocument<EngagementJob>(tx, `engagement-job-${grant.jobId}`);
        if (job && ['QUEUED', 'PREVIEWED'].includes(job.status) && !job.submittedAt)
          await putDocument(tx, `engagement-job-${job.id}`, {
            ...job,
            status: 'FAILED',
            executionStatus: 'FAILED',
            error: 'AUTOPILOT_REVOKED: не отправлено, требуется новое отдельное решение',
          });
      }
    }
    for (const work of (await this.works(tx)).filter(
      (w) => w.accountId === accountId && w.status === 'QUEUED',
    ))
      await putDocument(tx, `autopilot-work-${work.id}`, {
        ...work,
        status: 'SKIPPED',
        reasons: ['AUTOPILOT_REVOKED'],
      });
  }
  async configure(accountId: string, patch: unknown, actor: string) {
    this.assertOwner(actor);
    if (Object.keys(patch as object).length === 1 && 'allowCTA' in (patch as object))
      return this.setCta(accountId, z.boolean().parse((patch as any).allowCTA), actor);
    return this.db.transaction(async (tx) => {
      const s = await this.settings(accountId, tx),
        config = autopilotConfig.parse({ ...s.config, ...(patch as object) });
      const next = {
        ...s,
        config,
        version: s.version + 1,
        epoch: s.epoch + 1,
        state: s.state === 'OFF' ? ('OFF' as const) : ('PAUSED' as const),
        updatedAt: new Date().toISOString(),
      };
      await this.revokePending(accountId, tx);
      await putDocument(tx, `autopilot-account-${accountId}`, next);
      await audit(
        tx,
        actor,
        'AUTOPILOT_CONFIG',
        accountId,
        JSON.stringify({ version: next.version, config }),
      );
      return next;
    });
  }
  async setCta(accountId: string, enabled: boolean, actor: string, expectedSignature?: string) {
    this.assertOwner(actor);
    return this.db.transaction(async (tx) => {
      const c = await new CtaService(tx).ensure(accountId);
      const state = await this.settings(accountId, tx);
      assert(
        !expectedSignature || expectedSignature === ctaSignature(c),
        'STALE_CTA',
        'CTA изменён; откройте новый предпросмотр',
      );
      assert(!enabled || c.text.trim(), 'CTA_REQUIRED', 'CTA не настроен');
      await new CtaService(tx).setEnabled(accountId, enabled, actor);
      await putDocument(tx, `autopilot-account-${accountId}`, {
        ...state,
        config: { ...state.config, allowCTA: enabled },
      });
      return this.settings(accountId, tx);
    });
  }
  assertCtaOwner(actor: string) {
    this.assertOwner(actor);
  }
  async validateCta(jobId: string, db: Database = this.db) {
    await assertNotEmergency(db);
    const j = await db.get('publishJob', jobId),
      t = await getDocument<CtaTask>(db, ctaKey(jobId));
    assert(
      j?.postStatus === 'PUBLISHED' && t,
      'CTA_PARENT',
      'Нет подтверждённого родительского поста или дочерней задачи',
    );
    const p = await db.get('post', t.parentPostId),
      a = await db.get('account', t.accountId);
    assert(
      a?.status === 'ACTIVE' &&
        j.accountId === t.accountId &&
        p?.jobId === jobId &&
        p.url === t.parentPermalink &&
        p.accountId === t.accountId,
      'CTA_PARENT',
      'Родительский пост не подтверждён',
    );
    const c = await new CtaService(db).ensure(t.accountId);
    if (!t.manualRequestedBy)
      assert(
        (await this.settings(t.accountId, db)).config.allowCTA,
        'CTA_DISABLED',
        'CTA выключен в автопилоте',
      );
    assert(
      t.status === 'WAITING',
      'CTA_ALREADY_STARTED',
      'CTA уже отправляется, опубликован или требует сверки',
    );
    assert(
      t.contentHash === hashDocument(renderCta(c.text, c.url)) &&
        (c.version ?? 1) === t.ctaVersion &&
        (c.mediaSha256 ?? null) === t.imageHash,
      'CTA_CHANGED',
      'Сохранённый CTA изменён после создания задачи',
    );
    if (t.manualRequestedBy) this.assertOwner(t.manualRequestedBy);
    else {
      const g = await getDocument<AutoGrant>(db, `autopilot-grant-${jobId}`);
      assert(g, 'AUTOPILOT_SCOPE', 'Нет исходного разрешения автопилота');
      const s = await this.assertWork(g, db, Date.now(), false, true);
      assert(s.config.allowCTA, 'CTA_DISABLED', 'CTA выключен в автопилоте');
    }
    return (await getDocument<AutoGrant>(db, `autopilot-grant-${jobId}`))!;
  }
  async launchCard(accountId: string, actor: string, mode: 'DRY_RUN' | 'LIVE') {
    this.assertOwner(actor);
    return this.db.transaction(async (tx) => {
      const s = await this.settings(accountId, tx),
        id = randomUUID().replaceAll('-', '').slice(0, 24);
      if (s.state !== 'RUNNING')
        await putDocument(tx, `autopilot-account-${accountId}`, {
          ...s,
          state: 'READY',
          updatedAt: new Date().toISOString(),
        });
      await putDocument(tx, `autopilot-launch-${id}`, {
        id,
        accountId,
        actor,
        mode,
        version: s.version,
        epoch: s.epoch,
        hash: hashDocument(s.config),
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        used: false,
      });
      return id;
    });
  }

  async start(id: string, actor: string) {
    this.assertOwner(actor);
    return this.db.transaction(async (tx) => {
      const c = await getDocument<any>(tx, `autopilot-launch-${id}`);
      assert(
        c && c.actor === actor && !c.used && Date.parse(c.expiresAt) > Date.now(),
        'STALE_CONFIRMATION',
        'Откройте новый предпросмотр запуска',
      );
      const s = await this.settings(c.accountId, tx);
      assert(
        s.state !== 'RUNNING' &&
          s.version === c.version &&
          s.epoch === c.epoch &&
          hashDocument(s.config) === c.hash,
        'STALE_CONFIRMATION',
        'Настройки изменились или автопилот уже работает',
      );
      await assertNotEmergency(tx);
      const a = await tx.get('account', s.accountId),
        p = a ? await tx.get('browserProfile', a.profileId) : null;
      assert(
        a?.status === 'ACTIVE' &&
          p &&
          (!this.allowedProfiles.length || this.allowedProfiles.includes(p.externalId)),
        'ACCOUNT_UNAVAILABLE',
        'Выбранный аккаунт не разрешён для браузера',
      );
      if (c.mode === 'LIVE')
        assert(
          (await getDocument<any>(tx, 'autopilot-readiness-v116'))?.passed,
          'NOT_READY',
          'Сначала требуется приёмка DRY_RUN',
        );
      const next: AutopilotState = {
        ...s,
        state: 'RUNNING',
        mode: c.mode,
        epoch: s.epoch + 1,
        enabledAt: new Date().toISOString(),
        enabledBy: actor,
        error: undefined,
        consecutiveErrors: 0,
        updatedAt: new Date().toISOString(),
      };
      await this.revokePending(s.accountId, tx);
      await putDocument(tx, `autopilot-account-${s.accountId}`, next);
      await putDocument(tx, `autopilot-launch-${id}`, { ...c, used: true });
      // Only scoped new work may pass the legacy factory pause. Old queues remain gated by v112.
      await putDocument(tx, 'automationPaused', false);
      const day = localTime(Date.now(), next.config.timezone).day;
      for (const d of [day, nextDay(day)])
        await putDocument(tx, `autopilot-plan-${s.accountId}-${next.epoch}-${d}`, {
          accountId: s.accountId,
          epoch: next.epoch,
          day: d,
          schemaVersion: 117,
          createdAt: new Date().toISOString(),
          slots: remainingSlots(
            s.accountId,
            next.epoch,
            d,
            next.config,
            Date.now(),
            d === day ? await this.sent(s.accountId, Date.now(), tx) : { posts: 0, replies: 0 },
          ),
        });
      await audit(tx, actor, 'AUTOPILOT_START', s.accountId, JSON.stringify(next));
      return next;
    });
  }
  async pause(accountId: string, actor: string, off = false) {
    this.assertOwner(actor);
    return this.db.transaction(async (tx) => {
      const s = await this.settings(accountId, tx);
      const next = {
        ...s,
        state: off ? ('OFF' as const) : ('PAUSED' as const),
        epoch: s.epoch + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.revokePending(accountId, tx);
      await putDocument(tx, `autopilot-account-${accountId}`, next);
      await audit(tx, actor, off ? 'AUTOPILOT_OFF' : 'AUTOPILOT_PAUSE', accountId);
      return next;
    });
  }
  works(db = this.db) {
    return listDocuments<AutoWork>(db, 'autopilot-work-');
  }
  async sent(accountId: string, at = Date.now(), db = this.db) {
    const c = (await this.settings(accountId, db)).config,
      day = localTime(at, c.timezone).day;
    const jobs = (await db.list('publishJob', { accountId })).filter(
      (j) => j.postSubmitAt && localTime(j.postSubmitAt.getTime(), c.timezone).day === day,
    );
    const replies = (await listDocuments<EngagementJob>(db, 'engagement-job-')).filter(
      (j) =>
        j.accountId === accountId &&
        j.kind === 'REPLY' &&
        j.submittedAt &&
        localTime(Date.parse(j.submittedAt), c.timezone).day === day,
    );
    return {
      posts: jobs.length,
      replies: replies.length,
      lastPost: Math.max(0, ...jobs.map((j) => j.postSubmitAt!.getTime())),
      lastReply: Math.max(0, ...replies.map((j) => Date.parse(j.submittedAt!))),
    };
  }
  async assertWork(
    w: Pick<AutoWork, 'accountId' | 'epoch' | 'version' | 'enabledAt' | 'createdAt' | 'mode'>,
    db = this.db,
    at = Date.now(),
    allowOutsideDry = false,
    preparing = false,
  ) {
    await assertNotEmergency(db);
    const s = await this.settings(w.accountId, db);
    assert(
      s.state === 'RUNNING' &&
        s.epoch === w.epoch &&
        s.version === w.version &&
        s.enabledAt === w.enabledAt &&
        s.mode === w.mode &&
        Date.parse(w.createdAt) >= Date.parse(s.enabledAt!),
      'AUTOPILOT_REVOKED',
      'Разрешение автопилота отозвано или задача создана до запуска',
    );
    assert(
      (await db.get('setting', 'automationPaused'))?.value !== 'true',
      'AUTOMATION_PAUSED',
      'Автоматика приостановлена',
    );
    const a = await db.get('account', w.accountId),
      p = a ? await db.get('browserProfile', a.profileId) : null;
    assert(
      a?.status === 'ACTIVE' &&
        p &&
        (!this.allowedProfiles.length || this.allowedProfiles.includes(p.externalId)),
      'ACCOUNT_UNAVAILABLE',
      'Аккаунт или профиль не разрешён',
    );
    const t = localTime(at, s.config.timezone);
    assert(
      preparing ||
        (allowOutsideDry && w.mode === 'DRY_RUN') ||
        (t.minute >= minutes(s.config.start) && t.minute < minutes(s.config.end)),
      'OUTSIDE_WINDOW',
      'Вне дневного окна',
    );
    return s;
  }
  async validate(
    jobId: string,
    kind: 'POST' | 'REPLY',
    db = this.db,
    at = Date.now(),
    cta = false,
  ) {
    if (cta) return this.validateCta(jobId, db);
    const g = await getDocument<AutoGrant>(db, `autopilot-grant-${jobId}`);
    assert(
      g && g.jobId === jobId && g.kind === kind && g.mode === 'LIVE',
      'AUTOPILOT_SCOPE',
      'Нет разрешения AUTOPILOT LIVE для этой задачи',
    );
    const s = await this.assertWork(g, db, at);
    const counts = await this.sent(g.accountId, at, db),
      own =
        kind === 'POST'
          ? await db.get('publishJob', jobId)
          : await getDocument<EngagementJob>(db, `engagement-job-${jobId}`);
    assert(
      own &&
        own.accountId === g.accountId &&
        own.createdAt &&
        new Date(own.createdAt).getTime() >= Date.parse(s.enabledAt!),
      'OLD_JOB',
      'Старая очередь не разрешена',
    );
    assert(
      kind === 'POST'
        ? (own as any).generatedId === g.generatedId
        : (own as EngagementJob).kind === 'REPLY' &&
            (own as EngagementJob).draftId === g.draftId &&
            (own as EngagementJob).candidateId === g.sourceId,
      'AUTOPILOT_ENTITY_CHANGED',
      'Ссылка задачи на текст или исходник изменилась',
    );
    assert(
      at >= new Date(own.scheduledAt).getTime(),
      'NOT_DUE',
      'Запланированное время ещё не наступило',
    );
    const submitted = kind === 'POST' ? (own as any).postSubmitAt : (own as any).submittedAt;
    assert(
      submitted || at - new Date(own.scheduledAt).getTime() <= 10 * 60000,
      'MISSED_SLOT',
      'Старый слот пропущен без догоняющей отправки',
    );
    const n = kind === 'POST' ? counts.posts : counts.replies,
      cap = kind === 'POST' ? s.config.posts : s.config.replies;
    assert(n - (submitted ? 1 : 0) < cap, 'AUTOPILOT_DAILY_LIMIT', 'Суточный максимум автопилота');
    const last = kind === 'POST' ? counts.lastPost : counts.lastReply,
      interval =
        (kind === 'POST' ? s.config.postIntervalMinutes : s.config.replyIntervalMinutes) * 60000;
    assert(
      submitted || !last || at - last >= interval,
      'AUTOPILOT_INTERVAL',
      'Минимальный интервал автопилота',
    );
    assert(
      (g.evergreen && kind === 'POST' && (await db.get('source', g.sourceId))?.rights === 'OWN') ||
        (g.sourceConfidence === 'EXACT' &&
          Date.parse(g.sourcePublishedAt) <= at + 60000 &&
          at - Date.parse(g.sourcePublishedAt) <= s.config.maxAgeHours * 3600000),
      'STALE_SOURCE',
      'Источник устарел или дата не подтверждена',
    );
    const d =
      kind === 'POST'
        ? await db.get('generated', g.generatedId!)
        : await getDocument<ReplyDraft>(db, `engagement-draft-${g.accountId}-${g.draftId}`);
    assert(
      d && hashDocument(d.text) === g.hash && (d.version ?? 1) === g.textVersion,
      'AUTOPILOT_TEXT_CHANGED',
      'Текст или версия изменились',
    );
    const q = operationalQuality(
      kind,
      d.text,
      g.sourceText,
      await this.previousTexts(db, g.generatedId, g.draftId),
    );
    assert(
      q.decision !== 'BLOCKED',
      'AUTOPILOT_QUALITY',
      'Требуется проверка качества: ' + q.reasons.join(', '),
    );
    return g;
  }
  async previousTexts(db = this.db, generatedId?: string, draftId?: string) {
    return [
      ...(await db.list('generated')).filter((d) => d.id !== generatedId).map((d) => d.text),
      ...(await listDocuments<ReplyDraft>(db, 'engagement-draft-'))
        .filter((d) => d.id !== draftId)
        .map((d) => d.text),
    ];
  }
  async claim(w: AutoWork, c: Candidate) {
    return this.db.transaction(async (tx) => {
      const key = `autopilot-source-${hashDocument(c.url.replace(/\/$/, '')).slice(0, 40)}`;
      const old = await getDocument<any>(tx, key);
      if (old?.workId === w.id) return;
      assert(!old, 'GLOBAL_SOURCE_DUPLICATE', 'Источник уже использован автопилотом');
      assert(
        !(await tx.list('source')).some(
          (s) => s.url?.replace(/\/$/, '') === c.url.replace(/\/$/, ''),
        ),
        'GLOBAL_SOURCE_DUPLICATE',
        'Исходник уже сохранён в другой очереди',
      );
      const other = (await this.works(tx)).filter((x) => x.id !== w.id && x.candidateId === c.id);
      assert(!other.length, 'GLOBAL_TASK_DUPLICATE', 'Кандидат уже зарезервирован');
      const jobs = await listDocuments<EngagementJob>(tx, 'engagement-job-');
      const candidates = await listDocuments<Candidate>(tx, 'engagement-candidate-');
      assert(
        !jobs.some(
          (j) =>
            candidates.find((x) => x.accountId === j.accountId && x.id === j.candidateId)?.url ===
            c.url,
        ),
        'GLOBAL_SOURCE_DUPLICATE',
        'По этому исходнику уже есть взаимодействие',
      );
      if (w.kind === 'POST') {
        const ideas = await listDocuments<any>(tx, 'autopilot-idea-');
        assert(
          !ideas.some((x) => x.workId !== w.id && similarity(c.text, x.sourceText) >= 0.75),
          'GLOBAL_IDEA_DUPLICATE',
          'Повторяется идея',
        );
        await putDocument(tx, `autopilot-idea-${w.id}`, {
          workId: w.id,
          sourceUrl: c.url,
          sourceText: c.text,
          key: hashDocument(canonicalText(c.text)),
          createdAt: w.createdAt,
        });
      }
      await putDocument(tx, key, {
        workId: w.id,
        accountId: w.accountId,
        url: c.url,
        createdAt: w.createdAt,
      });
    });
  }
  async success(accountId: string) {
    const s = await this.settings(accountId);
    if (s.state === 'RUNNING' && (s.consecutiveErrors || s.error))
      await putDocument(this.db, `autopilot-account-${accountId}`, {
        ...s,
        consecutiveErrors: 0,
        error: undefined,
      });
  }
  async failure(accountId: string, error: unknown) {
    const code = error instanceof AppError ? error.code : 'AUTOPILOT_INTERNAL';
    if (
      [
        'PROFILE_BUSY',
        'PUBLISH_PRIORITY',
        'AUTOPILOT_REVOKED',
        'MISSED_SLOT',
        'OUTSIDE_WINDOW',
        'AUTOMATION_PAUSED',
      ].includes(code)
    )
      return;
    await this.db.transaction(async (tx) => {
      const s = await this.settings(accountId, tx);
      if (s.state !== 'RUNNING') return;
      const n = s.consecutiveErrors + 1,
        critical =
          /PROFILE_CLOSE|BROWSER_CLOSE|EMERGENCY|AUTH_REQUIRED|CHALLENGE|CAPTCHA|RESTRICT|BLOCK|SELECTOR|UI_CHANGED|LOGIN|IDENTITY|UNCERTAIN|AI_UNCERTAIN|OPENAI_USAGE_UNKNOWN/.test(
            code,
          ),
        stop = critical || n >= 3;
      if (stop) await this.revokePending(accountId, tx);
      await putDocument(tx, `autopilot-account-${accountId}`, {
        ...s,
        consecutiveErrors: n,
        error: code,
        ...(stop ? { state: 'ERROR', epoch: s.epoch + 1 } : {}),
        updatedAt: new Date().toISOString(),
      });
      await tx.insert('systemEvent', {
        ...base(),
        level: 'ERROR',
        code: stop ? 'AUTOPILOT_CRITICAL' : 'AUTOPILOT_ERROR',
        message: `Автопилот ${accountId}: ${code}${stop ? '; остановлен, требуется проверка' : ''}`,
      });
      if (stop)
        await tx.insert('systemEvent', {
          ...base(),
          level: 'ERROR',
          code: 'NOTIFICATION',
          message: `Автопилот ${accountId} остановлен: ${code}. Повторных отправок нет; откройте историю ошибок`,
        });
      await audit(
        tx,
        'autopilot',
        'AUTOPILOT_ERROR',
        accountId,
        JSON.stringify({ code, stop, count: n }),
      );
    });
  }
}
