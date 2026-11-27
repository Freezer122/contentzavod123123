import { checkReply } from './reply-style.js';
import type { AutopilotPolicy, AutoGrant } from '../autopilot/policy.js';
import { assertNotEmergency } from '../policy/manual.js';
import type { ManualPolicy } from '../policy/manual.js';
import { executionOf, type EngagementManager, type EngagementJob } from './service.js';
import { ReplyPermissions, type OperatorPermission, type ReplyPermission } from './permissions.js';
import { getDocument, putDocument } from '../db/documents.js';
import { audit, base } from '../db/database.js';
import { assert, AppError } from '../core/errors.js';
import { withProfileLease } from '../scheduler/lease.js';
export class EngagementQueue {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private closing = false;
  private running: Promise<void> = Promise.resolve();
  readonly permissions: ReplyPermissions;
  constructor(
    private manager: EngagementManager,
    private liveAllowed = false,
    operator?: OperatorPermission,
    manual?: ManualPolicy,
    private autopilot?: AutopilotPolicy,
  ) {
    this.permissions = new ReplyPermissions(manager.db, operator, manual);
  }
  async recover() {
    await this.manager.migrateStates();
    for (const job of await this.manager.jobs())
      if (job.status === 'SENDING') {
        await putDocument(this.manager.db, `engagement-job-${job.id}`, {
          ...job,
          status: 'UNCERTAIN',
          executionStatus: 'UNCERTAIN',
          phase: 'UNCERTAIN',
          phaseAt: new Date().toISOString(),
          error: 'Процесс прервался после начала отправки. Нужна ручная сверка.',
        });
        await this.notify('Неопределённый результат взаимодействия: ' + job.id);
      }
  }
  private async notify(message: string) {
    await this.manager.db.insert('systemEvent', {
      ...base(),
      level: 'INFO',
      code: 'NOTIFICATION',
      message,
    });
  }
  async prepareSelected(id: string, actor: string) {
    const view = await this.manager.jobView(id);
    assert(
      /^\d+$/.test(view.job.actor),
      'APPROVAL_REQUIRED',
      'Нужно ручное одобрение Telegram-пользователя',
    );
    assert(
      view.job.kind === 'REPLY' && view.draft?.status === 'APPROVED',
      'APPROVAL_REQUIRED',
      'Сначала одобрите текущий текст',
    );
    await this.execute(id, true);
    const current = await this.manager.jobView(id);
    return this.permissions.issue(current.job, current.draft!, current.candidate, actor);
  }
  async publishSelected(permissionId: string, actor: string) {
    const permit = await this.permissions.get(permissionId);
    assert(permit.actor === actor, 'PERMISSION_ACTOR', 'Разрешение выдано другому пользователю');
    return this.execute(permit.jobId, false, { permissionId, actor });
  }
  async verifyResult(id: string) {
    return withProfileLease(this.manager.db, 'engagement-dispatch', async () => {
      const { job, draft, candidate } = await this.manager.jobView(id);
      assert(
        job.status === 'UNCERTAIN' || job.status === 'PUBLISHED',
        'VERIFY_ONLY',
        'Проверка результата доступна для UNCERTAIN или PUBLISHED',
      );
      if (job.status === 'PUBLISHED') return job;
      assert(
        draft && this.manager.port.verify,
        'VERIFY_UNAVAILABLE',
        'Read-only проверка недоступна',
      );
      const result = await this.manager.port.verify(job, draft, candidate);
      if (!result.url) return job;
      const updated = {
        ...job,
        status: 'PUBLISHED' as const,
        executionStatus: 'PUBLISHED' as const,
        phase: 'PUBLISHED' as const,
        phaseAt: new Date().toISOString(),
        url: result.url,
        confirmedAt: new Date().toISOString(),
        error: undefined,
      };
      const account = (await this.manager.db.get('account', job.accountId))!;
      const url = new URL(result.url);
      assert(
        url.protocol === 'https:' &&
          ['www.threads.com', 'threads.com'].includes(url.hostname) &&
          url.pathname.startsWith(`/@${account.username}/post/`),
        'UNCERTAIN',
        'Permalink не соответствует аккаунту',
      );
      await this.manager.db.transaction(async (tx) => {
        await putDocument(tx, `engagement-job-${id}`, updated);
        await putDocument(tx, `engagement-candidate-${job.accountId}-${candidate.id}`, {
          ...candidate,
          status: 'HANDLED',
        });
        await audit(tx, 'read-only-verification', 'ENGAGEMENT_VERIFIED', id, result.url!);
      });
      return updated;
    });
  }
  async execute(
    id: string,
    dryRun = true,
    authorization?:
      | { permissionId: string; actor: string; autopilot?: false }
      | { autopilot: true; actor: string; permissionId?: never },
  ) {
    return withProfileLease(this.manager.db, 'engagement-dispatch', async () => {
      const db = this.manager.db,
        job = await getDocument<EngagementJob>(db, `engagement-job-${id}`);
      assert(job, 'NOT_FOUND', 'Задача не найдена');
      if (!['QUEUED', 'PREVIEWED'].includes(job.status)) return job;
      assert(
        dryRun || authorization,
        'ONE_SHOT_REQUIRED',
        'Нужно отдельное одноразовое подтверждение; глобальный LIVE не разрешает эту очередь',
      );
      const auto = authorization?.autopilot === true;
      if (auto) {
        assert(this.autopilot, 'AUTOPILOT_SCOPE', 'Контроллер автопилота недоступен');
        const grant = await getDocument<AutoGrant>(db, `autopilot-grant-${id}`);
        assert(
          grant && grant.kind === 'REPLY' && grant.mode === (dryRun ? 'DRY_RUN' : 'LIVE'),
          'AUTOPILOT_SCOPE',
          'Неподходящее разрешение',
        );
        const state = await this.autopilot.assertWork(grant, db, Date.now(), dryRun);
        assert(
          authorization.actor === state.enabledBy && job.actor === authorization.actor,
          'OWNER_REQUIRED',
          'Другой автор разрешения',
        );
        if (!dryRun) await this.autopilot.validate(id, 'REPLY');
      }
      let permission: ReplyPermission | undefined;
      const config = await this.manager.settings(job.accountId);
      assert(
        config.enabled || authorization,
        'ENGAGEMENT_DISABLED',
        'Взаимодействия аккаунта отключены',
      );
      const candidate = await this.manager.candidate(job.accountId, job.candidateId);
      const draft = job.draftId ? await this.manager.draft(job.accountId, job.draftId) : null;
      if (job.kind === 'REPLY' && !(draft?.status === 'APPROVED' && draft.hash === job.hash)) {
        await putDocument(db, `engagement-job-${id}`, {
          ...job,
          status: 'FAILED',
          executionStatus: 'FAILED',
          error: 'Ответ изменён после одобрения',
        });
      }
      if (job.kind === 'REPLY')
        assert(
          draft?.status === 'APPROVED' && draft.hash === job.hash,
          'STALE_APPROVAL',
          'Ответ изменён после одобрения',
        );
      if (job.kind === 'LIKE') assert(config.likes, 'LIKES_DISABLED', 'Лайки отключены');
      if (!dryRun && !auto) {
        assert(
          job.kind === 'REPLY' && draft && authorization,
          'ONE_SHOT_REQUIRED',
          'Одноразовый путь разрешён только для выбранного ответа',
        );
        permission = await this.permissions.get(authorization.permissionId);
        assert(
          permission.state === 'CONFIRMED',
          'PERMISSION_USED',
          'Разрешение не подтверждено или уже использовано',
        );
        this.permissions.validate(permission, authorization.actor, job, draft, candidate);
        await this.permissions.checkPolicy(permission);
      }
      const check = async () => {
        await assertNotEmergency(db);
        if (auto) {
          const grant = await this.autopilot!.validate(id, 'REPLY');
          const currentCandidate = await this.manager.candidate(job.accountId, job.candidateId),
            voice = await this.manager.settings(job.accountId);
          assert(
            this.manager.assess(currentCandidate, voice).accepted &&
              currentCandidate.text === grant.sourceText &&
              !checkReply(draft!.text, currentCandidate.text, voice.replyLength, voice).length,
            'AUTOPILOT_CONTEXT_CHANGED',
            'Контекст, фильтры или стиль изменились; требуется новый просмотр',
          );
        }
        const currentConfig = await this.manager.settings(job.accountId);
        assert(
          currentConfig.enabled || permission?.manual || auto,
          'ENGAGEMENT_DISABLED',
          'Взаимодействия отключены',
        );
        assert(
          /^\d+$/.test(job.actor),
          'APPROVAL_REQUIRED',
          'Для реальной отправки требуется подтверждение Telegram-пользователя',
        );
        assert(
          permission || auto || (await db.get('setting', 'factoryPaused'))?.value !== 'true',
          'FACTORY_PAUSED',
          'Фабрика приостановлена',
        );
        assert(
          (await db.get('account', job.accountId))?.status === 'ACTIVE',
          'ACCOUNT_PAUSED',
          'Аккаунт приостановлен',
        );
        const own = (await db.list('publishJob')).some(
          (j) =>
            j.status === 'RUNNING' ||
            (!permission?.manual &&
              j.status === 'QUEUED' &&
              j.scheduledAt.getTime() <= Date.now() + 60000),
        );
        assert(!own, 'PUBLISH_PRIORITY', 'Сначала собственные посты и CTA');
        const active = (await this.manager.jobs(job.accountId)).filter((j) =>
          ['SENDING', 'PUBLISHED', 'UNCERTAIN'].includes(j.status),
        );
        assert(
          !active.some(
            (j) => j.id !== id && j.kind === job.kind && j.candidateId === job.candidateId,
          ),
          'DUPLICATE_REPLY',
          'Есть отправленное или неопределённое взаимодействие',
        );
        const today = new Date().toISOString().slice(0, 10),
          daily = active.filter(
            (j) => (j.submittedAt ?? j.scheduledAt).startsWith(today) && j.kind === job.kind,
          );
        assert(
          auto ||
            daily.length <
              (job.kind === 'REPLY' ? currentConfig.dailyReplies : currentConfig.dailyLikes),
          'DAILY_LIMIT',
          'Дневной лимит ответов',
        );
        const previous = active
          .filter((j) => j.id !== id && j.submittedAt)
          .sort((a, b) => a.submittedAt!.localeCompare(b.submittedAt!))
          .at(-1);
        assert(
          auto ||
            !previous ||
            Date.now() - Date.parse(previous.submittedAt!) >=
              currentConfig.minIntervalMinutes * 60000,
          'REPLY_INTERVAL',
          'Минимальный интервал ещё не прошёл',
        );
      };
      try {
        if (!dryRun) await check();
        const beforeSend = async () => {
          assert(!dryRun, 'DRY_RUN_ONLY', 'Барьер реальной отправки закрыт в DRY_RUN');
          await check();
          await db.transaction(async (tx) => {
            await assertNotEmergency(tx);
            if (auto) await this.autopilot!.validate(id, 'REPLY', tx);
            const current = await getDocument<EngagementJob>(tx, `engagement-job-${id}`);
            assert(
              current && ['QUEUED', 'PREVIEWED'].includes(current.status),
              'DUPLICATE_SEND',
              'Повторная отправка запрещена',
            );
            if (draft) {
              const currentDraft = await getDocument<typeof draft>(
                tx,
                `engagement-draft-${job.accountId}-${draft.id}`,
              );
              assert(
                currentDraft?.status === 'APPROVED' && currentDraft.hash === job.hash,
                'STALE_APPROVAL',
                'Одобрение изменилось',
              );
            }
            if (permission && authorization && !authorization.autopilot) {
              const p = await this.permissions.get(permission.id, tx);
              const d = (await getDocument<typeof draft>(
                tx,
                `engagement-draft-${job.accountId}-${job.draftId}`,
              ))!;
              const c = await getDocument<typeof candidate>(
                tx,
                `engagement-candidate-${job.accountId}-${job.candidateId}`,
              );
              assert(
                p.state === 'CONFIRMED' && c,
                'PERMISSION_USED',
                'Одноразовое разрешение уже использовано',
              );
              this.permissions.validate(p, authorization.actor, current!, d, c);
              await this.permissions.checkPolicy(p, tx);
              assert(
                (await tx.get('account', job.accountId))?.status === 'ACTIVE',
                'ACCOUNT_PAUSED',
                'Аккаунт приостановлен',
              );
              await putDocument(tx, `reply-permission-${p.id}`, {
                ...p,
                state: 'CONSUMED',
                consumedAt: new Date().toISOString(),
              });
            }
            await putDocument(tx, `engagement-job-${id}`, {
              ...current,
              status: 'SENDING',
              phase: 'SENDING',
              phaseAt: new Date().toISOString(),
              executionStatus: 'PUBLISHING',
              ...(permission ? { permissionId: permission.id } : {}),
              submittedAt: new Date().toISOString(),
            });
            await audit(tx, job.actor, 'ENGAGEMENT_SEND_STARTED', id, job.hash);
          });
        };
        const progress = async (phase: NonNullable<EngagementJob['phase']>) => {
          await db.transaction(async (tx) => {
            const current = (await getDocument<EngagementJob>(tx, `engagement-job-${id}`))!;
            await putDocument(tx, `engagement-job-${id}`, {
              ...current,
              phase,
              phaseAt: new Date().toISOString(),
              ...(phase === 'VERIFYING' ? { clickCompletedAt: new Date().toISOString() } : {}),
            });
            await audit(tx, job.actor, 'ENGAGEMENT_' + phase, id);
          });
        };
        let url: string | null = null;
        if (job.kind === 'REPLY')
          url = (
            await this.manager.port.reply(job, draft!, candidate, !dryRun, beforeSend, progress)
          ).url;
        else await this.manager.port.like(job, candidate, !dryRun, beforeSend);
        assert(dryRun || job.kind === 'LIKE' || url, 'UNCERTAIN', 'URL ответа не подтверждён');
        if (!dryRun && url) {
          const u = new URL(url),
            a = (await db.get('account', job.accountId))!;
          assert(
            u.protocol === 'https:' &&
              ['www.threads.com', 'threads.com'].includes(u.hostname) &&
              u.pathname.startsWith(`/@${a.username}/post/`),
            'UNCERTAIN',
            'Permalink не соответствует аккаунту',
          );
        }
        const current = (await getDocument<EngagementJob>(db, `engagement-job-${id}`))!;
        const result: EngagementJob = {
          ...current,
          status: dryRun ? current.status : 'PUBLISHED',
          phase: dryRun ? 'QUEUED' : 'PUBLISHED',
          phaseAt: new Date().toISOString(),
          approvalStatus: draft?.status ?? 'APPROVED',
          executionStatus: dryRun ? 'WAITING' : 'PUBLISHED',
          ...(dryRun ? { dryRunAt: new Date().toISOString(), dryRunHash: job.hash } : {}),
          ...(url ? { url } : {}),
          ...(!dryRun ? { confirmedAt: new Date().toISOString() } : {}),
        };
        await db.transaction(async (tx) => {
          await putDocument(tx, `engagement-job-${id}`, result);
          if (!dryRun && job.kind === 'REPLY')
            await putDocument(tx, `engagement-candidate-${job.accountId}-${candidate.id}`, {
              ...candidate,
              status: 'HANDLED',
            });
          await audit(tx, job.actor, dryRun ? 'ENGAGEMENT_DRY_RUN' : 'ENGAGEMENT_PUBLISHED', id);
        });
        return dryRun ? { ...result, status: 'PREVIEWED' as const } : result;
      } catch (e) {
        const current = (await getDocument<EngagementJob>(db, `engagement-job-${id}`))!;
        if (
          auto &&
          !dryRun &&
          current.status === 'QUEUED' &&
          !current.submittedAt &&
          e instanceof AppError &&
          ['PROFILE_BUSY', 'PUBLISH_PRIORITY', 'AUTOPILOT_INTERVAL', 'NOT_DUE'].includes(e.code)
        ) {
          return putDocument<EngagementJob>(db, `engagement-job-${id}`, {
            ...current,
            phase: 'QUEUED',
            executionStatus: 'WAITING',
            error: 'WAITING: ' + e.message,
          });
        }
        const uncertain =
          current.status === 'SENDING' || (e instanceof AppError && e.code === 'UNCERTAIN');
        // main.ts installs environment-secret redaction before any queue starts.
        // Keep the original stack in the protected technical log for diagnosis.
        console.error('Engagement execution failed', id, e);
        await putDocument(db, `engagement-job-${id}`, {
          ...current,
          status: uncertain ? 'UNCERTAIN' : dryRun ? current.status : 'FAILED',
          phase: uncertain ? 'UNCERTAIN' : dryRun ? 'QUEUED' : 'FAILED',
          phaseAt: new Date().toISOString(),
          executionStatus: uncertain ? 'UNCERTAIN' : dryRun ? 'WAITING' : 'FAILED',
          error: e instanceof AppError ? e.message : 'Ошибка взаимодействия',
        });
        if (auto)
          await this.autopilot!.failure(
            job.accountId,
            uncertain ? new AppError('UNCERTAIN', 'Нужна сверка') : e,
          );
        await this.notify(`${uncertain ? 'Нужна ручная сверка' : 'Ошибка взаимодействия'}: ${id}`);
        throw e;
      }
    });
  }
  async tick() {
    if (this.busy || this.closing) return;
    this.busy = true;
    const state = async (reason: string) =>
      putDocument(this.manager.db, 'engagement-queue-state', {
        lastTickAt: new Date().toISOString(),
        reason,
      });
    try {
      if ((await this.manager.db.get('setting', 'factoryPaused'))?.value === 'true') {
        await state('Автопоиск остановлен: завод на паузе');
        return;
      }
      if (
        (await this.manager.db.list('publishJob')).some(
          (j) =>
            j.status === 'RUNNING' ||
            (j.status === 'QUEUED' && j.scheduledAt.getTime() <= Date.now() + 60000),
        )
      ) {
        await state('Приоритет собственных публикаций и CTA');
        return;
      }
      const job = (await this.manager.jobs())
        .filter((j) => j.status === 'QUEUED' && Date.parse(j.scheduledAt) <= Date.now())
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
      let reason = job
        ? 'Одобрение сохранено; автоматическая отправка выключена, нажмите «Опубликовать» для выбранного ответа'
        : 'Ожидание следующего поиска';
      for (const account of await this.manager.db.list('account', { status: 'ACTIVE' })) {
        const config = await this.manager.settings(account.id),
          schedule = await this.manager.schedule(account.id);
        if (
          !config.enabled ||
          !schedule.nextSearchAt ||
          Date.parse(schedule.nextSearchAt) > Date.now()
        )
          continue;
        try {
          await this.manager.search(account.id, 'engagement-scheduler');
          reason = 'Поиск завершён; генерация ответов запускается отдельно';
          break;
        } catch (e) {
          reason = e instanceof AppError ? e.message : 'Ошибка фонового поиска';
          if (!(
            e instanceof AppError &&
            ['SEARCH_INTERVAL', 'SEARCH_LIMIT', 'PROFILE_BUSY', 'PUBLISH_PRIORITY'].includes(e.code)
          )) {
            const key = `engagement-alert-${account.id}`,
              previous = await getDocument<{ at: number }>(this.manager.db, key);
            if (!previous || Date.now() - previous.at > 15 * 60000) {
              await this.notify(`Engagement ${account.name}: ${reason}`);
              await putDocument(this.manager.db, key, { at: Date.now() });
            }
          }
        }
      }
      await state(reason);
    } finally {
      this.busy = false;
    }
  }
  async start() {
    await this.recover();
    for (const account of await this.manager.db.list('account'))
      await this.manager.schedule(account.id);
    this.timer = setInterval(() => {
      if (!this.busy)
        this.running = this.tick().catch(() =>
          console.error('Ошибка EngagementQueue; проверьте системные события'),
        );
    }, 60000);
    this.timer.unref();
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
