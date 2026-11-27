import { AutopilotPolicy, type AutoGrant } from '../autopilot/policy.js';
import { createCtaTask, updateCtaTask, ctaKey, type CtaTask } from '../cta/tasks.js';
import { putDocument } from '../db/documents.js';
import { assertSourceRights } from '../content/rights.js';
import { ManualPolicy, assertNotEmergency, automationPaused } from '../policy/manual.js';
import { getDocument, hashDocument } from '../db/documents.js';
import type { Database } from '../db/database.js';
import { base } from '../db/database.js';
import { AppError, assert, messageOf } from '../core/errors.js';
import type { Account, BrowserProfile, PublishJob } from '../core/domain.js';
import type { BrowserProvider } from '../browser/providers.js';
import type { Publisher, PublishingSession } from '../browser/publisher.js';
import { withProfileLease } from './lease.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { CtaService, ctaSignature } from '../cta/service.js';
import { renderCta } from '../cta/service.js';
import { contentFeatures } from '../content/features.js';
import { validateContent } from '../content/service.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export interface WorkerClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
export const realClock: WorkerClock = {
  now: () => Date.now(),
  sleep: async (ms, signal) => {
    await sleep(ms, undefined, { signal });
  },
};
export type Notify = (message: string) => Promise<void>;
export async function withBrowserSlot<T>(
  db: Database,
  limit: number,
  fn: (slotSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  for (let i = 0; i < limit; i++) {
    let acquired = false;
    try {
      return await withProfileLease(db, `browser-slot-${i}`, async (signal) => {
        acquired = true;
        return fn(signal);
      });
    } catch (e) {
      if (acquired || !(e instanceof AppError) || e.code !== 'PROFILE_BUSY') throw e;
    }
  }
  throw new AppError('PROFILE_BUSY', 'Все браузерные исполнители заняты', true);
}
export class PublishingWorker {
  constructor(
    private db: Database,
    private providers: Record<BrowserProfile['provider'], BrowserProvider>,
    private publisher: Publisher,
    private notify: Notify = async () => {},
    private concurrency = 1,
    private clock: WorkerClock = realClock,
    private liveAllowed = true,
    private manual?: ManualPolicy,
    private autopilot?: AutopilotPolicy,
  ) {}
  async previewCta(id: string) {
    const j = await this.db.get('publishJob', id),
      p = (await this.db.list('post', { jobId: id }))[0];
    assert(
      j?.postStatus === 'PUBLISHED' && p,
      'CTA_PARENT',
      'Нужен опубликованный собственный пост',
    );
    const a = (await this.db.get('account', j.accountId))!,
      profile = (await this.db.get('browserProfile', a.profileId))!,
      c = await new CtaService(this.db).ensure(a.id);
    assert(c.text.trim(), 'CTA_REQUIRED', 'CTA не настроен');
    await assertNotEmergency(this.db);
    return withBrowserSlot(this.db, this.concurrency, (slot) =>
      withProfileLease(this.db, profile.id, async (signal) => {
        const provider = this.providers[profile.provider];
        assert(!(await provider.status(profile.externalId)), 'PROFILE_BUSY', 'Профиль занят');
        const session = await this.publisher.open(provider, profile.externalId, a, `cta-dry-${id}`),
          sentinel = new Error('CTA_DRY_BARRIER');
        let reached = false,
          result: { url: string | null } | undefined;
        try {
          await session.check();
          try {
            result = await session.comment(
              p.url,
              renderCta(c.text, c.url),
              async () => {
                slot.throwIfAborted();
                signal.throwIfAborted();
                reached = true;
                throw sentinel;
              },
              c.mediaPath && c.mediaSha256
                ? { path: c.mediaPath, sha256: c.mediaSha256 }
                : undefined,
            );
          } catch (e) {
            if (e !== sentinel) throw e;
          }
          assert(
            reached || result !== undefined,
            'CTA_DRY_FAILED',
            'Редактор или существующий CTA не подтверждён',
          );
          const proof = {
            jobId: id,
            accountId: a.id,
            parentUrl: p.url,
            signature: ctaSignature(c),
            absent: reached,
            existingUrl: result?.url ?? null,
            at: new Date().toISOString(),
            submit: false,
          };
          await putDocument(this.db, `cta-verified-${id}`, proof);
          return proof;
        } finally {
          await session.close();
        }
      }),
    );
  }
  async requestMissingCta(id: string, actor: string, expectedSignature: string) {
    assert(this.autopilot, 'CTA_SCOPE', 'Нет контроллера CTA');
    this.autopilot.assertCtaOwner(actor);
    return this.db.transaction(async (tx) => {
      await assertNotEmergency(tx);
      const j = await tx.get('publishJob', id),
        p = (await tx.list('post', { jobId: id }))[0],
        proof = await getDocument<any>(tx, `cta-verified-${id}`);
      assert(j, 'NOT_FOUND', 'Задача не найдена');
      const c = await new CtaService(tx).ensure(j.accountId),
        old = await getDocument<CtaTask>(tx, ctaKey(id));
      if (
        old?.status === 'WAITING' &&
        !j.ctaSubmitAt &&
        old.ctaVersion === (c.version ?? 1) &&
        expectedSignature === ctaSignature(c)
      )
        return old;
      assert(
        j &&
          p &&
          j.postStatus === 'PUBLISHED' &&
          !j.ctaSubmitAt &&
          !['SENDING', 'UNCERTAIN', 'PUBLISHED'].includes(j.commentStatus) &&
          !['SENDING', 'UNCERTAIN', 'PUBLISHED'].includes(old?.status ?? ''),
        'CTA_ALREADY_STARTED',
        'CTA уже отправлен или требует сверки; автоматического повтора нет',
      );
      assert(
        proof?.absent &&
          proof.parentUrl === p.url &&
          proof.signature === expectedSignature &&
          expectedSignature === ctaSignature(c) &&
          Date.now() - Date.parse(proof.at) < 5 * 60000,
        'CTA_VERIFY_REQUIRED',
        'Проверьте отсутствие CTA и текущий предпросмотр',
      );
      assert(
        !(await tx.list('comment', { postId: p.id })).length,
        'CTA_EXISTS',
        'Комментарий уже сохранён',
      );
      const updated = await tx.update('publishJob', id, {
        status: 'QUEUED',
        commentStatus: 'PENDING',
        ctaEnabled: true,
        ctaText: c.text,
        ctaUrl: c.url ?? null,
        ctaVersion: c.version ?? 1,
        ctaMediaPath: c.mediaPath ?? null,
        ctaMediaSha256: c.mediaSha256 ?? null,
        ctaCapturedAt: new Date(),
        ctaScheduledAt: new Date(),
        scheduledAt: new Date(),
        lastError: null,
        revision: j.revision + 1,
      });
      if (old) await tx.remove('setting', ctaKey(id)); // Replaces only a never-submitted disabled/failed child; audit retains it.
      await tx.insert('audit', {
        ...base(),
        actor,
        action: 'MANUAL_MISSING_CTA',
        entityId: id,
        detail: JSON.stringify({ parent: p.url, signature: expectedSignature, previous: old }),
      });
      return createCtaTask(tx, updated, p, actor);
    });
  }
  /** Existing publisher fills/checks the composer; its send barrier is never crossed. */
  async previewAutopilot(id: string) {
    const grant = await getDocument<AutoGrant>(this.db, `autopilot-grant-${id}`),
      job = await this.db.get('publishJob', id);
    assert(
      this.autopilot &&
        grant &&
        job &&
        ['PAUSED', 'QUEUED'].includes(job.status) &&
        !job.postSubmitAt,
      'DRY_RUN_ONLY',
      'Только новая DRY_RUN-задача',
    );
    await assertNotEmergency(this.db);
    const a = (await this.db.get('account', grant.accountId))!,
      p = (await this.db.get('browserProfile', a.profileId))!,
      g = (await this.db.get('generated', job.generatedId))!;
    assert(hashDocument(g.text) === grant.hash, 'AUTOPILOT_TEXT_CHANGED', 'Текст изменился');
    return withBrowserSlot(this.db, this.concurrency, (slot) =>
      withProfileLease(this.db, p.id, async (signal) => {
        const provider = this.providers[p.provider];
        assert(!(await provider.status(p.externalId)), 'PROFILE_BUSY', 'Профиль занят');
        const session = await this.publisher.open(provider, p.externalId, a, `dry-${id}`),
          sentinel = new Error('AUTOPILOT_DRY_PREVIEW_COMPLETE');
        let reached = false;
        try {
          await session.check();
          try {
            await session.publish(g.text, async () => {
              slot.throwIfAborted();
              signal.throwIfAborted();
              await assertNotEmergency(this.db);
              reached = true;
              throw sentinel;
            });
          } catch (e) {
            if (e !== sentinel) throw e;
          }
          assert(reached, 'DRY_BARRIER_NOT_REACHED', 'Редактор не проверен');
          const result = {
            jobId: id,
            textHash: grant.hash,
            at: new Date().toISOString(),
            submit: false,
            barrierReached: true,
          };
          await putDocument(this.db, `autopilot-preview-${id}`, result);
          return result;
        } finally {
          await session.close();
        }
      }),
    );
  }
  async execute(id: string, revision?: number) {
    const child = await getDocument<CtaTask>(this.db, ctaKey(id));
    const manual = await getDocument<{
      actor: string;
      sessionId: string;
      epoch: number;
      accountId: string;
      hash: string;
      version: number;
      generatedId: string;
      ctaHash: string;
      expiresAt: string;
    }>(this.db, `manual-post-${id}`);
    const auto = manual ? null : await getDocument<AutoGrant>(this.db, `autopilot-grant-${id}`);
    assert(
      this.liveAllowed ||
        (manual && this.manual) ||
        (auto?.mode === 'LIVE' && this.autopilot) ||
        (child?.manualRequestedBy && this.autopilot),
      'DRY_RUN_ONLY',
      'Ручные публикации выключены',
    );
    const guard = async (db: Database = this.db, cta = false) => {
      await assertNotEmergency(db);
      if (child?.manualRequestedBy) {
        assert(this.autopilot, 'CTA_SCOPE', 'Нет контроллера CTA');
        await this.autopilot.validateCta(id, db);
        return;
      }
      if (auto) {
        assert(this.autopilot, 'AUTOPILOT_SCOPE', 'Нет контроллера автопилота');
        const current = await db.get('publishJob', id);
        await this.autopilot.validate(
          id,
          'POST',
          db,
          this.clock.now(),
          cta || current?.postStatus === 'PUBLISHED',
        );
      }
      if (manual) {
        assert(this.manual, 'MANUAL_DISABLED', 'Ручные публикации выключены');
        await this.manual.assertAllowed(
          manual.accountId,
          manual.actor,
          manual.sessionId,
          manual.epoch,
          db,
        );
        assert(
          Date.parse(manual.expiresAt) > Date.now(),
          'PERMISSION_EXPIRED',
          'Срок отправки истёк; автоматического повтора нет',
        );
        const g = await db.get('generated', manual.generatedId);
        assert(
          g &&
            g.accountId === manual.accountId &&
            g.version === manual.version &&
            hashDocument(g.text) === manual.hash &&
            !(await getDocument(db, `superseded-${g.id}`)) &&
            !(await getDocument(db, `rejected-${g.id}`)),
          'STALE_CARD',
          'Версия текста устарела или отклонена',
        );
      }
    };
    const initial = await this.db.get('publishJob', id);
    if (
      !initial ||
      initial.status !== 'QUEUED' ||
      (revision !== undefined && revision !== initial.revision) ||
      initial.scheduledAt.getTime() > this.clock.now()
    )
      return;
    if (
      !manual &&
      !auto &&
      !child?.manualRequestedBy &&
      ((await automationPaused(this.db)) || (await getDocument(this.db, 'publishing-policy-v112')))
    )
      return;
    const account = await this.db.get('account', initial.accountId);
    if (!account || account.status !== 'ACTIVE') return;
    const profile = await this.db.get('browserProfile', account.profileId);
    assert(profile, 'NO_PROFILE', 'Профиль не найден');
    try {
      await guard();
      await withBrowserSlot(this.db, this.concurrency, (slotSignal) =>
        withProfileLease(this.db, profile.id, async (profileSignal) => {
          const signal = AbortSignal.any([slotSignal, profileSignal]);
          let claimed = false;
          let session: PublishingSession | undefined;
          let renewal: Promise<unknown> = Promise.resolve();
          const job = await this.db.transaction(async (tx) => {
            const j = await tx.get('publishJob', id);
            if (!j || j.status !== 'QUEUED' || j.revision !== initial.revision) return null;
            await guard(tx);
            if (
              (!manual && !auto && !child?.manualRequestedBy && (await automationPaused(tx))) ||
              (await tx.get('account', account.id))?.status !== 'ACTIVE'
            )
              return null;
            const predecessors = (await tx.list('publishJob', { batchId: j.batchId })).filter(
              (other) =>
                (other.sequence ?? 0) < (j.sequence ?? 0) &&
                ['QUEUED', 'RUNNING'].includes(other.status),
            );
            if (predecessors.length) {
              await tx.update('publishJob', id, {
                delayReason: 'WAITING_FOR_PREVIOUS_JOB',
                updatedAt: new Date(),
              });
              return null;
            }
            if (
              j.postStatus === 'SENDING' ||
              j.commentStatus === 'SENDING' ||
              j.postStatus === 'UNCERTAIN' ||
              j.commentStatus === 'UNCERTAIN'
            ) {
              await tx.update('publishJob', id, { status: 'NEEDS_REVIEW', updatedAt: new Date() });
              return null;
            }
            let ctaSnapshot = {};
            if ((!j.ctaCapturedAt || auto) && j.postStatus === 'PENDING') {
              const cta = await new CtaService(tx).ensure(j.accountId);
              const enabled = auto
                ? (await this.autopilot!.settings(j.accountId, tx)).config.allowCTA
                : cta.enabled;
              assert(
                !manual ||
                  manual.ctaHash ===
                    hashDocument({
                      text: cta.text,
                      url: cta.url,
                      enabled: cta.enabled,
                      media: cta.mediaSha256,
                    }),
                'STALE_CTA',
                'CTA изменён после предпросмотра. Отправки нет',
              );
              assert(
                auto ||
                  !enabled ||
                  (renderCta(cta.text, cta.url).length > 0 &&
                    [...renderCta(cta.text, cta.url)].length <= 500),
                'CTA_REQUIRED',
                'Настройте действующий CTA',
              );
              ctaSnapshot = {
                ctaText: cta.text,
                ctaMediaPath: cta.mediaPath ?? j.ctaMediaPath ?? null,
                ctaMediaSha256: cta.mediaSha256 ?? j.ctaMediaSha256 ?? null,
                ctaUrl: cta.url ?? null,
                ctaVersion: cta.version ?? 1,
                ctaUpdatedAt: cta.updatedAt ?? cta.createdAt,
                ctaEnabled: enabled,
                ctaCapturedAt: new Date(this.clock.now()),
                commentStatus: enabled ? 'PENDING' : 'DISABLED',
              };
              if (auto)
                await putDocument(tx, `autopilot-grant-${id}`, {
                  ...auto,
                  ctaHash: hashDocument({
                    text: cta.text,
                    url: cta.url ?? null,
                    media: cta.mediaSha256 ?? null,
                    enabled,
                  }),
                });
            }
            claimed = true;
            return tx.update('publishJob', id, {
              status: 'RUNNING',
              ...ctaSnapshot,
              startedAt: j.startedAt ?? new Date(this.clock.now()),
              lastAttemptAt: new Date(this.clock.now()),
              delayMs: Math.max(
                0,
                (j.startedAt?.getTime() ?? this.clock.now()) -
                  (j.plannedAt ?? j.scheduledAt).getTime(),
              ),
              delayReason:
                j.delayReason ??
                (this.clock.now() - (j.plannedAt ?? j.scheduledAt).getTime() > 5000
                  ? 'WORKER_LATE'
                  : null),
              updatedAt: new Date(),
              attempts: j.attempts + (j.postStatus === 'PENDING' ? 1 : 0),
            });
          });
          if (!job) return;
          let delayCheck: Promise<unknown> = Promise.resolve();
          const delayTimer = setInterval(() => {
            delayCheck = delayCheck.then(() => this.checkCtaDelay(id)).catch(() => {});
          }, 5000);
          delayTimer.unref();
          const timer = setInterval(() => {
            renewal = renewal
              .then(() => this.db.update('publishJob', id, { updatedAt: new Date() }))
              .catch(() => {});
          }, 20000);
          timer.unref();
          const onAbort = () => {
            void session?.close().catch(() => {});
          };
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            const g = await this.db.get('generated', job.generatedId);
            assert(g?.approved && g.valid, 'INVALID_DRAFT', 'Нет одобренного текста');
            if (job.ctaEnabled && job.ctaMediaPath && job.postStatus === 'PUBLISHED') {
              const data = await readFile(job.ctaMediaPath);
              assert(
                data.length > 0 &&
                  data.length <= 10 * 1024 * 1024 &&
                  createHash('sha256').update(data).digest('hex') === job.ctaMediaSha256,
                'MEDIA_CHANGED',
                'Изображение CTA изменено; публикация запрещена',
              );
            }
            const priorPosts = await this.db.list('post', {
              accountId: account.id,
              generatedId: g.id,
            });
            assert(
              !priorPosts.some((post) => post.jobId !== id),
              'DUPLICATE_POST',
              'Этот вариант уже опубликован на этом аккаунте другой задачей',
            );
            const relatedJobs = await this.db.list('publishJob', {
              accountId: account.id,
              generatedId: g.id,
            });
            assert(
              !relatedJobs.some(
                (other) => other.id !== id && ['SENDING', 'UNCERTAIN'].includes(other.postStatus),
              ),
              'DUPLICATE_UNCERTAIN',
              'Результат предыдущей отправки этого варианта требует ручной проверки',
            );
            const provider = this.providers[profile.provider];
            assert(
              !(await provider.status(profile.externalId)),
              'PROFILE_BUSY',
              'Профиль уже открыт другим процессом',
            );
            session = await this.publisher.open(provider, profile.externalId, account, id);
            signal.throwIfAborted();
            await session.check();
            let post = (await this.db.list('post', { jobId: id }))[0];
            const barrier = async (field: 'postStatus' | 'commentStatus') => {
              signal.throwIfAborted();
              if (field === 'commentStatus') {
                const current = await this.db.get('publishJob', id);
                const confirmed = (await this.db.list('post', { jobId: id }))[0];
                assert(
                  current?.postStatus === 'PUBLISHED' && confirmed,
                  'POST_NOT_CONFIRMED',
                  'CTA требует подтверждённого поста',
                );
                const due =
                  current.ctaScheduledAt?.getTime() ??
                  (current.postSubmitAt?.getTime() ?? confirmed.publishedAt.getTime()) + 20000;
                while (this.clock.now() < due) {
                  signal.throwIfAborted();
                  await this.clock.sleep(due - this.clock.now(), signal);
                }
                await this.checkCtaDelay(id);
              }
              await this.db.transaction(async (tx) => {
                const current = await tx.get('publishJob', id);
                assert(
                  current?.status === 'RUNNING' && current[field] === 'PENDING',
                  'INVALID_STATE',
                  'Отправка уже начата',
                );
                await guard(tx, field === 'commentStatus');
                assert(
                  (await tx.get('account', account.id))?.status === 'ACTIVE' &&
                    (manual || auto || child?.manualRequestedBy || !(await automationPaused(tx))),
                  'PAUSED',
                  'Публикации приостановлены',
                );
                if (field === 'postStatus') {
                  const approved = await tx.get('generated', g.id);
                  assert(
                    approved?.approved &&
                      approved.valid &&
                      approved.text === g.text &&
                      approved.version === g.version &&
                      approved.sourceId === g.sourceId &&
                      approved.accountId === account.id,
                    'APPROVAL_CHANGED',
                    'Одобренный текст изменён или подтверждение отозвано',
                  );
                  const source = await tx.get('source', g.sourceId),
                    style = await tx.get('style', g.styleId);
                  assert(source, 'NOT_FOUND', 'Исходник не найден');
                  await assertSourceRights(tx, source.id);
                  assert(
                    style && !validateContent(g.text, source.text, style).length,
                    'INVALID_DRAFT',
                    'Текст больше не соответствует проверкам',
                  );
                }
                if (field === 'commentStatus') {
                  assert(
                    current.ctaMediaPath === job.ctaMediaPath &&
                      current.ctaMediaSha256 === job.ctaMediaSha256 &&
                      current.ctaText === job.ctaText &&
                      current.ctaUrl === job.ctaUrl,
                    'APPROVAL_CHANGED',
                    'Подтверждённый CTA изменён',
                  );
                  const confirmed = (await tx.list('post', { jobId: id }))[0];
                  assert(
                    current.postStatus === 'PUBLISHED' &&
                      confirmed &&
                      this.clock.now() >=
                        (current.ctaScheduledAt?.getTime() ??
                          (current.postSubmitAt?.getTime() ?? confirmed.publishedAt.getTime()) +
                            20000),
                    'COMMENT_TOO_EARLY',
                    'Комментарий нельзя отправлять раньше назначенного времени или без подтверждения поста',
                  );
                }
                const stamp = new Date(this.clock.now());
                await tx.update('publishJob', id, {
                  [field]: 'SENDING',
                  updatedAt: stamp,
                  ...(field === 'postStatus'
                    ? {
                        postSubmitAt: stamp,
                        ctaScheduledAt: job.ctaEnabled ? new Date(stamp.getTime() + 20000) : null,
                        commentNotBefore: job.ctaEnabled ? new Date(stamp.getTime() + 20000) : null,
                      }
                    : { ctaSubmitAt: stamp }),
                });
                if (field === 'commentStatus')
                  await updateCtaTask(tx, id, {
                    status: 'SENDING',
                    submittedAt: stamp.toISOString(),
                    reason: undefined,
                  });
              });
            };
            const observedSubmit = async (field: 'post' | 'cta', at: Date) => {
              await this.db.transaction(async (tx) => {
                const current = await tx.get('publishJob', id);
                assert(
                  current?.status === 'RUNNING' &&
                    current[field === 'post' ? 'postStatus' : 'commentStatus'] === 'SENDING',
                  'INVALID_STATE',
                  'Отправка не находится на подтверждаемом этапе',
                );
                const observedAt = new Date(
                  Math.max(
                    at.getTime(),
                    (field === 'post' ? current.postSubmitAt : current.ctaSubmitAt)?.getTime() ?? 0,
                  ),
                );
                await tx.update(
                  'publishJob',
                  id,
                  field === 'post'
                    ? {
                        postSubmitAt: observedAt,
                        ctaScheduledAt: current.ctaEnabled
                          ? new Date(observedAt.getTime() + 20000)
                          : null,
                        commentNotBefore: current.ctaEnabled
                          ? new Date(observedAt.getTime() + 20000)
                          : null,
                      }
                    : { ctaSubmitAt: observedAt },
                );
                if (field === 'cta')
                  await updateCtaTask(tx, id, { submittedAt: observedAt.toISOString() });
              });
            };
            if (!post) {
              assert(
                job.postStatus === 'PENDING',
                'INCONSISTENT',
                'Пост отсутствует при завершённой отправке',
              );
              const result = await session.publish(
                g.text,
                () => barrier('postStatus'),
                (at) => observedSubmit('post', at),
              );
              post = await this.db.transaction(async (tx) => {
                const sent = (await tx.get('publishJob', id))!;
                const confirmedAt = new Date(this.clock.now());
                const p = await tx.insert('post', {
                  ...base(),
                  jobId: id,
                  accountId: account.id,
                  generatedId: g.id,
                  url: result.url,
                  externalId: result.externalId,
                  publishedAt: sent.postSubmitAt ?? confirmedAt,
                });
                await tx.update('publishJob', id, {
                  postStatus: 'PUBLISHED',
                  postConfirmedAt: confirmedAt,
                  ctaScheduledAt: sent.ctaScheduledAt ?? new Date(p.publishedAt.getTime() + 20000),
                  commentNotBefore:
                    sent.ctaScheduledAt ?? new Date(p.publishedAt.getTime() + 20000),
                  updatedAt: new Date(),
                });
                await tx.update('account', account.id, { lastPublishedAt: p.publishedAt });
                if (sent.ctaEnabled)
                  await createCtaTask(
                    tx,
                    {
                      ...sent,
                      postStatus: 'PUBLISHED',
                      ctaScheduledAt:
                        sent.ctaScheduledAt ?? new Date(p.publishedAt.getTime() + 20000),
                    },
                    p,
                  );
                const source = await tx.get('source', g.sourceId);
                await tx.insert('contentPerformance', {
                  ...base(),
                  postId: p.id,
                  sourceText: source?.text ?? '',
                  finalText: g.text,
                  ...contentFeatures(g.text, source ?? undefined),
                  templateId: g.templateId ?? null,
                  templateSnapshot: g.templateSnapshot ?? null,
                });
                await tx.insert('systemEvent', {
                  ...base(`publish-status-${id}-post`),
                  level: 'INFO',
                  code:
                    auto && (await this.autopilot!.settings(account.id, tx)).config.quiet
                      ? 'AUTOPILOT_ROUTINE'
                      : 'NOTIFICATION',
                  message: `Пост опубликован: ${p.url}\nВремя: ${p.publishedAt.toISOString()}\nCTA: ${job.ctaEnabled ? 'ожидает отправки через 20 секунд' : 'выключен'}\nЗадача ${id}`,
                });
                return p;
              });
            }
            const fresh = await this.db.get('publishJob', id);
            if (fresh?.ctaEnabled && fresh.commentStatus === 'PENDING')
              assert(job.ctaText?.trim(), 'CTA_REQUIRED', 'CTA не настроен');
            if (job.ctaText && fresh?.commentStatus === 'PENDING') {
              await createCtaTask(this.db, fresh, post);
              assert(
                Boolean(job.ctaMediaPath) === Boolean(job.ctaMediaSha256),
                'MEDIA_REQUIRED',
                'Неполное описание фотографии CTA',
              );
              if (job.ctaMediaPath) {
                const bytes = await readFile(job.ctaMediaPath);
                assert(
                  createHash('sha256').update(bytes).digest('hex') === job.ctaMediaSha256,
                  'MEDIA_CHANGED',
                  'Фотография CTA изменена',
                );
              }
              await this.checkCtaDelay(id);
              const commentText = renderCta(job.ctaText, job.ctaUrl);
              const result = await session.comment(
                post.url,
                commentText,
                () => barrier('commentStatus'),
                job.ctaMediaPath && job.ctaMediaSha256
                  ? { path: job.ctaMediaPath, sha256: job.ctaMediaSha256 }
                  : undefined,
                (at) => observedSubmit('cta', at),
              );
              await this.db.transaction(async (tx) => {
                const prior = (await tx.list('comment', { postId: post!.id }))[0];
                if (!prior)
                  await tx.insert('comment', {
                    ...base(),
                    postId: post!.id,
                    text: commentText,
                    url: result.url,
                    status: 'PUBLISHED',
                  });
                await tx.update('publishJob', id, {
                  commentStatus: 'PUBLISHED',
                  ctaConfirmedAt: new Date(this.clock.now()),
                  updatedAt: new Date(),
                });
                await updateCtaTask(tx, id, {
                  status: 'PUBLISHED',
                  permalink: result.url,
                  confirmedAt: new Date(this.clock.now()).toISOString(),
                  reason: undefined,
                });
                await tx.insert('systemEvent', {
                  ...base(`publish-status-${id}-cta`),
                  level: 'INFO',
                  code:
                    auto && (await this.autopilot!.settings(account.id, tx)).config.quiet
                      ? 'AUTOPILOT_ROUTINE'
                      : 'NOTIFICATION',
                  message: `CTA опубликован: ${result.url ?? post!.url}\nК посту: ${post!.url}\nВремя: ${new Date(this.clock.now()).toISOString()}\nЗадача ${id}`,
                });
              });
            }
            await this.db.update('publishJob', id, {
              status: 'COMPLETED',
              lastError: null,
              updatedAt: new Date(),
            });
          } catch (e) {
            if (session) await session.evidence(e).catch(() => {});
            if (claimed) await this.fail(id, account, e);
            await this.checkCtaDelay(id).catch(() => {});
          } finally {
            clearInterval(timer);
            clearInterval(delayTimer);
            await renewal;
            await delayCheck;
            signal.removeEventListener('abort', onAbort);
            if (session) {
              try {
                await session.close();
              } catch (e) {
                if (auto)
                  await this.autopilot?.failure(
                    account.id,
                    new AppError('BROWSER_CLOSE', 'Профиль не закрылся'),
                  );
                await this.event('BROWSER_CLOSE', messageOf(e));
              }
            }
          }
        }),
      );
    } catch (e) {
      if ((e as AppError).code === 'PROFILE_BUSY') {
        await this.db.transaction(async (tx) => {
          const j = await tx.get('publishJob', id);
          if (j?.status === 'QUEUED')
            await tx.update('publishJob', id, {
              delayReason: 'PROFILE_BUSY',
              updatedAt: new Date(),
            });
          await updateCtaTask(tx, id, {
            reason: 'Браузер временно занят',
            delayReason: 'PROFILE_BUSY',
          });
        });
        await this.checkCtaDelay(id);
      } else {
        if (initial.postStatus === 'PUBLISHED' && child) await this.fail(id, account, e);
        else await this.event('WORKER', messageOf(e));
      }
    }
  }
  private async checkCtaDelay(id: string) {
    const message = await this.db.transaction(async (tx) => {
      const job = await tx.get('publishJob', id);
      if (
        !job?.postSubmitAt ||
        !job.ctaEnabled ||
        job.ctaSubmitAt ||
        job.ctaDelayNotifiedAt ||
        ['PUBLISHED', 'DISABLED'].includes(job.commentStatus) ||
        this.clock.now() - job.postSubmitAt.getTime() <= 45000
      )
        return null;
      const seconds = Math.floor((this.clock.now() - job.postSubmitAt.getTime()) / 1000);
      const reason =
        job.postStatus !== 'PUBLISHED'
          ? 'Ожидание подтверждения поста'
          : job.delayReason === 'PROFILE_BUSY'
            ? 'Браузер временно занят'
            : 'Подготовка/проверка редактора или фотографии CTA';
      const text = `CTA задерживается: ${seconds} с после отправки поста (цель 20 с). ${reason}. Задача: ${id}`;
      await updateCtaTask(tx, id, { delayReason: reason });
      await tx.update('publishJob', id, { ctaDelayNotifiedAt: new Date(this.clock.now()) });
      await tx.insert('systemEvent', {
        ...base(),
        level: 'WARN',
        code: 'CTA_DELAY',
        message: text,
      });
      return text;
    });
    if (message) await this.notify(message).catch(() => {});
  }
  private async event(code: string, message: string, context = '') {
    await this.db.insert('systemEvent', { ...base(), level: 'ERROR', code, message });
    const descriptions: Record<string, string> = {
      AUTH_REQUIRED: 'Требуется ручной вход в Threads.',
      CHALLENGE: 'Обнаружена проверка личности. Пройдите её вручную.',
      RESTRICTED: 'Аккаунт ограничен платформой. Работа приостановлена.',
      UNCERTAIN:
        'Результат отправки неизвестен. Проверьте пост или комментарий вручную; автоматического повтора не будет.',
      BROWSER_CLOSE: 'Не удалось закрыть браузер. Проверьте профиль.',
      PROVIDER_NETWORK: 'Browser Local API недоступен. Проверьте запущенное приложение.',
    };
    await this.notify(
      `${context}${descriptions[code] ?? 'Техническая ошибка. Подробности сохранены в журнале системы.'}`,
    ).catch(() => {});
  }
  private async fail(id: string, account: Account, error: unknown) {
    const e = error instanceof AppError ? error : new AppError('WORKER_ERROR', messageOf(error));
    await this.db.transaction(async (tx) => {
      const j = await tx.get('publishJob', id);
      if (!j) return;
      const child = await getDocument<CtaTask>(tx, ctaKey(id));
      const postUncertain = j.postStatus === 'SENDING',
        commentUncertain =
          ['SENDING', 'UNCERTAIN'].includes(j.commentStatus) ||
          ['SENDING', 'UNCERTAIN'].includes(child?.status ?? '');
      const blocked = ['AUTH_REQUIRED', 'RESTRICTED', 'CHALLENGE'].includes(e.code);
      const ctaOnly = j.postStatus === 'PUBLISHED';
      const waiting =
        ctaOnly &&
        !commentUncertain &&
        ['PROFILE_BUSY', 'PROVIDER_NETWORK', 'PROVIDER_HTTP'].includes(e.code);
      const disabled = ctaOnly && e.code === 'CTA_DISABLED';
      const retry =
        !(await getDocument(tx, `manual-post-${id}`)) &&
        !(await getDocument(tx, `autopilot-grant-${id}`)) &&
        e.retryable &&
        j.attempts < 3 &&
        !postUncertain &&
        !commentUncertain &&
        j.postStatus !== 'PUBLISHED';
      await tx.update('publishJob', id, {
        status: ctaOnly
          ? waiting
            ? 'QUEUED'
            : 'COMPLETED'
          : postUncertain || commentUncertain
            ? 'NEEDS_REVIEW'
            : blocked || e.code === 'PAUSED'
              ? 'PAUSED'
              : retry
                ? 'QUEUED'
                : j.postStatus === 'PUBLISHED'
                  ? 'COMPLETED'
                  : 'FAILED',
        postStatus: postUncertain
          ? 'UNCERTAIN'
          : !retry && !blocked && e.code !== 'PAUSED' && j.postStatus === 'PENDING'
            ? 'FAILED'
            : j.postStatus,
        commentStatus: disabled
          ? 'DISABLED'
          : waiting
            ? 'PENDING'
            : commentUncertain
              ? 'UNCERTAIN'
              : j.postStatus === 'PUBLISHED' &&
                  j.commentStatus === 'PENDING' &&
                  !blocked &&
                  e.code !== 'PAUSED'
                ? 'COMMENT_FAILED'
                : j.commentStatus,
        lastError: `${e.code}: ${e.message}`,
        scheduledAt: retry ? new Date(Date.now() + 2 ** j.attempts * 60000) : j.scheduledAt,
        revision: j.revision + 1,
        updatedAt: new Date(),
      });
      if (ctaOnly)
        await updateCtaTask(tx, id, {
          status: disabled
            ? 'DISABLED'
            : commentUncertain
              ? 'UNCERTAIN'
              : waiting
                ? 'WAITING'
                : 'FAILED',
          reason: `${e.code}: ${e.message}`,
        });
      if (blocked)
        await tx.update('account', account.id, {
          status: e.code === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'RESTRICTED',
        });
    });
    if (await getDocument(this.db, `autopilot-grant-${id}`)) {
      const final = await this.db.get('publishJob', id);
      if (
        final?.postStatus !== 'PUBLISHED' ||
        ['AUTH_REQUIRED', 'RESTRICTED', 'CHALLENGE'].includes(e.code)
      )
        await this.autopilot?.failure(
          account.id,
          final?.postStatus === 'UNCERTAIN' || final?.commentStatus === 'UNCERTAIN'
            ? new AppError('UNCERTAIN', 'Неопределённая отправка')
            : e,
        );
    }
    await this.event(
      e.code,
      `${account.name}: ${e.message}`,
      `Аккаунт: ${account.name}\nЗадача: ${id}\n`,
    );
  }
  async recover() {
    for (const j of await this.db.list('publishJob', { status: 'RUNNING' })) {
      if (Date.now() - j.updatedAt.getTime() < 180000) continue;
      await this.db.transaction(async (tx) => {
        const current = await tx.get('publishJob', j.id);
        if (
          !current ||
          current.status !== 'RUNNING' ||
          Date.now() - current.updatedAt.getTime() < 180000
        )
          return;
        const a = await tx.get('account', current.accountId),
          lease = a ? await tx.get('lease', a.profileId) : null;
        if (lease && lease.expiresAt.getTime() > Date.now()) return;
        const uncertain = current.postStatus === 'SENDING' || current.commentStatus === 'SENDING';
        const ctaOnly =
          current.postStatus === 'PUBLISHED' && (await getDocument<CtaTask>(tx, ctaKey(j.id)));
        await tx.update('publishJob', j.id, {
          status: ctaOnly
            ? current.commentStatus === 'SENDING'
              ? 'COMPLETED'
              : 'QUEUED'
            : uncertain
              ? 'NEEDS_REVIEW'
              : (await getDocument(tx, `autopilot-grant-${j.id}`))
                ? 'FAILED'
                : current.attempts >= 3
                  ? 'FAILED'
                  : 'QUEUED',
          postStatus: current.postStatus === 'SENDING' ? 'UNCERTAIN' : current.postStatus,
          commentStatus: current.commentStatus === 'SENDING' ? 'UNCERTAIN' : current.commentStatus,
          revision: current.revision + 1,
          updatedAt: new Date(),
          lastError: uncertain
            ? 'Прервано после начала отправки. Требуется проверка.'
            : 'Восстановлено после остановки процесса',
        });
        if (ctaOnly)
          await updateCtaTask(tx, j.id, {
            status: current.commentStatus === 'SENDING' ? 'UNCERTAIN' : 'WAITING',
            reason:
              current.commentStatus === 'SENDING'
                ? 'Процесс прерван после submit CTA; автоматический повтор запрещён'
                : 'Восстановлено до submit CTA',
          });
      });
    }
    for (const job of await this.db.list('publishJob'))
      if (
        job.postSubmitAt &&
        !job.ctaSubmitAt &&
        !job.ctaDelayNotifiedAt &&
        job.status !== 'COMPLETED' &&
        job.status !== 'CANCELLED'
      )
        await this.checkCtaDelay(job.id);
  }
}
