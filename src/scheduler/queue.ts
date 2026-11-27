import type { AutopilotPolicy, AutoGrant } from '../autopilot/policy.js';
import { automationPaused } from '../policy/manual.js';
import { getDocument, putDocument } from '../db/documents.js';
import { ctaKey, updateCtaTask, type CtaTask } from '../cta/tasks.js';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Database } from '../db/database.js';
import type { PublishingWorker } from './worker.js';
export class QueueRuntime {
  private redis: Redis;
  private queue: Queue;
  private worker?: Worker;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  constructor(
    private db: Database,
    private executor: PublishingWorker,
    redisUrl: string,
    private concurrency: number,
    private consume = true,
    private queueName = 'publishing',
    private autopilot?: AutopilotPolicy,
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(this.queueName, { connection: this.redis });
  }
  private autonomousTick?: () => Promise<void>;
  setAutopilotTick(fn: () => Promise<void>) {
    this.autonomousTick = fn;
  }
  async start() {
    await this.queue.setGlobalConcurrency(this.concurrency);
    if (this.consume) {
      this.worker = new Worker(
        this.queueName,
        async (job) => this.executor.execute(job.data.id, job.data.revision),
        { connection: this.redis, concurrency: this.concurrency },
      );
      this.worker.on('error', (e) => console.error('Очередь:', e.message));
    }
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((e) => console.error('Планировщик:', e.message));
    }, 10000);
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.executor.recover();
      await putDocument(this.db, 'autopilot-scheduler-heartbeat', {
        at: new Date().toISOString(),
        consumer: this.consume,
      });
      if (this.consume) {
        try {
          await this.autonomousTick?.();
        } catch {
          console.error('Автопилот: ошибка диспетчера; ручная очередь продолжает работать');
        }
      }
      for (const job of await this.db.list('publishJob', { status: 'QUEUED' })) {
        // Only dispatch runnable jobs. PostgreSQL is the durable outbox; Redis may be rebuilt.
        if ((await this.db.get('setting', 'emergencyStop'))?.value === 'true') break;
        const manual = await getDocument(this.db, `manual-post-${job.id}`);
        const child = await getDocument<CtaTask>(this.db, ctaKey(job.id)),
          manualCta = !!child?.manualRequestedBy;
        const auto = await getDocument<AutoGrant>(this.db, `autopilot-grant-${job.id}`);
        if (auto && !manual && !manualCta) {
          if (auto.mode !== 'LIVE' || !this.autopilot) continue;
          if (job.scheduledAt.getTime() > Date.now()) continue;
          try {
            await this.autopilot.validate(
              job.id,
              'POST',
              this.db,
              Date.now(),
              job.postStatus === 'PUBLISHED',
            );
          } catch (e) {
            if (job.postStatus === 'PUBLISHED') {
              const disabled = (e as { code?: string }).code === 'CTA_DISABLED',
                reason = e instanceof Error ? e.message : 'Ошибка проверки CTA';
              await this.db.transaction(async (tx) => {
                await tx.update('publishJob', job.id, {
                  status: 'COMPLETED',
                  commentStatus: disabled ? 'DISABLED' : 'COMMENT_FAILED',
                  lastError: reason,
                });
                await updateCtaTask(tx, job.id, {
                  status: disabled
                    ? 'DISABLED'
                    : child?.status === 'UNCERTAIN'
                      ? 'UNCERTAIN'
                      : 'FAILED',
                  reason,
                });
              });
              continue;
            }
            await this.db.update('publishJob', job.id, {
              lastError:
                'AUTOPILOT_BLOCKED: ' + (e instanceof Error ? e.message : 'ошибка проверки'),
            });
            continue;
          }
        }
        if (!manual && !auto && !manualCta && (await automationPaused(this.db))) continue;
        if (
          !manual &&
          !auto &&
          !manualCta &&
          (await getDocument(this.db, 'publishing-policy-v112'))
        )
          continue; // automatic publishing remains unavailable in V1.12
        if ((await this.db.get('account', job.accountId))?.status !== 'ACTIVE') continue;
        const key = `publish-${job.id}-${job.revision}`;
        const existing = await this.queue.getJob(key);
        if (existing && ['completed', 'failed'].includes(await existing.getState()))
          await existing.remove();
        await this.queue.add(
          'publish',
          { id: job.id, revision: job.revision },
          {
            jobId: key,
            priority: manual ? 1 : 2,
            delay: Math.max(0, job.scheduledAt.getTime() - Date.now()),
            attempts: 1,
            removeOnComplete: { age: 86400 },
            removeOnFail: { age: 604800 },
          },
        );
      }
    } finally {
      this.ticking = false;
    }
  }
  async ping() {
    return this.redis.ping();
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
    await this.queue.close();
    await this.redis.quit();
  }
}
export class DemoRuntime {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  constructor(
    private db: Database,
    private worker: PublishingWorker,
  ) {}
  private autonomousTick?: () => Promise<void>;
  setAutopilotTick(fn: () => Promise<void>) {
    this.autonomousTick = fn;
  }
  async start() {
    await this.worker.recover();
    this.timer = setInterval(() => {
      void this.tick().catch((e) => console.error(e));
    }, 1000);
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.worker.recover();
      await this.autonomousTick?.();
      for (const j of await this.db.list('publishJob', { status: 'QUEUED' }))
        if (j.scheduledAt.getTime() <= Date.now()) await this.worker.execute(j.id, j.revision);
    } finally {
      this.ticking = false;
    }
  }
  async ping() {
    return 'DEMO';
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    while (this.ticking) await new Promise((r) => setTimeout(r, 20));
  }
}
