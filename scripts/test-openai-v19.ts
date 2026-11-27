import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { base } from '../src/db/database.js';
import { getDocument, putDocument, hashDocument } from '../src/db/documents.js';
import { normalizeText, isRussian } from '../src/content/normalizer.js';
import { Api } from 'grammy';
import { readFile, writeFile } from 'node:fs/promises';
import { assert } from '../src/core/errors.js';
interface State {
  postStarted?: boolean;
  generatedId?: string;
  postMessageId?: number;
  candidateId?: string;
  replyVerified?: boolean;
  replyStarted?: boolean;
  replyId?: string;
  replyMessageId?: number;
  normalizerEnabled?: boolean;
}
const config = loadConfig({
  ...process.env,
  PROCESS_ROLE: 'worker',
  LLM_PROVIDER: 'openai',
  BROWSER_EXECUTION_MODE: 'DRY_RUN',
  PROFILE_CHANGES_ALLOWED: '0',
  ENGAGEMENT_EXECUTION_MODE: 'DRY_RUN',
});
const app = await createApplication(config),
  db = app.db,
  accountId = 'threads02',
  key = 'v19-openai-preview',
  api = new Api(config.TELEGRAM_BOT_TOKEN),
  owner = 7842338078;
const report: Record<string, unknown> = {
  mode: 'OPENAI_PREVIEWS_ONLY',
  postsSent: 0,
  repliesSent: 0,
  likesSent: 0,
};
try {
  assert(
    (await db.get('setting', 'factoryPaused'))?.value === 'true' &&
      (await db.get('account', accountId))?.status === 'PAUSED',
    'UNSAFE_STATE',
    'Нужны PAUSED и DRY_RUN',
  );
  const access = JSON.parse(
    await readFile('/var/lib/content-factory/reports/KEEP-v19-model-access.json', 'utf8'),
  );
  assert(
    ['gpt-6.2-sol', 'gpt-6.1-terra'].every((m) => access.available.includes(m)),
    'MODEL_UNAVAILABLE',
    'Не подтверждена доступность моделей',
  );
  let state = (await getDocument<State>(db, key)) ?? {};
  const save = async (patch: Partial<State>) => {
    state = { ...state, ...patch };
    await putDocument(db, key, state);
  };
  const sourceId = 'v19-test-x-source',
    text =
      'A trading plan can look clear until price starts moving. It helps to decide in advance where the idea stops making sense and what loss is acceptable. The point is not to predict every move, but to avoid improvising under pressure.';
  if (!(await db.get('source', sourceId)))
    await db.insert('source', {
      ...base(sourceId),
      url: null,
      text,
      fingerprint: hashDocument(text),
      author: null,
      rights: 'OWN',
      topic: 'трейдинг',
      format: 'наблюдение',
      hook: 'план',
    });
  if (!state.generatedId) {
    const existing = (await db.list('generated', { sourceId, accountId })).at(-1);
    if (existing) await save({ generatedId: existing.id });
    else {
      assert(
        !state.postStarted,
        'NO_AUTO_RETRY',
        'Тест Sol уже начинался. Нужна сверка, автоматического повтора нет',
      );
      await save({ postStarted: true });
      const post = await app.services.content.generate(sourceId, accountId, {
        normalizerPreview: true,
      });
      await save({ generatedId: post.id });
    }
  }
  const post = (await db.get('generated', state.generatedId!))!;
  assert(
    post.valid && !post.approved && post.text === normalizeText(post.text) && isRussian(post.text),
    'INVALID_PREVIEW',
    'Предпросмотр Sol не прошёл формат',
  );
  const postUsage = (await db.get('aiRequest', post.aiRequestId!))!;
  assert(
    postUsage.model.startsWith('gpt-6.2-sol') && postUsage.status === 'COMPLETED',
    'WRONG_MODEL',
    'Sol не завершил запрос',
  );
  if (!state.postMessageId) {
    const message = await api.sendMessage(
      owner,
      `предпросмотр адаптации, не опубликовано\nмодель: ${postUsage.model}, reasoning: low\nисходник: авторский английский тестовый пост формата x\n\n${post.text}\n\ninput/output tokens: ${postUsage.inputTokens}/${postUsage.outputTokens}\nстоимость по фактическим токенам: $${postUsage.costUsd.toFixed(6)}`,
    );
    await save({ postMessageId: message.message_id });
  }
  if (!state.candidateId) {
    const candidate = (await app.services.engagement.candidates(accountId)).find(
      (c) => c.status === 'NEW' && c.text.length > 60,
    );
    assert(candidate, 'NO_CANDIDATE', 'Нужна существующая русская публикация');
    await save({ candidateId: candidate.id });
  }
  const candidate = await app.services.engagement.candidate(accountId, state.candidateId!);
  report.replySourceObservedAt = candidate.discoveredAt;
  report.replySource = 'saved_public_threads_post';
  if (!state.replyId) {
    const old = (await app.services.engagement.drafts(accountId)).find(
      (d) => d.candidateId === candidate.id && d.requestId,
    );
    if (old) await save({ replyId: old.id });
    else {
      assert(
        !state.replyStarted,
        'NO_AUTO_RETRY',
        'Тест Terra уже начинался. Автоматического повтора нет',
      );
      await save({ replyStarted: true });
      const reply = await app.services.engagement.generate(accountId, candidate.id, 'v19-preview');
      await save({ replyId: reply.id });
    }
  }
  const reply = await app.services.engagement.draft(accountId, state.replyId!),
    replyUsage = (await db.get('aiRequest', reply.requestId!))!;
  assert(
    reply.status === 'DRAFT' &&
      reply.text === normalizeText(reply.text) &&
      isRussian(reply.text) &&
      replyUsage.model.startsWith('gpt-6.1-terra') &&
      replyUsage.status === 'COMPLETED',
    'INVALID_PREVIEW',
    'Предпросмотр Terra не прошёл проверку',
  );
  if (!state.replyMessageId) {
    const message = await api.sendMessage(
      owner,
      `предпросмотр ответа, не опубликовано\nмодель: ${replyUsage.model}, reasoning: none\nпубликация: ${candidate.url}\n\n${reply.text}\n\ninput/output tokens: ${replyUsage.inputTokens}/${replyUsage.outputTokens}\nстоимость по фактическим токенам: $${replyUsage.costUsd.toFixed(6)}`,
    );
    await save({ replyMessageId: message.message_id });
  }
  await app.services.profileManager.normalizer(accountId, true, 'v19-preview');
  await save({ normalizerEnabled: true });
  const rows = [postUsage, replyUsage];
  report.ok = true;
  report.results = [
    { purpose: 'POST', text: post.text },
    { purpose: 'REPLY', text: reply.text, url: candidate.url },
  ];
  report.usage = rows.map((r) => ({
    id: r.id,
    responseId: r.providerResponseId,
    model: r.model,
    effort: r.reasoningEffort,
    inputTokens: r.inputTokens,
    cachedInputTokens: r.cachedInputTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    outputTokens: r.outputTokens,
    reasoningTokens: r.reasoningTokens,
    costUsd: r.costUsd,
  }));
  report.totalCostUsd = rows.reduce((sum, r) => sum + r.costUsd, 0);
  report.telegramDelivered = true;
  report.normalizerEnabled = true;
  report.factoryPaused = (await db.get('setting', 'factoryPaused'))?.value;
} catch (e) {
  report.ok = false;
  report.error = e instanceof Error ? e.message : 'PREVIEW_FAILED';
  process.exitCode = 1;
} finally {
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v19-openai-test.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
  await app.close();
}
