import type { AutopilotPolicy, AutoGrant, AutoWork } from '../autopilot/policy.js';
import { assertSourceRights } from '../content/rights.js';
import { ManualPolicy, type ManualCard } from '../policy/manual.js';
import { hashDocument, getDocument, putDocument } from '../db/documents.js';
import { createHash } from 'node:crypto';
import type { Database } from '../db/database.js';
import { base, audit } from '../db/database.js';
import { assert } from '../core/errors.js';
import { validateContent } from '../content/service.js';
import { CtaService, renderCta } from '../cta/service.js';
import type { Batch, PublishJob, PublicationMode, BroadcastAdaptation } from '../core/domain.js';
export class Scheduler {
  constructor(
    private db: Database,
    private random: () => number = Math.random,
    private ctas: CtaService = new CtaService(db),
  ) {}
  async interval() {
    return { min: 12, max: 12 };
  }
  async setInterval(_min: number, _max: number, _actor: string) {
    assert(
      false,
      'CYCLE_SCHEDULE',
      'Интервал рассчитывается автоматически: 120 минут / число аккаунтов; для десяти — 12 минут.',
    );
  }
  async pause(paused: boolean, actor: string) {
    await this.db.transaction(async (tx) => {
      if (await tx.get('setting', 'factoryPaused'))
        await tx.update('setting', 'factoryPaused', { value: String(paused) });
      else await tx.insert('setting', { ...base('factoryPaused'), value: String(paused) });
      await putDocument(tx, 'automationPaused', paused);
      await audit(tx, actor, paused ? 'PAUSE_FACTORY' : 'RESUME_FACTORY', 'factory');
    });
  }
  async createBatch(
    generatedIds: string[],
    actor: string,
    approval: Batch['approval'] = 'MANUAL_APPROVAL',
    requestId?: string,
    options: {
      mode?: PublicationMode;
      adaptation?: BroadcastAdaptation;
      manual?: { cardId: string; actor: string; policy: ManualPolicy };
      autopilot?: { policy: AutopilotPolicy; work: AutoWork; grant: Omit<AutoGrant, 'jobId'> };
    } = {},
  ) {
    assert(
      generatedIds.length > 0 && generatedIds.length <= 100,
      'INVALID_BATCH',
      'Выберите от 1 до 100 вариантов',
    );
    const step = generatedIds.length === 1 ? 0 : 7200 / generatedIds.length;
    for (const id of generatedIds) {
      const g = await this.db.get('generated', id);
      if (g) await this.ctas.ensure(g.accountId);
    }
    const batchId = requestId
      ? `batch-${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`
      : base().id;
    return this.db.transaction(async (tx) => {
      if (await tx.get('batch', batchId)) return tx.list('publishJob', { batchId });
      const allJobs = await tx.list('publishJob'),
        pending = allJobs.filter((j) => ['QUEUED', 'RUNNING', 'PAUSED'].includes(j.status));
      const reservations = [];
      for (const id of new Set(pending.map((j) => j.batchId))) {
        const batch = await tx.get('batch', id),
          jobs = allJobs.filter((j) => j.batchId === id),
          waiting = pending.filter((j) => j.batchId === id),
          start = Math.min(...jobs.map((j) => (j.plannedAt ?? j.scheduledAt).getTime())),
          slot = batch?.intervalSeconds ?? (jobs.length > 1 ? 7200 / jobs.length : 0);
        reservations.push(
          Math.max(
            start + (jobs.length > 1 ? (batch?.cycleSeconds ?? 7200) * 1000 : 0),
            ...waiting.map((j) => j.scheduledAt.getTime() + Math.max(1, slot) * 1000),
          ),
        );
      }
      const cursor = options.autopilot
        ? Date.parse(options.autopilot.work.scheduledAt)
        : options.manual
          ? Date.now()
          : Math.max(Date.now(), ...reservations);
      await tx.insert('batch', {
        ...base(batchId),
        name: `Партия ${new Date().toISOString()}`,
        approval,
        mode: options.mode ?? 'ACCOUNT_SPECIFIC',
        adaptation: options.adaptation ?? 'PER_ACCOUNT',
        cycleSeconds: 7200,
        intervalSeconds: step,
      });
      const jobs: PublishJob[] = [],
        accounts = new Set<string>();
      const sources = new Set<string>();
      let sequence = 0;
      for (const id of generatedIds) {
        const g = await tx.get('generated', id);
        assert(
          g &&
            g.valid &&
            !(await getDocument(tx, `superseded-${id}`)) &&
            !(await getDocument(tx, `rejected-${id}`)),
          'INVALID_DRAFT',
          'Карточка устарела, отклонена или текст требует правки',
        );
        const a = await tx.get('account', g.accountId),
          s = await tx.get('source', g.sourceId),
          style = await tx.get('style', g.styleId);
        assert(a && s && style, 'NOT_FOUND', 'Данные публикации не найдены');
        assert(a.status === 'ACTIVE', 'ACCOUNT_UNAVAILABLE', `Аккаунт ${a.name} недоступен`);
        assert(
          !accounts.has(a.id),
          'DUPLICATE_ACCOUNT',
          'Один аккаунт может появиться в партии один раз',
        );
        accounts.add(a.id);
        if ((options.mode ?? 'ACCOUNT_SPECIFIC') === 'ACCOUNT_SPECIFIC')
          assert(
            !sources.has(s.id),
            'DUPLICATE_SOURCE',
            'Назначьте каждому аккаунту отдельный исходник либо выберите общий режим',
          );
        sources.add(s.id);
        await assertSourceRights(tx, s.id);
        assert(
          !validateContent(g.text, s.text, style).length,
          'INVALID_DRAFT',
          'Черновик не прошёл повторную проверку',
        );
        if (approval === 'AUTO_APPROVED')
          assert(
            a.autoApprove && g.approved,
            'APPROVAL_REQUIRED',
            'Автоочередь доступна только для заранее разрешённых вариантов и аккаунтов',
          );
        const cta = a.ctaId ? await tx.get('cta', a.ctaId) : null;
        assert(
          cta &&
            cta.accountId === a.id &&
            (!cta.enabled || renderCta(cta.text, cta.url).length > 0),
          'CTA_REQUIRED',
          'Настройте индивидуальный CTA аккаунта',
        );
        assert(
          !cta.enabled || [...renderCta(cta.text, cta.url)].length <= 500,
          'CTA_LENGTH',
          'Комментарий длиннее 500 символов',
        );
        let manualGrant: { card: ManualCard; epoch: number } | undefined;
        if (options.manual) {
          const m = options.manual;
          const card = await m.policy.readCard(m.cardId, actor, tx);
          assert(
            card.kind === 'POST' &&
              card.entityId === g.id &&
              card.accountId === g.accountId &&
              card.version === g.version &&
              card.hash === hashDocument(g.text),
            'STALE_CARD',
            'Карточка устарела. Откройте новый предпросмотр',
          );
          assert(
            card.sourceUrl ===
              hashDocument({
                text: cta.text,
                url: cta.url,
                enabled: cta.enabled,
                media: cta.mediaSha256,
              }),
            'STALE_CTA',
            'CTA изменён. Откройте новый предпросмотр',
          );
          const policy = await m.policy.assertAllowed(
            g.accountId,
            actor,
            card.sessionId,
            undefined,
            tx,
          );
          const jobs = await tx.list('publishJob', { generatedId: g.id });
          assert(
            !jobs.some((j) => j.status !== 'CANCELLED'),
            'DUPLICATE_POST',
            'Эта версия уже поставлена в очередь или отправлена; проверьте результат',
          );
          manualGrant = { card, epoch: policy.epoch };
        }
        await tx.update('generated', g.id, { approved: true });
        jobs.push(
          await tx.insert('publishJob', {
            ...base(),
            batchId,
            accountId: a.id,
            generatedId: g.id,
            scheduledAt: new Date(cursor + Math.round(sequence * step * 1000)),
            plannedAt: new Date(cursor + Math.round(sequence * step * 1000)),
            sequence,
            delayMs: 0,
            delayReason: null,
            lastAttemptAt: null,
            ctaUrl: null,
            ctaVersion: 0,
            ctaUpdatedAt: null,
            ctaCapturedAt: null,
            ctaEnabled: null,
            commentNotBefore: null,
            status: 'QUEUED',
            postStatus: 'PENDING',
            commentStatus: 'PENDING',
            ctaText: null,
            attempts: 0,
            lastError: null,
            startedAt: null,
            updatedAt: new Date(),
            revision: 0,
          }),
        );
        if (options.autopilot) {
          const { policy, work, grant } = options.autopilot;
          const state = await policy.assertWork(
            work,
            tx,
            Date.now(),
            work.mode === 'DRY_RUN',
            true,
          );
          assert(
            g.accountId === work.accountId &&
              grant.generatedId === g.id &&
              grant.hash === hashDocument(g.text),
            'AUTOPILOT_SCOPE',
            'Неподходящая задача автопилота',
          );
          const enabled = state.config.allowCTA;
          const snapshot = {
            ctaText: cta.text,
            ctaUrl: cta.url ?? null,
            ctaMediaPath: cta.mediaPath ?? null,
            ctaMediaSha256: cta.mediaSha256 ?? null,
            ctaEnabled: enabled,
            ctaVersion: cta.version ?? 1,
            ctaUpdatedAt: cta.updatedAt ?? cta.createdAt,
            ctaCapturedAt: new Date(),
            commentStatus: enabled ? ('PENDING' as const) : ('DISABLED' as const),
          };
          const job = jobs.at(-1)!;
          const updated = await tx.update('publishJob', job.id, {
            ...snapshot,
            status: work.mode === 'DRY_RUN' ? 'PAUSED' : 'QUEUED',
          });
          jobs[jobs.length - 1] = updated;
          await putDocument(tx, `autopilot-grant-${job.id}`, {
            ...grant,
            jobId: job.id,
            ctaHash: hashDocument({
              text: snapshot.ctaText,
              url: snapshot.ctaUrl,
              media: snapshot.ctaMediaSha256,
              enabled,
            }),
          });
          await audit(tx, actor, 'AUTOPILOT_POST_QUEUED', job.id, work.id);
        }
        if (manualGrant) {
          const job = jobs.at(-1)!;
          await putDocument(tx, `manual-post-${job.id}`, {
            actor,
            sessionId: manualGrant.card.sessionId,
            epoch: manualGrant.epoch,
            accountId: g.accountId,
            hash: hashDocument(g.text),
            version: g.version,
            generatedId: g.id,
            ctaHash: manualGrant.card.sourceUrl,
            expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
          });
          await putDocument(tx, `manual-card-${manualGrant.card.id}`, {
            ...manualGrant.card,
            used: true,
            resultId: job.id,
          });
        }
        sequence++;
      }
      await audit(tx, actor, 'CREATE_BATCH', batchId);
      return jobs;
    });
  }
  async publishManual(cardId: string, actor: string, policy: ManualPolicy) {
    const c = await policy.readCard(cardId, actor);
    if (c.used && c.resultId) return this.db.get('publishJob', c.resultId);
    const jobs = await this.createBatch(
      [c.entityId],
      actor,
      'MANUAL_APPROVAL',
      `manual-${c.entityId}`,
      { manual: { cardId, actor, policy } },
    );
    return jobs[0];
  }
  async cancel(id: string, actor: string) {
    return this.db.transaction(async (tx) => {
      const j = await tx.get('publishJob', id);
      assert(j, 'NOT_FOUND', 'Задача не найдена');
      assert(j.status !== 'RUNNING', 'JOB_RUNNING', 'Задача уже выполняется: отмена небезопасна');
      assert(
        !['COMPLETED', 'NEEDS_REVIEW'].includes(j.status),
        'INVALID_STATE',
        'Завершённую или неопределённую публикацию нельзя отменить',
      );
      await audit(tx, actor, 'CANCEL_JOB', id);
      return tx.update('publishJob', id, {
        status: 'CANCELLED',
        revision: j.revision + 1,
        updatedAt: new Date(),
      });
    });
  }
  async reschedule(id: string, date: Date, actor: string) {
    assert(
      Number.isFinite(date.getTime()) && date.getTime() >= Date.now() - 1000,
      'INVALID_TIME',
      'Нужно будущее время в ISO-формате',
    );

    return this.db.transaction(async (tx) => {
      const j = await tx.get('publishJob', id);
      assert(
        j && ['QUEUED', 'PAUSED'].includes(j.status),
        'INVALID_STATE',
        'Можно перенести только ожидающую задачу',
      );
      const others = (await tx.list('publishJob')).filter(
        (x) => x.id !== id && ['QUEUED', 'RUNNING', 'PAUSED'].includes(x.status),
      );
      assert(
        others.every((x) => Math.abs(x.scheduledAt.getTime() - date.getTime()) >= 1000),
        'SCHEDULE_CONFLICT',
        'Время конфликтует с другими публикациями',
      );
      await audit(tx, actor, 'RESCHEDULE_JOB', id, date.toISOString());
      return tx.update('publishJob', id, {
        scheduledAt: date,
        plannedAt: date,
        delayMs: 0,
        delayReason: null,
        status: 'QUEUED',
        revision: j.revision + 1,
        updatedAt: new Date(),
      });
    });
  }
  async retryComment(id: string, actor: string) {
    await this.db.transaction(async (tx) => {
      const j = await tx.get('publishJob', id);
      assert(
        j &&
          j.postStatus === 'PUBLISHED' &&
          ['FAILED', 'COMMENT_FAILED'].includes(j.commentStatus) &&
          j.status !== 'RUNNING',
        'INVALID_STATE',
        'Повтор доступен только для комментария с известной ошибкой до отправки',
      );
      await audit(tx, actor, 'RETRY_COMMENT', id);
      await tx.update('publishJob', id, {
        status: 'QUEUED',
        commentStatus: 'PENDING',
        attempts: 0,
        scheduledAt: new Date(),
        revision: j.revision + 1,
        updatedAt: new Date(),
      });
    });
  }
}
