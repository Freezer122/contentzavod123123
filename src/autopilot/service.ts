import { tradingTopic } from '../content/features.js';
import { tradingRelevance } from '../engagement/relevance.js';
import { isRussian } from '../content/normalizer.js';
import type { Database } from '../db/database.js';
import { audit, base } from '../db/database.js';
import { getDocument, putDocument, listDocuments, hashDocument } from '../db/documents.js';
import { assert, AppError } from '../core/errors.js';
import type { ContentEngine } from '../content/service.js';
import type { GenerationQueue } from '../content/jobs.js';
import type {
  EngagementManager,
  Candidate,
  EngagementJob,
  ReplyDraft,
} from '../engagement/service.js';
import type { EngagementQueue } from '../engagement/queue.js';
import type { Scheduler } from '../scheduler/service.js';
import type { PublishingWorker } from '../scheduler/worker.js';
import type { AnalyticsCollector } from '../analytics/collector.js';
import { AutopilotPolicy, type AutoWork, type AutoGrant } from './policy.js';
import {
  localTime,
  minutes,
  nextDay,
  remainingSlots,
  type PublicationSlot,
  type PublicationPlan,
} from './schedule.js';
import { observe, rankViral, type ViralObservation } from './viral.js';
import { qualityGate, operationalQuality } from './quality.js';
import { freshness } from '../engagement/freshness.js';
import { withProfileLease } from '../scheduler/lease.js';
import { validateContent } from '../content/service.js';
type Plan = PublicationPlan;
export interface DailySummary {
  id: string;
  accountId: string;
  day: string;
  chatId: number;
  text: string;
  deliveredAt?: string;
  attemptedAt?: string;
}
export class AutopilotService {
  constructor(
    public db: Database,
    public policy: AutopilotPolicy,
    private content: ContentEngine,
    private engagement: EngagementManager,
    private replies: EngagementQueue,
    private scheduler: Scheduler,
    private publisher: PublishingWorker,
    private generation: GenerationQueue,
    private collector: AnalyticsCollector,
  ) {}
  private async save(w: AutoWork, patch: Partial<AutoWork>) {
    const value = { ...w, ...patch };
    await putDocument(this.db, `autopilot-work-${w.id}`, value);
    return value;
  }
  async observations() {
    return listDocuments<ViralObservation>(this.db, 'autopilot-observation-');
  }
  async rank(accountId: string, at = Date.now()) {
    const s = await this.policy.settings(accountId);
    return rankViral(
      await this.engagement.candidates(accountId),
      await this.observations(),
      s.config.viralThreshold,
      s.config.maxAgeHours,
      at,
    );
  }
  async discover(w: AutoWork) {
    const s = await this.policy.assertWork(w, this.db, Date.now(), w.mode === 'DRY_RUN', true);
    const old = await this.engagement.settings(w.accountId),
      turn = (await this.policy.works()).filter(
        (x) => x.accountId === w.accountId && x.epoch === w.epoch && x.kind === 'DISCOVER',
      ).length;
    const source = s.config.sources[(turn - 1) % s.config.sources.length]!;
    const result = await this.engagement.search(w.accountId, s.enabledBy!, {
      manual: true,
      targetCandidates: 20,
      viewLimit: 80,
      source,
      maxAgeHours: s.config.maxAgeHours,
      strictness: 'STRICT',
    });
    const at = new Date().toISOString();
    for (const c of await this.engagement.candidates(w.accountId)) {
      // Only observations from this actual browser visit count as a new measurement.
      if (Date.parse(c.lastObservedAt ?? c.discoveredAt) < Date.parse(w.createdAt)) continue;
      const o = observe(c, at);
      await putDocument(
        this.db,
        `autopilot-observation-${hashDocument({ url: o.url, at }).slice(0, 32)}`,
        o,
      );
    }
    const ranked = await this.rank(w.accountId);
    await putDocument(this.db, `autopilot-discovery-${w.id}`, {
      at,
      accountId: w.accountId,
      epoch: w.epoch,
      workId: w.id,
      metrics: result,
      source,
      priorSettingsUnchanged:
        hashDocument(old) === hashDocument(await this.engagement.settings(w.accountId)),
      ranked: ranked.map((r) => ({
        id: r.candidate.id,
        url: r.candidate.url,
        score: r.score,
        accepted: r.accepted,
        reasons: r.reasons,
        provisional: r.provisional,
        growth: r.growth,
        observation: r.observation,
      })),
    });
    return this.save(w, { status: 'PREVIEWED', finishedAt: at });
  }
  async process(workId: string) {
    const saved = await getDocument<AutoWork>(this.db, `autopilot-work-${workId}`);
    assert(saved, 'NOT_FOUND', 'Задача автопилота не найдена');
    if (!['QUEUED', 'RUNNING'].includes(saved.status)) return saved;
    let w = await this.save(saved, { status: 'RUNNING' });
    try {
      const s = await this.policy.assertWork(w, this.db, Date.now(), w.mode === 'DRY_RUN', true);
      if (w.kind === 'DISCOVER') {
        const result = await this.discover(w);
        await this.policy.success(w.accountId);
        return result;
      }
      if (w.kind === 'STATS') {
        await this.collector.tick();
        await this.collectReplyMetric(w.accountId);
        return this.save(w, { status: 'PREVIEWED', finishedAt: new Date().toISOString() });
      }
      if (w.resultId) {
        if (w.kind === 'POST') {
          if (w.mode === 'DRY_RUN') {
            if (!(await getDocument(this.db, `autopilot-preview-${w.resultId}`)))
              await this.publisher.previewAutopilot(w.resultId);
            return this.save(w, { status: 'PREVIEWED', finishedAt: new Date().toISOString() });
          }
          return this.save(w, { status: 'SCHEDULED' });
        }
        if (w.mode === 'DRY_RUN') {
          await this.replies.execute(w.resultId, true, { autopilot: true, actor: s.enabledBy! });
          return this.save(w, { status: 'PREVIEWED', finishedAt: new Date().toISOString() });
        }
        return this.save(w, { status: 'SCHEDULED' });
      }
      let c = await this.engagement.candidate(w.accountId, w.candidateId!);
      if (w.kind === 'REPLY' && !w.generationStartedAt && this.engagement.port.readPost) {
        const current = await this.engagement.port.readPost(w.accountId, c.url);
        c = { ...c, ...current };
        await putDocument(this.db, `engagement-candidate-${w.accountId}-${c.id}`, c);
      }
      assert(
        ((w.evergreen && w.kind === 'POST') || freshness(c, s.config.maxAgeHours).accepted) &&
          (w.kind === 'POST'
            ? isRussian(c.text) && tradingRelevance(c.text, 'STRICT').accepted
            : this.engagement.assess(c, await this.engagement.settings(w.accountId)).accepted),
        'STALE_SOURCE',
        'Тема устарела или нерелевантна',
      );
      let cachedOrigin: AutoWork | null = null;
      if (w.dryRevalidateFrom) {
        cachedOrigin = await getDocument<AutoWork>(
          this.db,
          `autopilot-work-${w.dryRevalidateFrom}`,
        );
        assert(
          w.mode === 'DRY_RUN' &&
            cachedOrigin?.mode === 'DRY_RUN' &&
            cachedOrigin.status === 'NEEDS_REVIEW' &&
            cachedOrigin.accountId === w.accountId &&
            cachedOrigin.candidateId === w.candidateId &&
            cachedOrigin.kind === w.kind &&
            cachedOrigin.requestId &&
            cachedOrigin.text,
          'DRY_REVALIDATION_ONLY',
          'Только явный DRY_RUN сохранённого результата; LIVE запрещён',
        );
      } else await this.policy.claim(w, c);
      const recoverOnly = !!w.generationStartedAt || !!cachedOrigin;
      w = await this.save(w, {
        generationStartedAt: w.generationStartedAt ?? new Date().toISOString(),
      });
      if (w.kind === 'POST') {
        const format =
          s.config.formats[
            parseInt(hashDocument(cachedOrigin?.id ?? w.id).slice(0, 6), 16) %
              s.config.formats.length
          ]!;
        const r = await this.content.originalFromTopic(
          w.accountId,
          c.text,
          format,
          cachedOrigin?.id ?? w.id,
          recoverOnly,
        );
        const checked = operationalQuality(
          'POST',
          r.text,
          c.text,
          await this.policy.previousTexts(this.db, `auto-own-${w.id}`),
        );
        const q = {
          ...checked,
          status: checked.decision === 'WARNING' ? ('PASS' as const) : checked.status,
        };
        if (q.status !== 'PASS')
          return this.save(w, {
            status: q.status,
            reasons: q.reasons,
            text: r.text,
            requestId: r.requestId,
            finishedAt: new Date().toISOString(),
          });
        await this.policy.assertWork(w, this.db, Date.now(), w.mode === 'DRY_RUN', true);
        const sourceId = `auto-own-source-${w.id}`,
          generatedId = `auto-own-${w.id}`,
          request = await this.db.get('aiRequest', r.requestId);
        await this.db.transaction(async (tx) => {
          if (await tx.get('generated', generatedId)) return;
          // This source is the newly authored work, not the foreign post. Inspiration remains in the grant/provenance document.
          await tx.insert('source', {
            ...base(sourceId),
            url: null,
            text: r.text,
            fingerprint: hashDocument({ workId: w.id, text: r.text }),
            topic: tradingTopic(c.text),
            format,
            author: (await tx.get('account', w.accountId))!.username,
            rights: 'OWN',
          });
          await putDocument(tx, `source-rights-${sourceId}`, {
            sourceId,
            sourceType: 'OWN',
            rightsStatus: 'CONFIRMED',
            rightsConfirmedAt: new Date().toISOString(),
            confirmedBy: s.enabledBy,
          });
          const style = (await tx.get('style', r.styleId))!;
          assert(
            !validateContent(r.text, r.text, style).length,
            'INVALID_DRAFT',
            'Новый пост не соответствует стилю',
          );
          await tx.insert('generated', {
            ...base(generatedId),
            sourceId,
            accountId: w.accountId,
            styleId: r.styleId,
            text: r.text,
            version: 1,
            valid: true,
            approved: true,
            model: request?.model ?? null,
            aiRequestId: r.requestId,
            inputTokens: request?.inputTokens ?? null,
            outputTokens: request?.outputTokens ?? null,
            tokenScope: 'REQUEST',
            templateId: r.templateId,
            templateSnapshot: r.templateSnapshot,
            styleSnapshot: r.styleSnapshot,
            promptVersion: r.promptVersion,
            validationErrors: [],
          });
          await putDocument(tx, `autopilot-provenance-${generatedId}`, {
            workId: w.id,
            sourceUrl: c.url,
            sourceText: c.text,
            sourceAuthor: c.author,
            sourcePublishedAt: c.publishedAt,
            styleId: r.styleId,
            styleFingerprint: hashDocument(r.styleSnapshot),
            topic: tradingTopic(c.text),
            format,
            promptVersion: r.promptVersion,
            quality: q,
            ownOriginal: true,
            humanExampleIds: r.humanExampleIds,
          });
          await audit(
            tx,
            s.enabledBy!,
            'AUTOPILOT_ORIGINAL_CREATED',
            generatedId,
            JSON.stringify({ sourceUrl: c.url, quality: q }),
          );
        });
        const grant = this.grant(w, c, r.text, 1, q, { generatedId, format });
        const [job] = await this.scheduler.createBatch(
          [generatedId],
          s.enabledBy!,
          'MANUAL_APPROVAL',
          `autopilot-${w.id}`,
          { autopilot: { policy: this.policy, work: w, grant } },
        );
        assert(job, 'NOT_FOUND', 'Очередь не создана');
        w = await this.save(w, {
          status: 'SCHEDULED',
          text: r.text,
          requestId: r.requestId,
          resultId: job.id,
        });
        if (w.mode === 'DRY_RUN') {
          await this.publisher.previewAutopilot(job.id);
          return this.save(w, { status: 'PREVIEWED', finishedAt: new Date().toISOString() });
        }
        return w;
      }
      let d = await this.engagement.generate(w.accountId, c.id, s.enabledBy!, { recoverOnly });
      assert(
        d.createdAt &&
          (Date.parse(d.createdAt) >= Date.parse(s.enabledAt!) ||
            cachedOrigin?.requestId === d.requestId),
        'OLD_DRAFT',
        'Старые ручные черновики не публикуются автопилотом',
      );
      const checked = operationalQuality(
        'REPLY',
        d.text,
        c.text,
        await this.policy.previousTexts(this.db, undefined, d.id),
      );
      const q = {
        ...checked,
        status: checked.decision === 'WARNING' ? ('PASS' as const) : checked.status,
      };
      if (q.status !== 'PASS' || d.generationState !== 'READY')
        return this.save(w, {
          status: q.status === 'REJECTED' ? 'REJECTED' : 'NEEDS_REVIEW',
          text: d.text,
          requestId: d.requestId,
          reasons: [...q.reasons, ...(d.validationErrors ?? [])],
          finishedAt: new Date().toISOString(),
        });
      if (cachedOrigin) {
        const clone = {
          ...d,
          id: `dry-revalidated-${w.id}`,
          status: 'DRAFT' as const,
          approvalStatus: 'DRAFT' as const,
          createdAt: new Date().toISOString(),
        };
        await putDocument(this.db, `engagement-draft-${w.accountId}-${clone.id}`, clone);
        d = clone;
      }
      const jobId = `auto-reply-${w.id}`;
      await this.db.transaction(async (tx) => {
        await this.policy.assertWork(w, tx, Date.now(), w.mode === 'DRY_RUN', true);
        if (await getDocument(tx, `engagement-job-${jobId}`)) return;
        const current = (await getDocument<ReplyDraft>(
          tx,
          `engagement-draft-${w.accountId}-${d.id}`,
        ))!;
        assert(
          current.hash === d.hash && current.status === 'DRAFT',
          'STALE_DRAFT',
          'Черновик изменился',
        );
        const g = this.grant(w, c, d.text, d.version ?? 1, q, { draftId: d.id, format: 'REPLY' });
        await putDocument(tx, `engagement-draft-${w.accountId}-${d.id}`, {
          ...d,
          status: 'APPROVED',
          approvalStatus: 'APPROVED',
          actor: s.enabledBy,
          approvedAt: new Date().toISOString(),
        });
        const job: EngagementJob = {
          id: jobId,
          accountId: w.accountId,
          candidateId: c.id,
          draftId: d.id,
          kind: 'REPLY',
          executionScope: 'AUTOPILOT',
          hash: d.hash,
          actor: s.enabledBy!,
          createdAt: new Date().toISOString(),
          status: 'QUEUED',
          scheduledAt: w.scheduledAt,
          approvalStatus: 'APPROVED',
          executionStatus: 'WAITING',
          phase: 'QUEUED',
        };
        await putDocument(tx, `engagement-job-${jobId}`, job);
        await putDocument(tx, `autopilot-grant-${jobId}`, { ...g, jobId });
        await audit(tx, s.enabledBy!, 'AUTOPILOT_REPLY_QUEUED', jobId, w.id);
      });
      w = await this.save(w, {
        status: 'SCHEDULED',
        text: d.text,
        requestId: d.requestId,
        resultId: jobId,
      });
      if (w.mode === 'DRY_RUN') {
        await this.replies.execute(jobId, true, { autopilot: true, actor: s.enabledBy! });
        return this.save(w, { status: 'PREVIEWED', finishedAt: new Date().toISOString() });
      }
      return w;
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'INTERNAL';
      if (['PROFILE_BUSY', 'PUBLISH_PRIORITY'].includes(code))
        return this.save(w, { status: 'QUEUED' });
      if (
        [
          'GLOBAL_SOURCE_DUPLICATE',
          'GLOBAL_TASK_DUPLICATE',
          'GLOBAL_IDEA_DUPLICATE',
          'STALE_SOURCE',
          'OLD_DRAFT',
          'SEARCH_LIMIT',
          'OUTSIDE_WINDOW',
          'AUTOPILOT_REVOKED',
          'AUTOMATION_PAUSED',
        ].includes(code)
      )
        return this.save(w, {
          status: 'SKIPPED',
          reasons: [code],
          finishedAt: new Date().toISOString(),
        });
      await this.policy.failure(w.accountId, e);
      return this.save(w, {
        status: /UNCERTAIN|UNKNOWN|CACHE_MISS/.test(code) ? 'NEEDS_REVIEW' : 'ERROR',
        error: code,
        finishedAt: new Date().toISOString(),
      });
    }
  }
  private grant(
    w: AutoWork,
    c: Candidate,
    text: string,
    version: number,
    q: AutoGrant['quality'],
    extra: Pick<AutoGrant, 'format'> & Partial<AutoGrant>,
  ): Omit<AutoGrant, 'jobId'> {
    return {
      accountId: w.accountId,
      kind: w.kind as 'POST' | 'REPLY',
      epoch: w.epoch,
      version: w.version,
      enabledAt: w.enabledAt,
      createdAt: w.createdAt,
      mode: w.mode,
      hash: hashDocument(text),
      textVersion: version,
      sourceUrl: c.url,
      sourceText: c.text,
      sourcePublishedAt: c.publishedAt!,
      sourceConfidence: c.timestampConfidence!,
      sourceId: c.id,
      quality: q,
      topic: tradingTopic(c.text),
      evergreen: w.evergreen,
      ...extra,
    };
  }
  async enqueueWork(w: AutoWork) {
    await this.db.transaction(async (tx) => {
      if (!(await getDocument(tx, `autopilot-work-${w.id}`)))
        await putDocument(tx, `autopilot-work-${w.id}`, w);
    });
    return this.generation.enqueue(
      {
        kind: 'AUTOPILOT',
        autoWorkId: w.id,
        accountId: w.accountId,
        actor: (await this.policy.settings(w.accountId)).enabledBy!,
        chatId: Number((await this.policy.settings(w.accountId)).enabledBy),
      },
      w.id,
    );
  }
  async schedule(accountId: string, at = Date.now()) {
    const s = await this.policy.settings(accountId);
    if (!s.enabledAt) return [];
    const day = localTime(at, s.config.timezone).day,
      result: PublicationSlot[] = [];
    for (const d of [day, nextDay(day)]) {
      const key = `autopilot-plan-${accountId}-${s.epoch}-${d}`;
      let p = await getDocument<Plan>(this.db, key);
      if (!p || p.schemaVersion !== 117) {
        if (p)
          await audit(this.db, 'v117-migration', 'AUTOPILOT_PLAN_MIGRATED', key, JSON.stringify(p));
        const history = (p?.slots ?? [])
          .filter((x) => x.skipped || Date.parse(x.at) < at)
          .map((x) => ({
            ...x,
            accountId,
            scheduleId: key,
            localDate: d,
            plannedAtUtc: x.at,
            timezone: s.config.timezone,
            type: x.kind,
            status: 'SKIPPED' as const,
            notifiedAt: new Date(at).toISOString(),
            failureReason: x.skipped ?? 'MISSED_SLOT_V116',
            attempts: 0,
            attemptIds: [],
          }));
        p = {
          accountId,
          epoch: s.epoch,
          day: d,
          schemaVersion: 117,
          createdAt: new Date(at).toISOString(),
          slots: [
            ...history,
            ...remainingSlots(
              accountId,
              s.epoch,
              d,
              s.config,
              at,
              d === day ? await this.policy.sent(accountId, at) : { posts: 0, replies: 0 },
            ),
          ],
        };
        await putDocument(this.db, key, p);
      }
      result.push(...p.slots);
    }
    return result.sort((a, b) => a.at.localeCompare(b.at));
  }
  private async saveSlot(slot: PublicationSlot, patch: Partial<PublicationSlot>) {
    return this.db.transaction(async (tx) => {
      const p = (await getDocument<Plan>(tx, slot.scheduleId))!;
      const i = p.slots.findIndex((s) => s.id === slot.id);
      assert(i >= 0, 'NOT_FOUND', 'Слот не найден');
      p.slots[i] = { ...p.slots[i]!, ...patch };
      await putDocument(tx, slot.scheduleId, p);
      return p.slots[i]!;
    });
  }
  async changeSlot(
    accountId: string,
    id: string,
    actor: string,
    action: 'cancel' | 'move' | 'now',
    at?: number,
  ) {
    const s = await this.policy.settings(accountId);
    assert(actor === s.enabledBy, 'OWNER_REQUIRED', 'Только владелец');
    const slot = (await this.schedule(accountId)).find((x) => x.id === id);
    assert(
      slot && !['PUBLISHING', 'PUBLISHED', 'UNCERTAIN'].includes(slot.status),
      'SLOT_LOCKED',
      'Начатую или опубликованную задачу нельзя изменить',
    );
    if (action === 'cancel') {
      if (slot.publishingJobId) {
        if (slot.kind === 'POST') await this.scheduler.cancel(slot.publishingJobId, actor);
        else {
          const j = (await this.engagement.jobView(slot.publishingJobId)).job;
          assert(!j.submittedAt, 'UNCERTAIN', 'Отправка уже начата');
          await putDocument(this.db, `engagement-job-${j.id}`, {
            ...j,
            status: 'FAILED',
            error: 'CANCELLED_BY_OWNER',
          });
        }
      }
      return this.saveSlot(slot, { status: 'SKIPPED', failureReason: 'CANCELLED_BY_OWNER' });
    }
    const when = action === 'now' ? Date.now() + 10000 : at!;
    assert(Number.isFinite(when) && when >= Date.now(), 'INVALID_TIME', 'Укажите будущее время');
    const t = localTime(when, s.config.timezone);
    assert(
      t.day === slot.localDate &&
        t.minute >= minutes(s.config.start) &&
        t.minute < minutes(s.config.end),
      'OUTSIDE_WINDOW',
      'Время вне дневного окна',
    );
    const interval =
      (slot.kind === 'POST' ? s.config.postIntervalMinutes : s.config.replyIntervalMinutes) * 60000;
    assert(
      !(await this.schedule(accountId)).some(
        (x) =>
          x.id !== slot.id &&
          x.kind === slot.kind &&
          !['SKIPPED', 'FAILED'].includes(x.status) &&
          Math.abs(Date.parse(x.at) - when) < interval,
      ),
      'INTERVAL',
      'Нарушен минимальный интервал',
    );
    if (slot.publishingJobId) {
      if (slot.kind === 'POST')
        await this.scheduler.reschedule(slot.publishingJobId, new Date(when), actor);
      else {
        const j = (await this.engagement.jobView(slot.publishingJobId)).job;
        assert(!j.submittedAt, 'UNCERTAIN', 'Отправка начата');
        await putDocument(this.db, `engagement-job-${j.id}`, {
          ...j,
          scheduledAt: new Date(when).toISOString(),
        });
      }
    }
    if (slot.contentJobId) {
      const w = await getDocument<AutoWork>(this.db, `autopilot-work-${slot.contentJobId}`);
      if (w) await this.save(w, { scheduledAt: new Date(when).toISOString() });
    }
    await audit(
      this.db,
      actor,
      'AUTOPILOT_SLOT_MOVED',
      slot.id,
      JSON.stringify({ from: slot.at, to: new Date(when).toISOString() }),
    );
    return this.saveSlot(slot, {
      at: new Date(when).toISOString(),
      plannedAtUtc: new Date(when).toISOString(),
    });
  }
  private async ownIdea(accountId: string, owner: string, slot: PublicationSlot) {
    const topics = [
      'трейдинг: заранее определить условие выхода из позиции и не менять его из-за нежелания признать убыток',
      'технический анализ: уровень поддержки это сценарий, а не обещание рынку развернуться',
      'трейдинг: отсутствие подходящего сигнала может быть достаточной причиной не открывать сделку',
      'опционы: сложность конструкции не заменяет понимания риска и условий экспирации',
      'трейдинг: размер позиции и переносимость убытка важнее желания оказаться правым',
      'торговая стратегия: проверка идеи на истории не гарантирует повторения результата',
      'трейдинг: после серии удачных сделок правила риска не становятся необязательными',
      'ликвидность и биржевой спред: красивый график и удобное исполнение сделки это разные вещи',
      'психология трейдинга: сравнение со случайными чужими успехами мешает соблюдать собственный план',
      'торговая стратегия: журнал сделок помогает отличить соблюдение правил от случайного результата',
    ];
    const claimed = new Set(
      (await this.db.list('setting'))
        .filter((r) => r.id.startsWith('autopilot-source-'))
        .map((r) => JSON.parse(r.value).url),
    );
    for (let i = 0; i < topics.length; i++) {
      const text = topics[(i + parseInt(hashDocument(slot.id).slice(0, 4), 16)) % topics.length]!,
        id = 'own-idea-' + hashDocument({ accountId, text }).slice(0, 22),
        url = 'idea://' + id;
      if (
        claimed.has(url) ||
        (await this.policy.works()).some(
          (w) => slot.attemptIds.includes(w.id) && w.candidateId === id,
        )
      )
        continue;
      if (!(await this.db.get('source', id))) {
        await this.db.insert('source', {
          ...base(id),
          url: null,
          text,
          fingerprint: hashDocument({ id, text }),
          author: owner,
          rights: 'OWN',
          topic: tradingTopic(text),
          format: 'OBSERVATION',
        });
        await audit(
          this.db,
          owner,
          'OWN_IDEA_LIBRARY_V117',
          id,
          'Самостоятельные наблюдения без личных сделок и новых фактов, разрешены ТЗ V1.17',
        );
      }
      const c: Candidate = {
        id,
        accountId,
        url,
        author: owner,
        text,
        language: 'ru',
        category: 'трейдинг',
        discoveredAt: new Date().toISOString(),
        repliesAvailable: false,
        status: 'NEW',
        extractionVersion: 'threads-body-v115',
        timestampConfidence: 'UNKNOWN',
      };
      await putDocument(this.db, `engagement-candidate-${accountId}-${id}`, c);
      return c;
    }
    return null;
  }
  /** Existing scheduler owns these slots; preparation and dispatch remain in the existing queues. */
  async tick(at = Date.now()) {
    await withProfileLease(this.db, 'autopilot-dispatch', async () => {
      for (const state of await listDocuments<any>(this.db, 'autopilot-account-')) {
        if (state.state !== 'RUNNING') continue;
        try {
          const s = await this.policy.settings(state.accountId);
          await this.policy.assertWork(
            { ...s, createdAt: new Date(at).toISOString(), enabledAt: s.enabledAt! },
            this.db,
            at,
            false,
            true,
          );
          for (const w of (await this.policy.works()).filter(
            (w) =>
              w.accountId === s.accountId &&
              w.epoch === s.epoch &&
              !w.slotId &&
              w.status === 'SCHEDULED' &&
              w.resultId,
          )) {
            const j =
              w.kind === 'POST'
                ? await this.db.get('publishJob', w.resultId!)
                : (await this.engagement.jobView(w.resultId!)).job;
            if (j?.status === 'COMPLETED' || j?.status === 'PUBLISHED')
              await this.save(w, {
                status: (j as any).lastError ? 'ERROR' : 'PUBLISHED',
                error: (j as any).lastError,
              });
          }
          const slots = await this.schedule(s.accountId, at);
          for (const slot of slots) {
            if (!slot.contentJobId) continue;
            const w = await getDocument<AutoWork>(this.db, `autopilot-work-${slot.contentJobId}`);
            if (!w) continue;
            if (w.resultId) {
              if (slot.publishingJobId !== w.resultId)
                await this.saveSlot(slot, { publishingJobId: w.resultId });
              const j =
                w.kind === 'POST'
                  ? await this.db.get('publishJob', w.resultId)
                  : (await this.engagement.jobView(w.resultId)).job;
              const uncertain =
                w.kind === 'POST'
                  ? ['UNCERTAIN'].includes((j as any).postStatus)
                  : j?.status === 'UNCERTAIN';
              const published =
                w.kind === 'POST'
                  ? (j as any)?.postStatus === 'PUBLISHED'
                  : j?.status === 'PUBLISHED';
              if (uncertain) {
                await this.saveSlot(slot, {
                  status: 'UNCERTAIN',
                  failureReason: 'Результат отправки требует сверки; повторного submit нет',
                });
                await this.policy.failure(s.accountId, new AppError('UNCERTAIN', 'Нужна сверка'));
                continue;
              }
              if (published) {
                const post =
                  w.kind === 'POST' ? (await this.db.list('post', { jobId: w.resultId }))[0] : null;
                await this.saveSlot(slot, {
                  status: 'PUBLISHED',
                  failureReason: undefined,
                  publishedAt: post?.publishedAt.toISOString() ?? (j as EngagementJob).submittedAt,
                  permalink: post?.url ?? (j as EngagementJob).url,
                });
                await this.save(w, { status: 'PUBLISHED' });
                continue;
              }
              if (j?.status === 'QUEUED' && (j as any).lastError?.startsWith('AUTOPILOT_BLOCKED')) {
                await this.saveSlot(slot, {
                  status: 'FAILED',
                  failureReason: (j as any).lastError,
                });
                continue;
              }
              if (j?.status === 'RUNNING' || j?.status === 'SENDING') {
                await this.saveSlot(slot, { status: 'PUBLISHING' });
                continue;
              }
              if (
                j &&
                ['FAILED', 'CANCELLED', 'PAUSED', 'NEEDS_REVIEW'].includes(j.status) &&
                w.mode === 'LIVE'
              ) {
                await this.saveSlot(slot, {
                  status: 'FAILED',
                  failureReason: (j as any).lastError ?? (j as EngagementJob).error ?? j.status,
                });
                continue;
              }
              if (w.mode === 'DRY_RUN' && w.status === 'PREVIEWED') {
                await this.saveSlot(slot, {
                  status: 'READY',
                  previewAt: w.finishedAt,
                  failureReason: undefined,
                });
                continue;
              }
              if (slot.status !== 'READY' || slot.failureReason)
                await this.saveSlot(slot, { status: 'READY', failureReason: undefined });
              if (w.kind === 'REPLY' && Date.parse(slot.at) <= at && w.mode === 'LIVE') {
                const sent = await this.policy.sent(s.accountId, at);
                if (sent.lastReply && at - sent.lastReply < s.config.replyIntervalMinutes * 60000)
                  continue; // Interval starts at actual submit, not the previous planned slot.
                await this.generation.enqueue(
                  {
                    kind: 'AUTOPILOT_SEND_REPLY',
                    autoWorkId: w.id,
                    accountId: s.accountId,
                    actor: s.enabledBy!,
                    chatId: Number(s.enabledBy),
                  },
                  w.id,
                );
              }
              continue;
            }
            if (['NEEDS_REVIEW', 'REJECTED', 'SKIPPED', 'ERROR'].includes(w.status)) {
              const reason = w.error ?? w.reasons?.join(', ') ?? 'GENERATION_BLOCKED';
              const retry =
                slot.attempts < 2 &&
                Date.parse(slot.at) > at + 60000 &&
                !/UNKNOWN|UNCERTAIN|BUDGET|LIMIT_USD/.test(reason);
              await this.saveSlot(slot, {
                status: retry ? 'PLANNED' : w.status === 'ERROR' ? 'FAILED' : 'SKIPPED',
                contentJobId: undefined,
                failureReason: reason,
              });
            } else if (w.status === 'QUEUED') await this.enqueueWork(w);
          }
          const current = await this.schedule(s.accountId, at),
            today = localTime(at, s.config.timezone);
          if (today.minute >= minutes(s.config.end))
            await this.queueSummary(s.accountId, today.day);
          const manual = (await this.generation.list()).some(
            (t) =>
              !t.kind.startsWith('AUTOPILOT') &&
              t.kind !== 'MODEL_AB' &&
              ['QUEUED', 'RUNNING'].includes(t.status),
          );
          if (manual || (await this.db.list('publishJob')).some((j) => j.status === 'RUNNING'))
            continue;
          if (
            (await this.policy.works()).some(
              (w) =>
                w.accountId === s.accountId &&
                w.epoch === s.epoch &&
                ['QUEUED', 'RUNNING'].includes(w.status),
            )
          )
            continue;
          for (const old of current.filter(
            (x) => x.status === 'PLANNED' && at - Date.parse(x.at) > 10 * 60000,
          )) {
            await this.saveSlot(old, {
              status: 'SKIPPED',
              failureReason: 'SCHEDULER_LATE: пропущено при остановке, залповой отправки нет',
            });
            old.status = 'SKIPPED';
          }
          const slot = current.find(
            (x) => x.status === 'PLANNED' && (x.prepareNow || Date.parse(x.at) <= at + 60 * 60000),
          );
          if (!slot) continue;
          if (at - Date.parse(slot.at) > 10 * 60000) {
            await this.saveSlot(slot, {
              status: 'SKIPPED',
              failureReason: 'SCHEDULER_LATE: слот просрочен более 10 минут',
            });
            continue;
          }
          const claimed = new Set(
            (await this.db.list('setting'))
              .filter((r) => r.id.startsWith('autopilot-source-'))
              .map((r) => JSON.parse(r.value).url),
          );
          const settings = await this.engagement.settings(s.accountId),
            drafts = await this.engagement.drafts(s.accountId);
          let candidate: Candidate | undefined | null;
          if (slot.kind === 'POST')
            candidate = (await this.rank(s.accountId, at)).find(
              (r) => r.accepted && !claimed.has(r.candidate.url) && r.candidate.status === 'NEW',
            )?.candidate;
          else
            candidate = (await this.engagement.candidates(s.accountId)).find(
              (c) =>
                c.status === 'NEW' &&
                !claimed.has(c.url) &&
                !drafts.some((d) => d.candidateId === c.id) &&
                this.engagement.assess(c, settings).accepted &&
                freshness(c, s.config.maxAgeHours, Math.max(at, Date.parse(slot.at))).accepted,
            );
          if (!candidate) {
            const last = (await this.policy.works())
              .filter(
                (w) => w.accountId === s.accountId && w.epoch === s.epoch && w.kind === 'DISCOVER',
              )
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .at(-1);
            if (
              !last ||
              at - Date.parse(last.createdAt) > 30 * 60000 ||
              ((await this.policy.works()).filter(
                (w) => w.accountId === s.accountId && w.epoch === s.epoch && w.kind === 'DISCOVER',
              ).length < 3 &&
                last.status === 'PREVIEWED')
            ) {
              const id = hashDocument({
                discover: s.accountId,
                epoch: s.epoch,
                period: Math.floor(at / (30 * 60000)),
                turn: (await this.policy.works()).filter(
                  (w) =>
                    w.accountId === s.accountId && w.epoch === s.epoch && w.kind === 'DISCOVER',
                ).length,
              }).slice(0, 28);
              await this.enqueueWork({
                id,
                accountId: s.accountId,
                epoch: s.epoch,
                version: s.version,
                enabledAt: s.enabledAt!,
                createdAt: new Date(at).toISOString(),
                scheduledAt: new Date(at).toISOString(),
                kind: 'DISCOVER',
                mode: s.mode,
                status: 'QUEUED',
              });
              continue;
            }
            if (slot.kind === 'POST')
              candidate = await this.ownIdea(s.accountId, s.enabledBy!, slot);
            else {
              await this.saveSlot(slot, {
                status: 'SKIPPED',
                failureReason:
                  last?.status === 'SKIPPED' || last?.status === 'ERROR'
                    ? 'SEARCH_UNAVAILABLE: ' + (last.error ?? last.reasons?.join(', '))
                    : 'NO_RELEVANT_DISCUSSION: поиск завершён, свежих свободных кандидатов нет',
              });
              continue;
            }
          }
          if (!candidate) {
            await this.saveSlot(slot, {
              status: 'SKIPPED',
              failureReason: 'NO_QUALITY_IDEA: подходящие темы исчерпаны',
            });
            continue;
          }
          const id = hashDocument({ slot: slot.id, attempt: slot.attempts + 1 }).slice(0, 28),
            w: AutoWork = {
              id,
              accountId: s.accountId,
              epoch: s.epoch,
              version: s.version,
              enabledAt: s.enabledAt!,
              createdAt: new Date(at).toISOString(),
              scheduledAt: slot.at,
              kind: slot.kind,
              mode: s.mode,
              status: 'QUEUED',
              candidateId: candidate.id,
              evergreen: candidate.url.startsWith('idea:'),
              slotId: slot.id,
            };
          await this.saveSlot(slot, {
            status: 'PREPARING',
            contentJobId: id,
            attempts: slot.attempts + 1,
            attemptIds: [...slot.attemptIds, id],
          });
          await this.enqueueWork(w);
        } catch (e) {
          await this.policy.failure(state.accountId, e);
        }
      }
    });
  }
  async requestReplies(
    accountId: string,
    count: number,
    actor: string,
    notBefore = Date.now() + 60000,
  ) {
    const s = await this.policy.settings(accountId);
    assert(
      actor === s.enabledBy && s.state === 'RUNNING' && s.mode === 'LIVE',
      'AUTOPILOT_OFF',
      'Для отправки включите AUTOPILOT LIVE',
    );
    assert(Number.isInteger(count) && count >= 1 && count <= 3, 'COUNT', 'Выберите 1–3 ответа');
    const already = (await this.schedule(accountId)).filter(
      (x) =>
        x.kind === 'REPLY' &&
        x.prepareNow &&
        ['PLANNED', 'PREPARING', 'READY', 'PUBLISHING'].includes(x.status),
    );
    if (already.length) return already.slice(0, count);
    const slots = (await this.schedule(accountId)).filter(
      (x) => x.kind === 'REPLY' && x.status === 'PLANNED',
    );
    const sent = await this.policy.sent(accountId),
      interval = s.config.replyIntervalMinutes * 60000,
      start = Math.max(notBefore, sent.lastReply + interval),
      day = localTime(Date.now(), s.config.timezone).day,
      selected = slots.filter((x) => x.localDate === day).slice(0, count),
      reserved = (await this.schedule(accountId))
        .filter(
          (x) =>
            x.kind === 'REPLY' &&
            x.localDate === day &&
            !['SKIPPED', 'FAILED', 'PUBLISHED'].includes(x.status) &&
            !selected.some((s) => s.id === x.id),
        )
        .map((x) => Date.parse(x.at));
    const chosen: PublicationSlot[] = [];
    let cursor = start;
    for (const slot of selected) {
      let when = cursor;
      for (let step = 0; step <= reserved.length; step++) {
        const conflict = reserved.find((at) => Math.abs(at - when) < interval);
        if (conflict === undefined) break;
        when = conflict + interval;
      }
      if (localTime(when, s.config.timezone).minute >= minutes(s.config.end)) break;
      chosen.push(
        await this.saveSlot(slot, {
          at: new Date(when).toISOString(),
          plannedAtUtc: new Date(when).toISOString(),
          prepareNow: true,
        }),
      );
      reserved.push(when);
      cursor = when + interval;
    }
    assert(chosen.length, 'NO_SLOTS', 'Нет доступных слотов в сегодняшнем окне/лимите');
    await audit(
      this.db,
      actor,
      'GENERATE_AND_SEND_REPLIES',
      accountId,
      JSON.stringify(chosen.map((s) => ({ id: s.id, at: s.at }))),
    );
    return chosen;
  }
  async previewSlot(accountId: string, id: string) {
    const slot = (await this.schedule(accountId)).find((x) => x.id === id);
    assert(slot?.publishingJobId, 'NOT_READY', 'Нет готового текста');
    const w = (await getDocument<AutoWork>(this.db, `autopilot-work-${slot.contentJobId}`))!;
    if (slot.kind === 'POST') await this.publisher.previewAutopilot(slot.publishingJobId);
    else {
      const v = await this.engagement.jobView(slot.publishingJobId);
      assert(v.draft && !v.job.submittedAt, 'ALREADY_SENT', 'Проверка только до submit');
      await this.engagement.port.reply(v.job, v.draft, v.candidate, false, async () => {
        throw new AppError('DRY_RUN_ONLY', 'Submit закрыт');
      });
    }
    await this.saveSlot(slot, { previewAt: new Date().toISOString() });
    return { slotId: id, submit: false, text: w.text, at: new Date().toISOString() };
  }
  async discoveryReports() {
    return (await listDocuments<any>(this.db, 'autopilot-discovery-')).filter(
      (d) => d.epoch && !d.notifiedAt,
    );
  }
  async acknowledgeDiscovery(d: any) {
    await putDocument(this.db, `autopilot-discovery-${d.workId}`, {
      ...d,
      notifiedAt: new Date().toISOString(),
    });
  }
  async outcomes() {
    return (await listDocuments<Plan>(this.db, 'autopilot-plan-'))
      .filter((p) => p.schemaVersion === 117)
      .flatMap((p) => p.slots)
      .filter(
        (s) => ['PUBLISHED', 'SKIPPED', 'FAILED', 'UNCERTAIN'].includes(s.status) && !s.notifiedAt,
      );
  }
  async acknowledge(slot: PublicationSlot) {
    return this.saveSlot(slot, { notifiedAt: new Date().toISOString() });
  }
  async sendReply(workId: string) {
    const w = await getDocument<AutoWork>(this.db, `autopilot-work-${workId}`);
    assert(
      w && w.kind === 'REPLY' && w.mode === 'LIVE' && w.status === 'SCHEDULED' && w.resultId,
      'AUTOPILOT_SCOPE',
      'Ответ не разрешён',
    );
    const s = await this.policy.assertWork(w);
    let j: EngagementJob;
    try {
      j = await this.replies.execute(w.resultId, false, { autopilot: true, actor: s.enabledBy! });
    } catch (e) {
      if (
        e instanceof AppError &&
        ['NOT_DUE', 'AUTOPILOT_INTERVAL', 'PROFILE_BUSY'].includes(e.code)
      ) {
        const current = (await this.engagement.jobView(w.resultId)).job;
        if (current.status === 'QUEUED' && !current.submittedAt)
          return { ...w, status: 'QUEUED' as const }; // Existing dispatcher retries; no LLM or submit.
      }
      throw e;
    }
    if (j.status === 'QUEUED' && !j.submittedAt) return { ...w, status: 'QUEUED' as const };
    if (j.status === 'UNCERTAIN')
      await this.policy.failure(w.accountId, new AppError('UNCERTAIN', 'Нужна сверка'));
    if (j.status === 'PUBLISHED') await this.policy.success(w.accountId);
    return this.save(w, {
      status:
        j.status === 'PUBLISHED' ? 'PUBLISHED' : j.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'ERROR',
      finishedAt: new Date().toISOString(),
      error: j.error,
    });
  }
  private async collectReplyMetric(accountId: string) {
    if (!this.engagement.port.readPost) return;
    const snapshots = await listDocuments<any>(this.db, 'autopilot-reply-metric-');
    for (const j of (await this.engagement.jobs(accountId)).filter(
      (j) => j.status === 'PUBLISHED' && j.url && j.submittedAt,
    )) {
      const age = (Date.now() - Date.parse(j.submittedAt!)) / 3600000,
        hour = [1, 24].find(
          (h) => age >= h && !snapshots.some((m) => m.jobId === j.id && m.targetHours === h),
        );
      if (!hour) continue;
      const body = await this.engagement.port.readPost(accountId, j.url!);
      const observation = observe({ ...body, id: j.id, url: j.url! } as Candidate);
      await putDocument(this.db, `autopilot-reply-metric-${j.id}-${hour}`, {
        jobId: j.id,
        accountId,
        sourceUrl: (await this.engagement.candidate(accountId, j.candidateId)).url,
        text: (await this.engagement.draft(accountId, j.draftId!)).text,
        submittedAt: j.submittedAt,
        url: j.url,
        targetHours: hour,
        measuredAt: new Date().toISOString(),
        observation,
      });
      return; // One extra read-only browser visit per low-priority task, never a burst.
    }
  }
  async stats(accountId: string, at = Date.now()) {
    const s = await this.policy.settings(accountId),
      today = localTime(at, s.config.timezone).day,
      works = (await this.policy.works()).filter((w) => w.accountId === accountId),
      dayWorks = works.filter(
        (w) =>
          w.epoch === s.epoch &&
          localTime(Date.parse(w.createdAt), s.config.timezone).day === today,
      );
    const posts = await this.db.list('post', { accountId }),
      todaysPosts = posts.filter(
        (p) => localTime(p.publishedAt.getTime(), s.config.timezone).day === today,
      ),
      replies = (await this.engagement.jobs(accountId)).filter(
        (j) =>
          j.status === 'PUBLISHED' &&
          j.submittedAt &&
          localTime(Date.parse(j.submittedAt), s.config.timezone).day === today,
      );
    const discoveries = (await listDocuments<any>(this.db, 'autopilot-discovery-')).filter(
      (d) =>
        d.accountId === accountId && localTime(Date.parse(d.at), s.config.timezone).day === today,
    );
    const usage = (await this.db.list('aiRequest', { accountId })).filter(
        (r) => localTime(r.createdAt.getTime(), s.config.timezone).day === today,
      ),
      byModel = Object.fromEntries(
        [...new Set(usage.map((r) => r.model))].map((model) => [
          model,
          usage
            .filter((r) => r.model === model)
            .reduce(
              (a, r) => ({
                requests: a.requests + 1,
                input: a.input + r.inputTokens,
                output: a.output + r.outputTokens,
                costUsd: a.costUsd + r.costUsd,
              }),
              { requests: 0, input: 0, output: 0, costUsd: 0 },
            ),
        ]),
      );
    const metrics = await this.db.list('postMetric'),
      ranked = posts.map((p) => {
        const samples = metrics
            .filter((m) => m.postId === p.id)
            .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime()),
          m = samples.at(-1);
        return {
          url: p.url,
          postId: p.id,
          at: p.publishedAt.toISOString(),
          likes: m?.likes ?? null,
          replies: m?.replies ?? null,
          reposts: m?.reposts ?? null,
          views1h: samples.find((m) => m.targetHours === 1)?.views ?? null,
          views24h: samples.find((m) => m.targetHours === 24)?.views ?? null,
          engagement:
            m && [m.likes, m.replies, m.reposts].some((v) => v !== null)
              ? (m.likes ?? 0) + (m.replies ?? 0) + (m.reposts ?? 0)
              : null,
        };
      });
    const available = ranked
        .filter((p) => p.engagement !== null)
        .sort((a, b) => b.engagement! - a.engagement!),
      followers = (await this.db.list('accountMetric', { accountId }))
        .filter((m) => m.followers !== null)
        .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
    const provenance = await listDocuments<any>(this.db, 'autopilot-provenance-');
    const plans = (await listDocuments<Plan>(this.db, 'autopilot-plan-')).filter(
      (p) => p.accountId === accountId && p.day === today,
    );
    const skippedSlots = plans
      .flatMap((p) => p.slots)
      .filter((s) => s.skipped || s.status === 'SKIPPED').length;
    const group = (key: 'topic' | 'style') => {
      const groups: Record<string, { posts: number; measured: number; engagement: number }> = {};
      for (const p of posts) {
        const w = works.find((w) => w.resultId === p.jobId),
          pr = provenance.find((x) => x.workId === w?.id),
          g = (key === 'topic' ? pr?.topic : (pr?.styleId ?? 'existing-style')) ?? 'не размечено',
          m = ranked.find((x) => x.postId === p.id)!;
        groups[g] ??= { posts: 0, measured: 0, engagement: 0 };
        groups[g]!.posts++;
        if (m.engagement !== null) {
          groups[g]!.measured++;
          groups[g]!.engagement += m.engagement;
        }
      }
      return groups;
    };
    return {
      today,
      state: s.state,
      mode: s.mode,
      plan: { posts: s.config.posts, replies: s.config.replies },
      published: { posts: todaysPosts.length, replies: replies.length },
      found: discoveries.reduce((n, d) => n + (d.metrics?.found ?? 0), 0),
      strong: new Set(
        discoveries.flatMap((d) => d.ranked.filter((r: any) => r.accepted).map((r: any) => r.url)),
      ).size,
      generated: new Set(
        dayWorks.filter((w) => w.kind === 'POST' && w.requestId).map((w) => w.requestId),
      ).size,
      skipped: skippedSlots,
      errors:
        plans.flatMap((p) => p.slots).filter((s) => ['FAILED', 'UNCERTAIN'].includes(s.status))
          .length +
        dayWorks.filter((w) => w.kind === 'DISCOVER' && w.status === 'ERROR').length +
        (s.state === 'ERROR' ? 1 : 0),
      byModel,
      links: [...todaysPosts.map((p) => p.url), ...replies.map((j) => j.url).filter(Boolean)],
      top10: available.slice(0, 10),
      bottom10: [...available].reverse().slice(0, 10),
      followers: followers.at(-1)?.followers ?? null,
      followerDelta:
        followers.length >= 2 ? followers.at(-1)!.followers! - followers[0]!.followers! : null,
      last7days: Array.from({ length: 7 }, (_, i) => {
        const day = localTime(at - i * 86400000, s.config.timezone).day;
        return {
          day,
          posts: posts.filter(
            (p) => localTime(p.publishedAt.getTime(), s.config.timezone).day === day,
          ).length,
        };
      }),
      topics: group('topic'),
      styles: group('style'),
      successRate: works.filter((w) => w.resultId && w.mode === 'LIVE').length
        ? works.filter((w) => w.status === 'PUBLISHED' && w.mode === 'LIVE').length /
          works.filter((w) => w.resultId && w.mode === 'LIVE').length
        : null,
      replyMetrics: (await listDocuments<any>(this.db, 'autopilot-reply-metric-')).filter(
        (m) => m.accountId === accountId,
      ),
      missingMetrics:
        'Недоступные просмотры/подписчики сохранены null; отсутствующие измерения не равны нулю',
    };
  }
  async queueSummary(accountId: string, day: string) {
    const current = await this.policy.settings(accountId);
    const id = `${accountId}-${day}-${current.mode === 'LIVE' ? 'LIVE' : `DRY_RUN-${current.epoch}`}`,
      key = `autopilot-summary-${id}`;
    if (await getDocument(this.db, key)) return;
    const s = await this.policy.settings(accountId),
      r = await this.stats(accountId),
      cost = Object.values(r.byModel).reduce((n, m) => n + m.costUsd, 0);
    const text = `CONTENT FACTORY — ${accountId}\n${day} (${s.config.timezone})\nПосты: ${r.published.posts}/${r.plan.posts}\nРеплаи: ${r.published.replies}/${r.plan.replies}\nТем: ${r.strong}; пропущено: ${r.skipped}; ошибок: ${r.errors}\nМаксимумы не заполняются слабым материалом\nРасход LLM: $${cost.toFixed(6)}\nАвтопилот: ${s.state} (${s.mode})\n${r.links.slice(-25).join('\n')}`;
    await putDocument<DailySummary>(this.db, key, {
      id,
      accountId,
      day,
      chatId: Number(s.enabledBy),
      text,
    });
  }
  async summaries() {
    return (await listDocuments<DailySummary>(this.db, 'autopilot-summary-')).filter(
      (x) => !x.deliveredAt,
    );
  }
}
