import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../core/config.js';
import type { BotServices } from '../bot/bot.js';
import { Api, type Bot } from 'grammy';
import { AppError, messageOf } from '../core/errors.js';
import { publicationTiming } from '../scheduler/timing.js';
const idParams = z.object({ id: z.string().min(1).max(100) });
const reportQuery = z.object({
  days: z.coerce.number().int().min(0).max(3650).default(7),
  accountId: z.string().optional(),
  mode: z.enum(['PUBLISHED_IN_PERIOD', 'VIEWS_IN_PERIOD']).default('PUBLISHED_IN_PERIOD'),
});
export async function buildServer(
  config: Config,
  s: BotServices,
  offline?: { bot: Bot; messages: unknown[] },
) {
  // Deliberately disable request logging: redirect requests carry visitor IP/UA.
  const app = Fastify({
    logger: false,
    bodyLimit: 65536,
    trustProxy: config.TRUST_PROXY ? config.TRUST_PROXY.split(',').map((x) => x.trim()) : false,
  });
  const buckets = new Map<string, { count: number; at: number }>();
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/health')) {
      const given = Buffer.from(req.headers.authorization ?? ''),
        expected = Buffer.from(`Bearer ${config.INTERNAL_API_TOKEN}`);
      if (given.length !== expected.length || !timingSafeEqual(given, expected))
        return reply.code(401).send({ error: 'Доступ запрещён' });
    }
    const now = Date.now();
    if (buckets.size > 5000)
      for (const [k, v] of buckets) if (now - v.at > 60000) buckets.delete(k);
    let bucket = buckets.get(req.ip);
    if (!bucket || now - bucket.at > 60000) {
      bucket = { count: 0, at: now };
      if (buckets.size >= 5000) buckets.delete(buckets.keys().next().value!);
      buckets.set(req.ip, bucket);
    }
    if (++bucket.count > 120) return reply.code(429).send({ error: 'Слишком много запросов' });
  });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as unknown;
    const code =
      e instanceof z.ZodError
        ? 400
        : e instanceof AppError
          ? e.code === 'NOT_FOUND'
            ? 404
            : 409
          : 500;
    reply.code(code).send({
      error: code === 500 ? 'Внутренняя ошибка' : messageOf(e),
      ...(e instanceof AppError ? { code: e.code } : {}),
    });
  });
  app.get('/live', async () => ({ status: 'ok', demo: config.APP_MODE === 'demo' }));
  app.get('/health', async (_req, reply) => {
    try {
      const m = await s.monitoring.snapshot();
      if (m.database === 'ERROR' || m.redis === 'ERROR') reply.code(503);
      return m;
    } catch {
      return reply.code(503).send({ status: 'degraded' });
    }
  });
  app.get('/r/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string().regex(/^[\w-]{5,64}$/) }).parse(req.params);
    const destination = await s.tracking.click(code, req.ip, req.headers['user-agent'] ?? '');
    return reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .redirect(destination, 302);
  });
  app.get('/api/accounts', async () => s.db.list('account'));
  app.post('/api/accounts', async (req) => s.accounts.add(req.body, 'api'));
  app.post('/api/accounts/:id/status', async (req) => {
    const { id } = idParams.parse(req.params);
    const { status } = z.object({ status: z.enum(['ACTIVE', 'PAUSED']) }).parse(req.body);
    return s.accounts.setStatus(id, status, 'api');
  });
  app.get('/api/templates', async () => s.templates.list());
  app.post('/api/templates', async (req) => {
    const b = z.object({ name: z.string(), instruction: z.string() }).parse(req.body);
    return s.templates.create(b.name, b.instruction, 'api');
  });
  app.patch('/api/templates/:id', async (req) =>
    s.templates.update(idParams.parse(req.params).id, req.body, 'api'),
  );
  app.post('/api/templates/:id/examples', async (req) =>
    s.templates.addExample(
      idParams.parse(req.params).id,
      z.object({ text: z.string() }).parse(req.body).text,
      'api',
    ),
  );
  app.get('/api/templates/:id/stats', async (req) => {
    const id = idParams.parse(req.params).id,
      q = z.object({ hours: z.coerce.number().default(24) }).parse(req.query);
    return (await s.performance.report(q.hours)).templateStats.find((t) => t.id === id) ?? null;
  });
  app.put('/api/accounts/:id/template', async (req) =>
    s.templates.assign(
      idParams.parse(req.params).id,
      z.object({ templateId: z.string().nullable() }).parse(req.body).templateId,
      'api',
    ),
  );
  app.post('/api/generations/:id/feedback', async (req) =>
    s.quality.rate(
      idParams.parse(req.params).id,
      z.object({ rating: z.enum(['GOOD', 'BAD']) }).parse(req.body).rating,
      'api',
    ),
  );
  app.get('/api/quality', async (req) =>
    s.quality.report(z.object({ accountId: z.string().optional() }).parse(req.query).accountId),
  );
  app.post('/api/diagnostics/browser', async (req) => {
    const b = z
      .object({
        scenario: z
          .enum([
            'OK',
            'PROFILE_START_ERROR',
            'CDP_ERROR',
            'TIMEOUT',
            'CONNECTION_LOST',
            'AUTH_REQUIRED',
            'PUBLISH_FAILED',
            'COMMENT_FAILED',
            'UNCERTAIN_POST',
            'UNCERTAIN_COMMENT',
          ])
          .default('OK'),
        profileId: z.string().min(1).max(100).default('Threads 02'),
      })
      .parse(req.body ?? {});
    return s.diagnostics.run(b.scenario, b.profileId);
  });
  app.put('/api/accounts/:id/cta/enabled', async (req) =>
    s.ctas.setEnabled(
      idParams.parse(req.params).id,
      z.object({ enabled: z.boolean() }).parse(req.body).enabled,
      'api',
    ),
  );
  app.get('/api/styles', async () => s.db.list('style'));
  app.post('/api/sources', async (req) => {
    const b = z
      .object({
        input: z.string(),
        rights: z.enum(['OWN', 'PERMITTED', 'REVIEW']).default('REVIEW'),
      })
      .parse(req.body);
    return s.library.add(b.input, b.rights);
  });
  app.get('/api/sources', async (req) =>
    s.library.search(z.object({ q: z.string().default('') }).parse(req.query).q),
  );
  app.post('/api/generate', async (req) => {
    const b = z.object({ sourceId: z.string(), accountId: z.string() }).parse(req.body);
    return s.content.generate(b.sourceId, b.accountId);
  });
  app.post('/api/prepare', async (req) => {
    const b = z
      .object({
        mode: z.enum(['ACCOUNT_SPECIFIC', 'BROADCAST']).default('ACCOUNT_SPECIFIC'),
        adaptation: z.enum(['COMMON', 'PER_ACCOUNT']).optional(),
        sourceId: z.string().optional(),
        accountIds: z.array(z.string()).min(1).max(100).optional(),
        mappings: z
          .array(z.object({ accountId: z.string(), sourceId: z.string() }))
          .min(1)
          .max(100)
          .optional(),
        force: z.boolean().default(false),
      })
      .parse(req.body);
    return s.content.prepare(b, b.force);
  });
  app.get('/api/accounts/:id/cta', async (req) => s.ctas.ensure(idParams.parse(req.params).id));
  app.put('/api/accounts/:id/cta', async (req) => {
    const { id } = idParams.parse(req.params),
      b = z
        .object({
          text: z.string().min(1).max(500),
          url: z.union([z.literal(''), z.string().url()]).default(''),
        })
        .parse(req.body);
    return s.ctas.update(id, b.text, b.url, 'api');
  });
  app.patch('/api/sources/:id/features', async (req) => {
    const b = z
      .object({
        topic: z.string().min(1).max(120).optional(),
        format: z.string().min(1).max(120).optional(),
        hook: z.string().min(1).max(120).optional(),
      })
      .strict()
      .parse(req.body);
    return s.performance.tagSource(idParams.parse(req.params).id, b, 'api');
  });
  app.get('/api/performance', async (req) => {
    const q = z
      .object({ hours: z.coerce.number().default(24), accountId: z.string().optional() })
      .parse(req.query);
    return s.performance.report(q.hours, q.accountId);
  });
  app.get('/api/retention', async (req) => {
    const q = reportQuery
      .extend({ days: z.coerce.number().int().min(0).max(3650).default(0) })
      .parse(req.query);
    return s.retention.report(
      new Date(q.days ? Date.now() - q.days * 86400000 : 0),
      new Date(),
      q.accountId,
    );
  });
  app.post('/api/drafts/:id/edit', async (req) => {
    const { id } = idParams.parse(req.params);
    return s.content.edit(id, z.object({ text: z.string() }).parse(req.body).text, 'api');
  });
  app.post('/api/batches', async (req) => {
    const b = z
      .object({
        generatedIds: z.array(z.string()).min(1).max(100),
        approval: z.enum(['MANUAL_APPROVAL', 'AUTO_APPROVED']).default('MANUAL_APPROVAL'),
        requestId: z.string().min(1).max(256),
        mode: z.enum(['ACCOUNT_SPECIFIC', 'BROADCAST']).default('ACCOUNT_SPECIFIC'),
        adaptation: z.enum(['COMMON', 'PER_ACCOUNT']).default('PER_ACCOUNT'),
      })
      .parse(req.body);
    return s.scheduler.createBatch(b.generatedIds, 'api', b.approval, b.requestId, {
      mode: b.mode,
      adaptation: b.adaptation,
    });
  });
  app.post('/api/drafts/:id/approve', async (req) => {
    const { id } = idParams.parse(req.params);
    const g = await s.db.get('generated', id);
    if (!g?.valid) throw new AppError('INVALID_DRAFT', 'Нет проверенного черновика');
    await s.db.insert('audit', {
      id: crypto.randomUUID(),
      createdAt: new Date(),
      actor: 'api',
      action: 'APPROVE_CONTENT',
      entityId: id,
      detail: '',
    });
    return s.db.update('generated', id, { approved: true });
  });
  app.post('/api/invites', async (req) => {
    if (config.APP_MODE === 'demo')
      throw new AppError('DEMO_ONLY', 'В демонстрации приглашения не создаются');
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHANNEL_ID)
      throw new AppError('TELEGRAM_REQUIRED', 'Нужны Telegram-бот и ID канала');
    const b = z
      .object({
        accountId: z.string(),
        postId: z.string().nullable().default(null),
        ctaId: z.string().nullable().default(null),
      })
      .parse(req.body);
    if (!(await s.db.get('account', b.accountId)))
      throw new AppError('NOT_FOUND', 'Аккаунт не найден');
    if (b.postId)
      throw new AppError('ACCOUNT_ATTRIBUTION_ONLY', 'Приглашение относится только к аккаунту');
    const result = await s.tracking.ensureInvite(
      b.accountId,
      config.TELEGRAM_CHANNEL_ID,
      async () =>
        (
          await new Api(config.TELEGRAM_BOT_TOKEN).createChatInviteLink(
            config.TELEGRAM_CHANNEL_ID,
            { name: `CF-${b.accountId.slice(-12)}` },
          )
        ).invite_link,
    );

    return { ...result, url: `${config.PUBLIC_BASE_URL}/r/${result.link.code}` };
  });
  app.get('/api/queue', async () =>
    (await s.db.list('publishJob')).map((job) => ({ ...job, ...publicationTiming(job) })),
  );
  app.post('/api/jobs/:id/cancel', async (req) =>
    s.scheduler.cancel(idParams.parse(req.params).id, 'api'),
  );
  app.post('/api/jobs/:id/reschedule', async (req) => {
    const { id } = idParams.parse(req.params),
      { scheduledAt } = z.object({ scheduledAt: z.string().datetime() }).parse(req.body);
    return s.scheduler.reschedule(id, new Date(scheduledAt), 'api');
  });
  app.post('/api/factory', async (req) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    await s.scheduler.pause(paused, 'api');
    return { paused };
  });
  app.post('/api/tracking', async (req) => {
    const b = z
      .object({
        accountId: z.string(),
        destination: z.string().url(),
        ctaId: z.string().nullable().default(null),
        postId: z.string().nullable().default(null),
      })
      .parse(req.body);
    const link = await s.tracking.create(b.accountId, b.destination, b.ctaId, b.postId);
    return { ...link, url: `${config.PUBLIC_BASE_URL}/r/${link.code}` };
  });
  const period = (query: unknown) => {
    const q = reportQuery.parse(query),
      until = new Date();
    return {
      since: new Date(q.days ? until.getTime() - q.days * 86400000 : 0),
      until,
      accountId: q.accountId,
      mode: q.mode,
    };
  };
  app.get('/api/analytics', async (req) => s.analytics.report(period(req.query)));
  app.get('/api/analytics/top', async (req) => s.analytics.ranking(period(req.query)));
  app.get('/api/analytics/bottom', async (req) => s.analytics.ranking(period(req.query), true));
  app.get('/api/analytics/dynamics', async (req) =>
    s.analytics.dynamics(reportQuery.parse(req.query).accountId),
  );
  app.get('/api/analytics/sources', async (req) => s.analytics.sourceRanking(period(req.query)));
  app.get('/api/analytics/styles', async (req) =>
    s.analytics.sourceRanking(period(req.query), 'styleId'),
  );
  app.get('/api/analytics.csv', async (req, reply) =>
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="content-factory.csv"')
      .send(await s.analytics.csv(period(req.query))),
  );
  if (offline && config.APP_MODE === 'demo')
    app.post('/api/demo/telegram', async (req) => {
      const b = z
        .object({ text: z.string().optional(), callback: z.string().optional() })
        .refine((x) => Boolean(x.text) !== Boolean(x.callback), 'Укажите текст или callback')
        .parse(req.body);
      const updateId = Math.floor(Date.now() / 1000),
        user = { id: 1, is_bot: false, first_name: 'Тестовый администратор' },
        chat = { id: 1, type: 'private' as const, first_name: 'Тестовый администратор' };
      offline.messages.length = 0;
      const message = {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat,
        from: user,
        text: b.text ?? '',
        ...(b.text?.startsWith('/')
          ? {
              entities: [
                { type: 'bot_command' as const, offset: 0, length: b.text.split(' ')[0]!.length },
              ],
            }
          : {}),
      };
      await offline.bot.handleUpdate(
        b.callback
          ? {
              update_id: updateId,
              callback_query: {
                id: String(updateId),
                chat_instance: 'demo',
                from: user,
                data: b.callback,
                message,
              },
            }
          : { update_id: updateId, message },
      );
      return { demo: true, messages: offline.messages };
    });
  return app;
}
export type Server = FastifyInstance;
