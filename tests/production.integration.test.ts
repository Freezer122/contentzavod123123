import { AutopilotPolicy } from '../src/autopilot/policy.js';
import { confirmSourceRights, sourceRights } from '../src/content/rights.js';
import { ManualPolicy } from '../src/policy/manual.js';
import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaDatabase } from '../src/db/database.js';
import { PublishingWorker } from '../src/scheduler/worker.js';
import { QueueRuntime } from '../src/scheduler/queue.js';
import { Scheduler } from '../src/scheduler/service.js';
import { seedStyles } from '../src/db/seed.js';
import { TemplateService } from '../src/content/templates.js';
import { GenerationQuality } from '../src/content/quality.js';
import { ContentEngine } from '../src/content/service.js';
import { testConfig } from './helpers.js';
import { fixture, fastClock } from './helpers.js';
import { createApplication } from '../src/app.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { CtaService } from '../src/cta/service.js';
import { ctaKey, type CtaTask } from '../src/cta/tasks.js';
const dbUrl = process.env.TEST_DATABASE_URL,
  redisUrl = process.env.TEST_REDIS_URL;
it.skipIf(!dbUrl || !redisUrl)(
  'PostgreSQL/Prisma + Redis/BullMQ: восстановление, отмена и отсутствие дублей',
  async () => {
    const schema = `cf_test_${randomBytes(8).toString('hex')}`,
      queueName = `test-${schema}`,
      pool = new Pool({ connectionString: dbUrl, max: 1 });
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    let db: PrismaDatabase | undefined, runtime: QueueRuntime | undefined;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`SET search_path TO "${schema}"`);
      await pool.query(
        await readFile('prisma/migrations/202611160001_initial/migration.sql', 'utf8'),
      );
      await pool.query(await readFile('prisma/migrations/202611170001_v11/migration.sql', 'utf8'));
      await pool.query(
        await readFile('prisma/migrations/202611180001_prelaunch/migration.sql', 'utf8'),
      );
      await pool.query(
        await readFile('prisma/migrations/202611190001_comment_media/migration.sql', 'utf8'),
      );
      await pool.query(
        await readFile('prisma/migrations/202611190002_hotfix_v15/migration.sql', 'utf8'),
      );
      await pool.query(
        await readFile('prisma/migrations/202611190003_utc_timestamps/migration.sql', 'utf8'),
      );
      await pool.query(
        await readFile('prisma/migrations/202611190004_v18_extensions/migration.sql', 'utf8'),
      );
      await pool.query(
        await readFile('prisma/migrations/202611200001_openai_usage/migration.sql', 'utf8'),
      );
      const url = new URL(dbUrl!);
      url.searchParams.set('schema', schema);
      db = PrismaDatabase.connect(url.href);
      // Reproduce competing scheduler/lease-style serializable transactions on
      // the isolated schema. No browser, publishing or model call is inside one.
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          db!.transaction(async (tx) => {
            const id = `concurrent-lease-${i}`;
            await tx.get('setting', id);
            await new Promise((resolve) => setTimeout(resolve, 25));
            await tx.insert('setting', { id, createdAt: new Date(), value: 'committed' });
          }),
        ),
      );
      expect(
        (await db.list('setting')).filter((x) => x.id.startsWith('concurrent-lease-')),
      ).toHaveLength(8);
      const stamp = new Date();
      await db.insert('setting', { id: 'clock-probe', createdAt: stamp, value: 'test' });
      expect((await db.get('setting', 'clock-probe'))!.createdAt.getTime()).toBe(stamp.getTime());
      expect(
        Number(
          (
            await pool.query(
              'SELECT extract(epoch from "createdAt") * 1000 AS ms FROM system_settings WHERE id=$1',
              ['clock-probe'],
            )
          ).rows[0].ms,
        ),
      ).toBe(stamp.getTime());
      await seedStyles(db);
      const f = await fixture();
      await db.insert('browserProfile', f.profile);
      await db.insert('account', f.account);
      await db.insert('source', f.source);
      await db.insert('generated', f.generated);
      const autoPolicy = new AutopilotPolicy(db, '1');
      expect((await autoPolicy.settings(f.account.id)).state).toBe('OFF');
      await autoPolicy.configure(f.account.id, { start: '09:00', end: '22:00', posts: 5 }, '1');
      expect((await new AutopilotPolicy(db, '1').settings(f.account.id)).config).toMatchObject({
        timezone: 'Europe/Moscow',
        posts: 5,
        start: '09:00',
        end: '22:00',
      });
      const templates = new TemplateService(db);
      await templates.seed();
      await templates.ensureOwnStyle(f.account.id);
      await templates.assign(f.account.id, 'template-simple-explanation', 'integration');
      let modelCalls = 0;
      const engine = new ContentEngine(db, testConfig(), {
          generate: async () => {
            modelCalls++;
            return { text: 'Сначала проверяю риск.', inputTokens: 88, outputTokens: 34 };
          },
        }),
        generated = await engine.generate(f.source.id, f.account.id);
      await engine.generate(f.source.id, f.account.id);
      expect(modelCalls).toBe(1);
      const feedback = await new GenerationQuality(db).rate(generated.id, 'GOOD', 'integration');
      expect(feedback).toMatchObject({
        inputTokens: 88,
        outputTokens: 34,
        templateId: 'template-simple-explanation',
        model: 'DEMO',
        aiRequestId: generated.aiRequestId,
      });
      const scheduler = new Scheduler(db);
      await new CtaService(db).update(
        f.account.id,
        'сохранённый CTA без обязательной ссылки',
        '',
        '1',
      );
      const [first, duplicate] = await Promise.all([
        scheduler.createBatch([generated.id], 'integration', 'MANUAL_APPROVAL', 'same-request'),
        scheduler.createBatch([generated.id], 'integration', 'MANUAL_APPROVAL', 'same-request'),
      ]);
      const job = first[0];
      expect(duplicate[0]!.id).toBe(job!.id);
      const [cancelled] = await scheduler.createBatch([generated.id], 'integration');
      await scheduler.cancel(cancelled!.id, 'integration');
      const worker = new PublishingWorker(db, f.providers, f.publisher, undefined, 1, fastClock());
      runtime = new QueueRuntime(db, worker, redisUrl!, 1, false, queueName);
      await runtime.start();
      await runtime.close();
      runtime = undefined;
      // Restart with the same PostgreSQL data and durable Redis queue.
      runtime = new QueueRuntime(db, worker, redisUrl!, 1, true, queueName);
      await runtime.start();
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && (await db.get('publishJob', job!.id))?.status !== 'COMPLETED')
        await new Promise((r) => setTimeout(r, 50));
      expect((await db.get('publishJob', job!.id))?.status).toBe('COMPLETED');
      expect((await db.get('publishJob', cancelled!.id))?.status).toBe('CANCELLED');
      await runtime.close();
      runtime = undefined;
      await worker.execute(job!.id);
      await worker.recover();
      expect(await db.list('post')).toHaveLength(1);
      expect(f.publisher.posts.size).toBe(1);
      expect(f.publisher.comments.size).toBe(1);
      expect(await getDocument<CtaTask>(db, ctaKey(job!.id))).toMatchObject({
        accountId: f.account.id,
        status: 'PUBLISHED',
        text: 'сохранённый CTA без обязательной ссылки',
      });
      const post = (await db.list('post'))[0]!;
      for (let i = 0; i < 2; i++)
        await db.insert('postMetric', {
          id: `sample-${i}`,
          createdAt: new Date(),
          postId: post.id,
          measuredAt: new Date(),
          targetHours: null,
          source: 'TEST',
          status: 'UNAVAILABLE',
          views: null,
          likes: null,
          replies: null,
          reposts: null,
          quotes: null,
        });
      expect(await db.list('postMetric')).toHaveLength(2);
      expect((await db.get('publishJob', job!.id))?.scheduledAt).toBeInstanceOf(Date);
      // Telegram FSM/source persistence uses real PostgreSQL, but mocked Telegram/LLM/browser.
      const botApp = await createApplication(testConfig(), db);
      const send = async (app: typeof botApp, payload: object) =>
        (
          await app.server!.inject({
            method: 'POST',
            url: '/api/demo/telegram',
            headers: { authorization: 'Bearer demo-local-token' },
            payload,
          })
        ).json();
      await send(botApp, { callback: 'publication:ACCOUNT_SPECIFIC' });
      await send(botApp, { callback: `assign:${f.account.id}` });
      const longRussian = 'план торговли помогает заранее определить риск\\n\\n'.repeat(60);
      const saved = await send(botApp, { text: longRussian });
      expect(JSON.stringify(saved)).toContain('Исходник сохранён');
      const flow = (await getDocument<any>(db, 'flow-1'))!;
      expect((await db.get('source', flow.assignments[f.account.id]))?.text).toBe(
        longRussian.trim(),
      );
      await botApp.services.engagement.configure(f.account.id, { enabled: true }, '1');
      await putDocument(db, `engagement-candidate-${f.account.id}-native-reply`, {
        id: 'native-reply',
        accountId: f.account.id,
        url: 'https://www.threads.com/@other/post/native',
        author: 'other',
        text: 'трейдинг и риск',
        status: 'NEW',
      });
      const reply = await botApp.services.engagement.edit(
        f.account.id,
        'native-reply',
        'риск лучше определить до сделки',
        '1',
      );
      const replyJob = await botApp.services.engagement.approve(
        f.account.id,
        reply.id,
        reply.hash,
        '1',
      );
      const permission = await botApp.services.engagementQueue.prepareSelected(replyJob.id, '1');
      await expect(
        botApp.services.engagementQueue.permissions.confirm(permission.id, '1'),
      ).rejects.toMatchObject({ code: 'OPERATOR_PERMISSION_REQUIRED' });
      const manual = new ManualPolicy(db, ['1'], '1', true);
      await manual.session('1');
      await manual.setEnabled(f.account.id, '1', true);
      await confirmSourceRights(db, f.source.id, 'OWN', '1');
      await botApp.services.engagement.configure(
        f.account.id,
        {
          maxAgeHours: 72,
          viewLimit: 40,
          replyManner: 'HARSH',
          replyProfanity: false,
          replyHumor: false,
          replySlang: true,
        },
        '1',
      );
      const human = await botApp.services.quality.saveHuman(
        {
          source: 'шортистов побрили на отскоке',
          answer: 'ща лонгусты подтянутся',
          accountIds: [f.account.id],
          manner: 'HARSH',
        },
        '1',
      );
      await botApp.services.quality.rateReply(reply.id, 'GOOD', '1');
      await botApp.close();
      const restartedDb = PrismaDatabase.connect(url.href);
      const restartedApp = await createApplication(testConfig(), restartedDb);
      try {
        expect(await getDocument<CtaTask>(restartedDb, ctaKey(job!.id))).toMatchObject({
          status: 'PUBLISHED',
          parentPostId: post.id,
          parentPermalink: post.url,
        });
        expect((await new ManualPolicy(restartedDb).settings(f.account.id)).manualLiveEnabled).toBe(
          true,
        );
        expect((await new ManualPolicy(restartedDb).settings(f.account.id)).automaticEnabled).toBe(
          false,
        );
        expect(await sourceRights(restartedDb, f.source.id)).toMatchObject({
          sourceType: 'OWN',
          rightsStatus: 'CONFIRMED',
          confirmedBy: '1',
        });
        expect((await restartedApp.services.engagement.settings(f.account.id)).maxAgeHours).toBe(
          72,
        );
        expect(await restartedApp.services.engagement.settings(f.account.id)).toMatchObject({
          replyManner: 'HARSH',
          replyProfanity: false,
          replyHumor: false,
          replySlang: true,
        });
        expect(await restartedApp.services.quality.humanExample(human.id)).toMatchObject({
          source: human.source,
          answer: human.answer,
          origin: 'HUMAN',
          accountIds: [f.account.id],
        });
        expect(
          await getDocument<any>(restartedDb, `quality-reply-rating-${reply.id}-1`),
        ).toMatchObject({ rating: 'GOOD', origin: 'REPLY_RATING' });
        await send(restartedApp, { text: '/start' });
        expect((await getDocument<any>(restartedDb, 'flow-1')).assignments[f.account.id]).toBe(
          flow.assignments[f.account.id],
        );
        expect((await restartedDb.get('source', flow.assignments[f.account.id]))?.text).toBe(
          longRussian.trim(),
        );
        const replyState = await restartedApp.services.engagement.jobView(replyJob.id);
        expect(replyState.approvalStatus).toBe('APPROVED');
        expect(replyState.executionStatus).toBe('WAITING');
        expect(
          (await restartedApp.services.engagementQueue.permissions.get(permission.id)).state,
        ).toBe('PENDING');
      } finally {
        await restartedApp.close();
      }
    } finally {
      await runtime?.close();
      await db?.close();
      const q = new Queue(queueName, { connection });
      await q.obliterate({ force: true });
      await q.close();
      await connection.quit();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  },
  30000,
);
