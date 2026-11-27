import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument } from '../src/db/documents.js';
import { assert } from '../src/core/errors.js';
import { writeFile } from 'node:fs/promises';

// No app.start(): no polling, queues, browser launch, or LLM generation.
const config = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' });
const app = await createApplication(config);
try {
  assert(config.LLM_PROVIDER === 'openai' && config.OPENAI_API_KEY, 'CONFIG', 'OpenAI не настроен');
  assert(
    config.BROWSER_EXECUTION_MODE === 'DRY_RUN' &&
      config.ENGAGEMENT_EXECUTION_MODE === 'DRY_RUN' &&
      config.PROFILE_CHANGES_ALLOWED === '0',
    'GUARDS',
    'Нужны безопасные режимы',
  );
  const rows = await app.db.list('aiRequest');
  assert(
    rows.length === 2 && rows.every((r) => r.status === 'COMPLETED'),
    'REQUESTS',
    'Нужны ровно два завершённых запроса',
  );
  const state = (await getDocument<{ generatedId: string; replyId: string }>(
    app.db,
    'v19-openai-preview',
  ))!;
  const post = (await app.db.get('generated', state.generatedId))!;
  const reply = await app.services.engagement.draft('threads02', state.replyId);
  const normalizer = await getDocument<{ enabled: boolean }>(app.db, 'normalizer-threads02');
  const settings = await app.services.engagement.settings('threads02');
  const posts = await app.db.list('post');
  const comments = await app.db.list('comment');
  const factoryPaused = (await app.db.get('setting', 'factoryPaused'))?.value === 'true';
  const accountPaused = (await app.db.get('account', 'threads02'))?.status === 'PAUSED';
  assert(
    factoryPaused && accountPaused && normalizer?.enabled && !settings.enabled && !settings.likes,
    'STATE',
    'Проверьте режимы аккаунта',
  );
  assert(
    !post.approved && reply.status === 'DRAFT' && posts.length === 1 && comments.length === 1,
    'NO_PUBLICATIONS',
    'Изменилось состояние публикаций',
  );
  const before = rows.length;
  await app.bot!.init();
  const webhook = await app.bot!.api.getWebhookInfo();
  assert(!webhook.url, 'WEBHOOK_CONFLICT', 'Webhook не должен конфликтовать с polling');
  let replies = 0;
  app.bot!.api.config.use(async (previous, method, payload, signal) => {
    const result = await previous(method, payload, signal);
    if (method === 'sendMessage' && result.ok) replies++;
    return result;
  });
  let sequence = 991900000;
  const commands = [];
  for (const command of ['/ping', '/status']) {
    const id = config.allowedIds[0]!,
      count = replies;
    await app.bot!.handleUpdate({
      update_id: sequence++,
      message: {
        message_id: sequence,
        date: Math.floor(Date.now() / 1000),
        from: { id, is_bot: false, first_name: 'V1.9 check' },
        chat: { id, type: 'private', first_name: 'V1.9 check' },
        text: command,
        entities: [{ type: 'bot_command', offset: 0, length: command.length }],
      },
    });
    assert(replies > count, 'BOT_REPLY', 'Не получен ответ Telegram');
    commands.push({ command, telegramAccepted: true });
  }
  const response = await fetch('http://127.0.0.1:3000/health', {
    headers: { Authorization: `Bearer ${config.INTERNAL_API_TOKEN}` },
  });
  const health = (await response.json()) as {
    database: string;
    redis: string;
    aiCostTotal: number;
  };
  assert(
    response.ok && health.database === 'OK' && health.redis === 'PONG',
    'HEALTH',
    'Проверьте БД/Redis',
  );
  assert(
    (await app.db.list('aiRequest')).length === before,
    'NO_LLM',
    'Проверка не должна вызывать LLM',
  );
  const report = {
    ok: true,
    verifiedAt: new Date().toISOString(),
    provider: config.LLM_PROVIDER,
    postModel: config.POST_MODEL,
    replyModel: config.REPLY_MODEL,
    bioModel: config.BIO_MODEL,
    warningUsd: config.AI_WARNING_USD,
    hardLimitUsd: config.AI_TOTAL_LIMIT_USD,
    completedRequests: rows.length,
    actualCostUsd: rows.reduce((sum, r) => sum + r.costUsd, 0),
    factoryPaused,
    accountPaused,
    publishingMode: config.BROWSER_EXECUTION_MODE,
    engagementMode: config.ENGAGEMENT_EXECUTION_MODE,
    engagementEnabled: settings.enabled,
    likesEnabled: settings.likes,
    profileChangesAllowed: false,
    normalizerEnabled: normalizer.enabled,
    previewPostApproved: post.approved,
    previewReplyStatus: reply.status,
    preservedPosts: posts.length,
    preservedComments: comments.length,
    commands,
    webhookConfigured: false,
    health,
    newLlmRequestsDuringCheck: 0,
    pollingStartedDuringCheck: false,
  };
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v19-final-state.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  await app.close();
}
