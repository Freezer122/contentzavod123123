import { AutopilotInsights } from './autopilot/insights.js';
import { AutopilotPolicy } from './autopilot/policy.js';
import { AutopilotService } from './autopilot/service.js';
import { ManualPolicy } from './policy/manual.js';
import type { Config } from './core/config.js';
import { GenerationQueue } from './content/jobs.js';
import { deliverGenerations } from './bot/generation.js';
import type { Database } from './db/database.js';
import { MemoryDatabase, PrismaDatabase, base } from './db/database.js';
import { TemplateService } from './content/templates.js';
import { GenerationQuality } from './content/quality.js';
import { BrowserDiagnostics } from './browser/diagnostics.js';
import { upgradeV11, upgradePrelaunch } from './db/upgrade.js';
import { CtaService } from './cta/service.js';
import { Retention, telegramMembershipChecker } from './tracking/retention.js';
import { PerformanceRating } from './analytics/performance.js';
import type { WorkerClock } from './scheduler/worker.js';
import { seedDemo } from './db/seed.js';
import { AdsPowerProvider, DolphinProvider, MockBrowserProvider } from './browser/providers.js';
import { MockPublisher, ThreadsPublisher } from './browser/publisher.js';
import { SourceLibrary, ContentEngine, CompatibleLlm, DemoLlm } from './content/service.js';
import { AccountManager } from './accounts/service.js';
import { Scheduler } from './scheduler/service.js';
import { PublishingWorker } from './scheduler/worker.js';
import { QueueRuntime, DemoRuntime } from './scheduler/queue.js';
import { Analytics } from './analytics/service.js';
import { AnalyticsCollector, OfficialInsights, DemoInsights } from './analytics/collector.js';
import { Tracking } from './tracking/service.js';
import { Monitoring } from './monitoring/service.js';
import { createBot } from './bot/bot.js';
import { TelegramNotifications } from './bot/notifications.js';
import type { BotServices } from './bot/bot.js';
import { buildServer } from './http/server.js';
import { requireHeavyDiskSpace } from './maintenance/disk.js';
import { BrowserCoordinator } from './browser/coordinator.js';
import { OpenAiResponses } from './content/openai.js';
import { ProfileManager } from './profile/service.js';
import { ThreadsProfilePort } from './profile/browser.js';
import { EngagementManager } from './engagement/service.js';
import { ThreadsEngagementPort } from './engagement/browser.js';
import { EngagementQueue } from './engagement/queue.js';
export async function createApplication(
  config: Config,
  database?: Database,
  options: { clock?: WorkerClock; onFatal?: () => void } = {},
) {
  const demo = config.APP_MODE === 'demo',
    db =
      database ??
      (demo
        ? new MemoryDatabase(config.DEMO_STATE_PATH)
        : PrismaDatabase.connect(config.DATABASE_URL));
  if (db instanceof MemoryDatabase) await db.load();
  if (demo) await seedDemo(db);
  await upgradeV11(db, config);
  await upgradePrelaunch(db);
  const manual = new ManualPolicy(
    db,
    config.allowedIds.map(String),
    config.TELEGRAM_OWNER_ID || String(config.allowedIds[0] ?? ''),
    config.MANUAL_LIVE_ALLOWED === '1',
  );
  await manual.migrate();
  const autopilotPolicy = new AutopilotPolicy(
    db,
    config.TELEGRAM_OWNER_ID || String(config.allowedIds[0] ?? ''),
    demo
      ? []
      : config.ADSPOWER_ALLOWED_PROFILE_IDS.split(',')
          .map((x) => x.trim())
          .filter(Boolean),
  );
  const templates = new TemplateService(db);
  const mock = new MockBrowserProvider(),
    providers = {
      ADSPOWER: demo
        ? mock
        : new AdsPowerProvider(
            config.ADSPOWER_BASE_URL,
            config.ADSPOWER_API_KEY,
            undefined,
            config.ADSPOWER_ALLOWED_PROFILE_IDS.split(',')
              .map((id) => id.trim())
              .filter(Boolean),
            config.ADSPOWER_HEADLESS === '1',
            () => requireHeavyDiskSpace(config.ARTIFACTS_DIR),
          ),
      DOLPHIN: demo ? mock : new DolphinProvider(config.DOLPHIN_BASE_URL, config.DOLPHIN_API_TOKEN),
      MOCK: mock,
    };
  const publisher = demo
    ? new MockPublisher()
    : new ThreadsPublisher(config.THREADS_SELECTORS_PATH, config.ARTIFACTS_DIR);
  let notify = async (message: string) => {
    await db.insert('systemEvent', { ...base(), level: 'INFO', code: 'NOTIFICATION', message });
  };
  const executor = new PublishingWorker(
    db,
    providers,
    publisher,
    (message) => notify(message),
    config.BROWSER_CONCURRENCY,
    options.clock,
    demo || config.BROWSER_EXECUTION_MODE === 'LIVE',
    manual,
    autopilotPolicy,
  );
  const runtime = demo
    ? new DemoRuntime(db, executor)
    : new QueueRuntime(
        db,
        executor,
        config.REDIS_URL,
        config.BROWSER_CONCURRENCY,
        !['api', 'bot'].includes(config.PROCESS_ROLE),
        config.PUBLISH_QUEUE_NAME,
        autopilotPolicy,
      );
  const ctas = new CtaService(db, config.PUBLIC_BASE_URL, config.TELEGRAM_TARGET),
    retention = new Retention(
      db,
      config.TRACKING_HASH_SECRET,
      demo ? async () => null : telegramMembershipChecker(config.TELEGRAM_BOT_TOKEN),
    ),
    performance = new PerformanceRating(db);
  const browserAccess = new BrowserCoordinator(db, providers);
  const content = new ContentEngine(
    db,
    config,
    demo
      ? new DemoLlm()
      : config.LLM_PROVIDER === 'openai'
        ? new OpenAiResponses(config)
        : new CompatibleLlm(config),
    (message) => notify(message),
  );
  const profileManager = new ProfileManager(
    db,
    demo
      ? {
          read: async () => ({ bio: 'Демонстрационное био', links: [], linkCapacity: 5 }),
          change: async (_id, before, after, commit, barrier) => {
            if (commit) await barrier();
            return commit ? after : before;
          },
        }
      : new ThreadsProfilePort(browserAccess),
    content,
    config.PROFILE_CHANGES_ALLOWED === '1',
  );
  const engagement = new EngagementManager(
    db,
    demo
      ? { search: async () => [], reply: async () => ({ url: null }), like: async () => {} }
      : new ThreadsEngagementPort(browserAccess, config.THREADS_SELECTORS_PATH),
    content,
  );
  const engagementQueue = new EngagementQueue(
    engagement,
    !demo &&
      config.BROWSER_EXECUTION_MODE === 'LIVE' &&
      config.ENGAGEMENT_EXECUTION_MODE === 'LIVE',
    {
      jobId: config.ONE_SHOT_REPLY_JOB_ID,
      actor: config.ONE_SHOT_REPLY_USER_ID,
      expiresAt: config.ONE_SHOT_REPLY_EXPIRES_AT,
    },
    manual,
    autopilotPolicy,
  );
  const collector = new AnalyticsCollector(
    db,
    demo
      ? new DemoInsights()
      : new AutopilotInsights(
          db,
          new OfficialInsights(config, db),
          autopilotPolicy,
          engagement.port,
        ),
  );
  const generation = new GenerationQueue(db, content, engagement, engagementQueue),
    scheduler = new Scheduler(db, Math.random, ctas);
  const autopilot = new AutopilotService(
    db,
    autopilotPolicy,
    content,
    engagement,
    engagementQueue,
    scheduler,
    executor,
    generation,
    collector,
  );
  generation.setAutopilot((id, send) => (send ? autopilot.sendReply(id) : autopilot.process(id)));
  runtime.setAutopilotTick(() => autopilot.tick());
  const services: BotServices = {
    worker: executor,
    autopilot,
    autopilotPolicy,
    manual,
    generation,
    profileManager,
    engagement,
    engagementQueue,
    templates,
    quality: new GenerationQuality(db),
    diagnostics: new BrowserDiagnostics(),
    ctas,
    retention,
    performance,
    db,
    providers,
    refreshMetrics: () => collector.tick(true),
    accounts: new AccountManager(
      db,
      providers,
      publisher,
      demo,
      config.BROWSER_CONCURRENCY,
      demo || config.BROWSER_EXECUTION_MODE === 'LIVE',
      {
        publicBase: config.PUBLIC_BASE_URL,
        target: config.TELEGRAM_TARGET,
      },
    ),
    library: new SourceLibrary(db, config),
    content,
    scheduler,
    analytics: new Analytics(
      db,
      demo || Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHANNEL_ID),
    ),
    tracking: new Tracking(db, config.TRACKING_HASH_SECRET),
    monitoring: new Monitoring(
      db,
      demo ? [mock] : [providers.ADSPOWER, providers.DOLPHIN],
      () => runtime.ping(),
      demo,
    ),
  };
  const offline = demo && !config.TELEGRAM_BOT_TOKEN;
  const messages: unknown[] = [];
  const bot = ['worker', 'api'].includes(config.PROCESS_ROLE)
    ? undefined
    : createBot(
        offline ? { ...config, TELEGRAM_BOT_TOKEN: '123456:DEMO', allowedIds: [1] } : config,
        services,
      );
  if (offline && bot) {
    bot.api.config.use((async (_prev: any, method: string, payload: any) => {
      if (method === 'getMe')
        return {
          ok: true,
          result: {
            id: 123456,
            is_bot: true,
            first_name: 'Content Factory Demo',
            username: 'content_factory_demo_bot',
          },
        };
      messages.push({ method, ...payload });
      return {
        ok: true,
        result:
          method === 'answerCallbackQuery'
            ? true
            : {
                message_id: messages.length,
                date: Math.floor(Date.now() / 1000),
                chat: { id: 1, type: 'private' },
                text: payload.text,
              },
      };
    }) as any);
    await bot.init();
  }
  const notifications =
    bot && !offline
      ? new TelegramNotifications(db, config.allowedIds, (id, text) =>
          bot.api.sendMessage(id, text),
        )
      : undefined;
  const server = ['worker', 'bot'].includes(config.PROCESS_ROLE)
    ? undefined
    : await buildServer(config, services, offline && bot ? { bot, messages } : undefined);
  let started = false;
  let generationDelivery: NodeJS.Timeout | undefined;
  let delivering = false;
  let deliveryRunning: Promise<void> | undefined;
  return {
    config,
    db,
    services,
    executor,
    runtime,
    collector,
    retention,
    server,
    bot,
    async start() {
      if (started) return;
      started = true;
      if (['all', 'worker'].includes(config.PROCESS_ROLE)) await runtime.start();
      if (['all', 'worker'].includes(config.PROCESS_ROLE)) {
        await services.generation.start();
        await engagementQueue.start();
        await collector.start();
        await retention.start();
      }
      if (server) await server.listen({ host: config.HOST, port: config.PORT });
      if (bot && !offline) {
        await bot.init();
        const webhook = await bot.api.getWebhookInfo();
        if (webhook.url)
          throw new Error(
            'TELEGRAM_WEBHOOK_CONFLICT: отключите существующий webhook перед polling',
          );
        await bot.api.setMyCommands([
          { command: 'start', description: 'Главное меню' },
          { command: 'ping', description: 'Проверка связи' },
          { command: 'status', description: 'Состояние системы' },
          { command: 'accounts', description: 'Аккаунты' },
          { command: 'queue', description: 'Очередь' },
          { command: 'help', description: 'Команды и редактирование CTA' },
        ]);
        await notifications?.start();
        generationDelivery = setInterval(() => {
          if (delivering) return;
          delivering = true;
          deliveryRunning = deliverGenerations(bot, services, config)
            .catch(() =>
              console.error('Не удалось доставить предпросмотр Telegram; результат сохранён'),
            )
            .finally(() => {
              delivering = false;
            });
        }, 2000);
        generationDelivery.unref();
        void bot
          .start({
            allowed_updates: ['message', 'callback_query', 'chat_member'],
            onStart: () => console.log('Telegram-бот запущен'),
          })
          .catch(() => {
            console.error('Telegram polling остановлен; требуется перезапуск службы');
            options.onFatal?.();
          });
      }
      console.log(
        `${demo ? 'ДЕМОНСТРАЦИЯ — искусственные данные' : 'Content Factory'}: ${config.PROCESS_ROLE} · браузер: ${demo ? 'DEMO' : config.BROWSER_EXECUTION_MODE} ${server ? `http://${config.HOST}:${config.PORT}` : ''}`,
      );
    },
    async close() {
      if (generationDelivery) clearInterval(generationDelivery);
      await deliveryRunning;
      await services.generation.close();
      await engagementQueue.close();
      notifications?.close();
      if (bot?.isRunning()) await bot.stop();
      await runtime.close();
      await collector.close();
      await retention.close();
      await server?.close();
      await db.close();
    },
  };
}
