import type { Database } from '../db/database.js';
import { getDocument, putDocument, listDocuments, hashDocument } from '../db/documents.js';
import { base, audit } from '../db/database.js';
import { freshness } from '../engagement/freshness.js';
import { GenerationQuality } from './quality.js';
import { withProfileLease } from '../scheduler/lease.js';
import { AppError, assert } from '../core/errors.js';
import type { ContentEngine, Preparation } from './service.js';
import type { EngagementManager } from '../engagement/service.js';
import type { EngagementQueue } from '../engagement/queue.js';

export interface GenerationTask {
  id: string;
  actor: string;
  chatId: number;
  kind:
    | 'POST'
    | 'REPLY'
    | 'SEARCH'
    | 'REPLY_CHECK'
    | 'REPLY_DRY'
    | 'REPLY_SEND'
    | 'REPLY_VERIFY'
    | 'MODEL_AB'
    | 'AUTOPILOT'
    | 'AUTOPILOT_SEND_REPLY';
  autoWorkId?: string;
  experimentId?: string;
  replyJobId?: string;
  permissionId?: string;
  metrics?: {
    viewed?: number;
    fresh?: number;
    thematic?: number;
    found: number;
    added: number;
    eligible: number;
    drafts: number;
  };
  preparation?: Preparation;
  accountId?: string;
  candidateId?: string;
  force?: boolean;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'NEEDS_EDIT' | 'FAILED' | 'UNKNOWN' | 'NEEDS_REVIEW';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  results?: string[];
  error?: string;
  deliveredAt?: string;
  deliveryAttempts?: number;
  deliveryError?: string;
  deliveryRetryAt?: string;
  deliveryMessageIds?: Record<string, number>;
  errorCode?: string;
}
export class GenerationQueue {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private closing = false;
  private busy = false;
  private autonomous?: (workId: string, send: boolean) => Promise<unknown>;
  setAutopilot(handler: (workId: string, send: boolean) => Promise<unknown>) {
    this.autonomous = handler;
  }
  constructor(
    private db: Database,
    private content: ContentEngine,
    private engagement: EngagementManager,
    private execution?: EngagementQueue,
  ) {}
  list() {
    return listDocuments<GenerationTask>(this.db, 'generation-task-');
  }
  async enqueue(input: Omit<GenerationTask, 'id' | 'status' | 'createdAt'>, nonce = '') {
    const id = hashDocument({ input, nonce }).slice(0, 32);
    return this.db.transaction(async (tx) => {
      if (input.kind === 'REPLY') {
        const active = (await listDocuments<GenerationTask>(tx, 'generation-task-')).find(
          (t) =>
            t.kind === 'REPLY' &&
            t.accountId === input.accountId &&
            t.candidateId === input.candidateId &&
            ['QUEUED', 'RUNNING'].includes(t.status),
        );
        if (active) return active;
      }
      if (input.kind === 'REPLY' && !input.force) {
        const existing = (await listDocuments<GenerationTask>(tx, 'generation-task-')).find(
          (t) =>
            t.kind === 'REPLY' &&
            !t.force &&
            t.accountId === input.accountId &&
            t.candidateId === input.candidateId,
        );
        if (existing) return existing;
      }
      const old = await getDocument<GenerationTask>(tx, `generation-task-${id}`);
      if (old) return old;
      const task: GenerationTask = {
        ...input,
        id,
        status: 'QUEUED',
        createdAt: new Date().toISOString(),
      };
      await audit(
        tx,
        input.actor,
        'ENQUEUE_GENERATION',
        id,
        JSON.stringify({
          kind: input.kind,
          accountId: input.accountId,
          candidateId: input.candidateId,
        }),
      );
      return putDocument(tx, `generation-task-${id}`, task);
    });
  }
  async replySelection(accountId: string, actor: string, chatId: number) {
    return withProfileLease(this.db, `reply-selection-${accountId}`, async () => {
      const config = await this.engagement.settings(accountId),
        rows = await this.engagement.candidates(accountId),
        drafts = await this.engagement.drafts(accountId),
        allTasks = await this.list();
      const counts = {
        found: rows.length,
        eligible: 0,
        alreadyDrafted: 0,
        processing: 0,
        thematic: 0,
        freshness: 0,
        skipped: 0,
        blocked: 0,
        created: 0,
        remaining: 0,
      };
      const tasks: GenerationTask[] = [],
        reasons: string[] = [],
        available: typeof rows = [];
      for (const c of rows) {
        if (!['NEW', 'DRAFTED'].includes(c.status)) {
          counts.skipped++;
          continue;
        }
        if (!freshness(c, config.maxAgeHours).accepted) {
          counts.freshness++;
          continue;
        }
        if (!this.engagement.assess(c, config).accepted) {
          counts.thematic++;
          continue;
        }
        counts.eligible++;
        const pending = allTasks.find(
          (t) =>
            t.kind === 'REPLY' &&
            t.accountId === accountId &&
            t.candidateId === c.id &&
            ['QUEUED', 'RUNNING'].includes(t.status),
        );
        if (pending) {
          counts.processing++;
          tasks.push(pending);
          continue;
        }
        if (drafts.some((d) => d.candidateId === c.id && d.status !== 'REJECTED')) {
          counts.alreadyDrafted++;
          continue;
        }
        const old = allTasks.find(
          (t) =>
            t.kind === 'REPLY' && t.accountId === accountId && t.candidateId === c.id && !t.force,
        );
        if (old) {
          counts.blocked++;
          reasons.push(
            'Есть завершённая/неопределённая задача: проверьте её статус, платного повтора нет',
          );
          continue;
        }
        available.push(c);
      }
      const limit = Math.min(3, config.dailyReplies),
        ready = available.length ? await this.content.readiness(accountId, 'REPLY') : null;
      if (ready && !ready.available) {
        counts.blocked += available.length;
        reasons.push(ready.reason);
      } else if (!limit && available.length) {
        counts.blocked += available.length;
        reasons.push('Лимит подготовки в текущей команде равен нулю');
      } else {
        for (const c of available.slice(0, limit)) {
          const task = await this.enqueue({
            kind: 'REPLY',
            accountId,
            candidateId: c.id,
            actor,
            chatId,
          });
          tasks.push(task);
          counts.created++;
        }
        counts.remaining = Math.max(0, available.length - limit);
      }
      if (!tasks.length && !reasons.length)
        reasons.push(
          counts.alreadyDrafted
            ? 'Все доступные кандидаты уже имеют черновики'
            : 'Новых подходящих кандидатов нет: проверьте свежесть и тематические причины',
        );
      const result = {
        counts,
        tasks,
        reasons: [...new Set(reasons)],
        at: new Date().toISOString(),
      };
      await putDocument(this.db, `reply-selection-${accountId}-${actor}`, result);
      await audit(
        this.db,
        actor,
        'REPLY_SELECTION',
        accountId,
        JSON.stringify({ counts, reasons: result.reasons }),
      );
      return result;
    });
  }
  async recover() {
    for (const task of await this.list())
      if (task.status === 'RUNNING') {
        if (task.kind === 'AUTOPILOT' || task.kind === 'AUTOPILOT_SEND_REPLY') {
          await putDocument(this.db, `generation-task-${task.id}`, { ...task, status: 'QUEUED' });
          continue;
        }
        if (task.kind === 'MODEL_AB') {
          await putDocument(this.db, `generation-task-${task.id}`, { ...task, status: 'QUEUED' });
          continue;
        }
        if (task.kind === 'REPLY') {
          try {
            const d = await this.engagement.generate(
              task.accountId!,
              task.candidateId!,
              task.actor,
              { recoverOnly: true, ...(task.force ? { force: true, nonce: task.id } : {}) },
            );
            await putDocument(this.db, `generation-task-${task.id}`, {
              ...task,
              status: d.generationState === 'READY' ? 'COMPLETED' : 'NEEDS_EDIT',
              results: [d.id],
              finishedAt: new Date().toISOString(),
            });
            continue;
          } catch (e) {
            if (e instanceof AppError && e.code === 'AI_UNCERTAIN') {
              await putDocument(this.db, `generation-task-${task.id}`, {
                ...task,
                status: 'UNKNOWN',
                error: e.message,
                errorCode: e.code,
                finishedAt: new Date().toISOString(),
              });
              continue;
            }
          }
        }
        await putDocument(this.db, `generation-task-${task.id}`, {
          ...task,
          status: 'NEEDS_REVIEW',
          error:
            task.kind === 'REPLY_SEND'
              ? 'Отправка прервалась. Проверяю сохранённый статус; повторной отправки нет'
              : 'Процесс прервался во время генерации. Автоматического платного повтора нет; требуется сверка сохранённого ответа.',
        });
      }
  }
  async tick() {
    if (this.busy || this.closing) return;
    this.busy = true;
    try {
      if (!(await this.list()).some((t) => t.status === 'QUEUED')) return;
      await withProfileLease(this.db, 'generation-dispatch', async () => {
        const task = (await this.list())
          .filter((t) => t.status === 'QUEUED')
          .sort(
            (a, b) =>
              (a.kind === 'REPLY_SEND' ? -1 : 0) - (b.kind === 'REPLY_SEND' ? -1 : 0) ||
              (a.kind.startsWith('AUTOPILOT') ? 1 : 0) - (b.kind.startsWith('AUTOPILOT') ? 1 : 0) ||
              (a.kind === 'MODEL_AB' ? 1 : 0) - (b.kind === 'MODEL_AB' ? 1 : 0) ||
              a.createdAt.localeCompare(b.createdAt),
          )[0];
        if (!task) return;
        const running: GenerationTask = {
          ...task,
          status: 'RUNNING',
          startedAt:
            task.kind === 'MODEL_AB'
              ? (task.startedAt ?? new Date().toISOString())
              : new Date().toISOString(),
        };
        await putDocument(this.db, `generation-task-${task.id}`, running);
        try {
          if (task.kind === 'AUTOPILOT' || task.kind === 'AUTOPILOT_SEND_REPLY') {
            assert(
              this.autonomous && task.autoWorkId,
              'NOT_CONFIGURED',
              'Исполнитель автопилота недоступен',
            );
            const result: any = await this.autonomous(
              task.autoWorkId,
              task.kind === 'AUTOPILOT_SEND_REPLY',
            );
            await putDocument(this.db, `generation-task-${task.id}`, {
              ...running,
              status:
                result?.status === 'QUEUED'
                  ? 'QUEUED'
                  : result?.status === 'ERROR'
                    ? 'FAILED'
                    : result?.status === 'NEEDS_REVIEW'
                      ? 'NEEDS_REVIEW'
                      : 'COMPLETED',
              results: [task.autoWorkId],
              error: result?.error,
              finishedAt: new Date().toISOString(),
            });
            return;
          }
          if (task.kind === 'MODEL_AB') {
            const gate = await getDocument<{ passed: boolean }>(
              this.db,
              'v115-generation-hotfix-verified',
            );
            assert(
              gate?.passed && task.experimentId,
              'HOTFIX_FIRST',
              'A/B разрешён только после приёмки исправления генерации',
            );
            const e = await new GenerationQuality(this.db).experimentStep(
              task.experimentId,
              this.content,
            );
            await putDocument(this.db, `generation-task-${task.id}`, {
              ...running,
              status:
                e.status === 'READY' ? 'COMPLETED' : e.status === 'STOPPED' ? 'FAILED' : 'QUEUED',
              results: [e.id],
              error: e.error,
              ...(['READY', 'STOPPED'].includes(e.status)
                ? { finishedAt: new Date().toISOString() }
                : {}),
            });
            return;
          }
          if (['REPLY_CHECK', 'REPLY_DRY', 'REPLY_SEND', 'REPLY_VERIFY'].includes(task.kind)) {
            assert(
              this.execution && task.replyJobId,
              'NOT_CONFIGURED',
              'Исполнитель ответов не настроен',
            );
            let permissionId = task.permissionId;
            if (task.kind === 'REPLY_CHECK')
              permissionId = (await this.execution.prepareSelected(task.replyJobId, task.actor)).id;
            else if (task.kind === 'REPLY_DRY') {
              const result = await this.execution.execute(task.replyJobId, true);
              assert(
                result.status === 'PREVIEWED' &&
                  result.dryRunAt &&
                  Date.parse(result.dryRunAt) >= Date.parse(running.startedAt!),
                'DRY_NOT_EXECUTED',
                'Проверка не выполнена: задание уже отклонено, отправлено или изменилось. Выберите актуальный ожидающий ответ',
              );
            } else if (task.kind === 'REPLY_VERIFY')
              await this.execution.verifyResult(task.replyJobId);
            else {
              assert(permissionId, 'PERMISSION_MISSING', 'Нет одноразового разрешения');
              const result = await this.execution.publishSelected(permissionId, task.actor);
              assert(
                result.status === 'PUBLISHED',
                'REPLY_NOT_CONFIRMED',
                result.status === 'UNCERTAIN'
                  ? 'Отправка могла выполниться, результат требует проверки'
                  : (result.error ?? 'Ответ не отправлен'),
              );
            }
            await putDocument(this.db, `generation-task-${task.id}`, {
              ...running,
              status: 'COMPLETED',
              permissionId,
              finishedAt: new Date().toISOString(),
            });
            return;
          }
          if (task.kind === 'SEARCH') {
            const metrics = await this.engagement.search(task.accountId!, task.actor, {
              manual: true,
            });
            await putDocument(this.db, `generation-task-${task.id}`, {
              ...running,
              status: 'COMPLETED',
              metrics,
              finishedAt: new Date().toISOString(),
            });
            return;
          }
          const targets =
            task.kind === 'REPLY'
              ? [task.accountId!]
              : (task.preparation?.mappings?.map((m) => m.accountId) ??
                task.preparation?.accountIds ??
                []);
          for (const id of task.kind === 'POST' ? targets : []) {
            const ready = await this.content.readiness(id, task.kind === 'POST' ? 'POST' : 'REPLY');
            assert(ready.available, 'LLM_UNAVAILABLE', ready.reason);
          }
          const results =
            task.kind === 'POST'
              ? (await this.content.prepare(task.preparation!, task.force)).map((g) => g.id)
              : [
                  (
                    await this.engagement.generate(
                      task.accountId!,
                      task.candidateId!,
                      task.actor,
                      task.force ? { force: true, nonce: task.id } : undefined,
                    )
                  ).id,
                ];
          await putDocument(this.db, `generation-task-${task.id}`, {
            ...running,
            status:
              task.kind === 'REPLY' &&
              (await this.engagement.draft(task.accountId!, results[0]!)).generationState !==
                'READY'
                ? 'NEEDS_EDIT'
                : 'COMPLETED',
            results,
            finishedAt: new Date().toISOString(),
          });
        } catch (e) {
          await putDocument(this.db, `generation-task-${task.id}`, {
            ...running,
            status:
              e instanceof AppError &&
              ['AI_UNCERTAIN', 'OPENAI_NETWORK', 'OPENAI_USAGE_UNKNOWN'].includes(e.code)
                ? 'UNKNOWN'
                : 'FAILED',
            errorCode: e instanceof AppError ? e.code : 'INTERNAL',
            error:
              e instanceof AppError
                ? e.message
                : 'Техническая ошибка подготовки. Исходник сохранён, автоматического повтора нет.',
            finishedAt: new Date().toISOString(),
          });
          await this.db.insert('systemEvent', {
            ...base(),
            level: 'ERROR',
            code: 'GENERATION_FAILED',
            message: JSON.stringify({
              taskId: task.id,
              code: e instanceof AppError ? e.code : 'INTERNAL',
              kind: task.kind,
            }),
          });
        }
      });
    } finally {
      this.busy = false;
    }
  }
  async deliver(send: (task: GenerationTask) => Promise<void>) {
    for (const task of (await this.list())
      .filter((t) => !['QUEUED', 'RUNNING'].includes(t.status) && !t.deliveredAt)
      .filter((t) => !t.deliveryRetryAt || Date.parse(t.deliveryRetryAt) <= Date.now())
      .slice(0, 5)) {
      try {
        await send(task);
      } catch (e) {
        const code = (e as any)?.error_code,
          attempts = (task.deliveryAttempts ?? 0) + 1;
        const description =
          e instanceof AppError
            ? `${e.code}: ${e.message}`
            : `Ошибка доставки Telegram${Number.isInteger(code) ? ' HTTP ' + code : ''}; результат сохранён`;
        await putDocument(this.db, `generation-task-${task.id}`, {
          ...task,
          deliveryAttempts: attempts,
          deliveryError: description,
          deliveryRetryAt: new Date(
            Date.now() +
              Math.max(
                Math.min(60000, 2000 * 2 ** Math.min(attempts, 5)),
                Number((e as any)?.parameters?.retry_after ?? 0) * 1000,
              ),
          ).toISOString(),
        });
        continue;
      }
      const current = await getDocument<GenerationTask>(this.db, `generation-task-${task.id}`);
      await putDocument(this.db, `generation-task-${task.id}`, {
        ...current!,
        deliveredAt: new Date().toISOString(),
        deliveryError: undefined,
        deliveryRetryAt: undefined,
      });
      await audit(
        this.db,
        task.actor,
        'GENERATION_DELIVERED',
        task.id,
        JSON.stringify({ messageIds: current?.deliveryMessageIds ?? {} }),
      );
    }
  }
  async start() {
    await this.recover();
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.running = this.tick().catch(() =>
        console.error('GenerationQueue: ошибка инфраструктуры; платного повтора нет'),
      );
    }, 2000);
    this.timer.unref();
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
