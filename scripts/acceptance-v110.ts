import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { assert } from '../src/core/errors.js';
import type { GenerationTask } from '../src/content/jobs.js';
import { writeFile } from 'node:fs/promises';

// Calls real handlers and Telegram API; never starts polling or a second worker.
const config = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' });
const app = await createApplication(config);
const owner = 7842338078,
  accountId = 'threads02',
  key = 'v110-acceptance';
let state: any = (await getDocument(app.db, key)) ?? {};
const save = async (patch: object) => {
  state = { ...state, ...patch };
  await putDocument(app.db, key, state);
};
let sequence = Math.floor(Date.now() / 1000) + 1100000000;
const send = async (text?: string, callback?: string) => {
  const user = { id: owner, is_bot: false, first_name: 'V1.10 test' };
  const message = {
    message_id: sequence++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: owner, type: 'private' as const, first_name: 'Owner' },
    from: user,
    text: text ?? '',
    ...(text?.startsWith('/')
      ? {
          entities: [
            { type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length },
          ],
        }
      : {}),
  };
  await app.bot!.handleUpdate(
    callback
      ? {
          update_id: sequence++,
          callback_query: {
            id: String(sequence),
            chat_instance: 'v110-check',
            from: user,
            data: callback,
            message,
          },
        }
      : { update_id: sequence++, message },
  );
};
const task = async (id: string) => {
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const t = (await getDocument<GenerationTask>(app.db, `generation-task-${id}`))!;
    if (['FAILED', 'NEEDS_REVIEW'].includes(t.status)) throw new Error(t.error ?? t.status);
    if (t.status === 'COMPLETED' && t.deliveredAt) return t;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error('TASK_WAIT_EXPIRED_NO_AUTO_RETRY');
};
try {
  assert(
    config.BROWSER_EXECUTION_MODE === 'DRY_RUN' && config.ENGAGEMENT_EXECUTION_MODE === 'DRY_RUN',
    'UNSAFE',
    'Нужен DRY_RUN',
  );
  assert(
    (await app.db.get('setting', 'factoryPaused'))?.value === 'true',
    'UNSAFE',
    'Завод должен оставаться PAUSED',
  );
  await app.bot!.init();
  app.bot!.api.config.use(async (previous, method, payload, signal) =>
    method === 'answerCallbackQuery'
      ? ({ ok: true, result: true } as any)
      : previous(method, payload, signal),
  );
  if (['baseline', 'observe'].includes(process.env.V110_PHASE ?? '')) {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    assert(response.ok, 'MODEL_ACCESS', 'Список моделей недоступен');
    const ids = ((await response.json()) as any).data.map((m: any) => m.id);
    assert(
      [config.POST_MODEL, config.REPLY_MODEL].every((m) => ids.includes(m)),
      'MODEL_ACCESS',
      'Модель недоступна',
    );
    if (process.env.V110_PHASE === 'baseline') {
      await save({
        modelAccess: [config.POST_MODEL, config.REPLY_MODEL],
        beforeFlow: await app.db.get('setting', `flow-${owner}`),
        baselinePosts: (await app.db.list('post')).length,
        baselineComments: (await app.db.list('comment')).length,
        baselineRequests: (await app.db.list('aiRequest')).map((r) => r.id),
      });
      console.log('BASELINE_SAVED_NO_LLM');
    } else {
      const flow = (await getDocument<any>(app.db, `flow-${owner}`))!;
      const source = await app.db.get('source', flow.assignments?.[accountId]);
      assert(source, 'SOURCE_NOT_SAVED', 'Нет исходника от настоящего Telegram');
      await save({
        sourceId: source.id,
        sourceChars: source.text.length,
        sourceKind: 'russian_fixture_via_real_telegram_desktop',
        sourceSaved: true,
        sourcePhaseAt: new Date().toISOString(),
        transport: 'real_telegram_desktop_input_polling_and_real_api_previews',
      });
      console.log(
        JSON.stringify({ phase: 'REAL_TELEGRAM_SOURCE_SAVED', chars: source.text.length }),
      );
    }
  } else if (process.env.V110_PHASE === 'source') {
    if (!state.sourceId) {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(15000),
      });
      assert(response.ok, 'MODEL_ACCESS', 'Не удалось проверить список моделей');
      const models = ((await response.json()) as any).data.map((m: any) => m.id);
      assert(
        [config.POST_MODEL, config.REPLY_MODEL].every((m) => models.includes(m)),
        'MODEL_ACCESS',
        'Нужные модели недоступны',
      );
      await save({
        modelAccess: [config.POST_MODEL, config.REPLY_MODEL],
        beforeFlow: await app.db.get('setting', `flow-${owner}`),
        beforeV18: await app.db.get('setting', `v18-flow-${owner}`),
        baselinePosts: (await app.db.list('post')).length,
        baselineComments: (await app.db.list('comment')).length,
        baselineRequests: (await app.db.list('aiRequest')).map((r) => r.id),
      });
      await send('/start');
      await send(undefined, 'create');
      await send(undefined, 'publication:ACCOUNT_SPECIFIC');
      await send(undefined, `assign:${accountId}`);
      const paragraph =
        'торговый план кажется понятным, пока рынок стоит на месте. когда цена начинает быстро меняться, легко забыть собственные правила и начать действовать на эмоциях. поэтому полезно заранее записать, при каких условиях идея перестаёт работать и какой риск для неё допустим. такая запись помогает оценивать решение по плану, а не по тому, чем закончилась отдельная сделка';
      const text = Array.from({ length: 9 }, () => paragraph).join('\n\n');
      await send(text);
      const flow = (await getDocument<any>(app.db, `flow-${owner}`))!;
      const source = (await app.db.get('source', flow.assignments[accountId]))!;
      assert(source.text === text, 'SOURCE_NOT_SAVED', 'Исходник не сохранился');
      await save({
        sourceId: source.id,
        sourceChars: text.length,
        sourceKind: 'authored_russian_acceptance_fixture',
        sourceSaved: true,
        sourcePhaseAt: new Date().toISOString(),
      });
    }
    console.log(
      JSON.stringify({
        phase: 'SOURCE_SAVED',
        chars: state.sourceChars,
        modelsAvailable: state.modelAccess,
        paidRequests: 0,
      }),
    );
  } else {
    assert(state.sourceId, 'SOURCE_NOT_SAVED', 'Сначала нужен тест сохранения');
    const flow = (await getDocument<any>(app.db, `flow-${owner}`))!;
    assert(
      flow.assignments?.[accountId] === state.sourceId,
      'FSM_CHANGED',
      'FSM изменён пользователем; не перезаписываю его',
    );
    await save({ fsmRecoveredAfterServiceRestart: true });
    if (!state.postTask) {
      await send(undefined, `source_prepare:${accountId}`);
      const t = (await app.services.generation.list()).find(
        (t) =>
          t.kind === 'POST' &&
          t.preparation?.mappings?.some(
            (m) => m.sourceId === state.sourceId && m.accountId === accountId,
          ),
      );
      assert(t, 'TASK_MISSING', 'Нет задачи Sol');
      await save({ postTask: t.id });
    }
    const postTask = await task(state.postTask);
    await save({ postGeneratedId: postTask.results![0] });
    if (!state.searchTask) {
      await send(undefined, `v18search:${accountId}`);
      const t = (await app.services.generation.list())
        .filter((t) => t.kind === 'SEARCH' && t.accountId === accountId)
        .at(-1)!;
      assert(t, 'TASK_MISSING', 'Нет задачи поиска');
      await save({ searchTask: t.id });
    }
    const searched = await task(state.searchTask);
    await save({ searchMetrics: searched.metrics });
    if (!state.candidateId) {
      const c = (await app.services.engagement.candidates(accountId)).find(
        (c) => c.status === 'NEW',
      );
      assert(c, 'NO_CANDIDATE', 'Нет нового кандидата');
      await save({ candidateId: c.id });
    }
    if (!state.replyTask) {
      await send(undefined, `v18candidate:${state.candidateId}`);
      await send(undefined, 'v18generate');
      const t = (await app.services.generation.list()).find(
        (t) => t.kind === 'REPLY' && t.candidateId === state.candidateId,
      )!;
      assert(t, 'TASK_MISSING', 'Нет задачи Terra');
      await save({ replyTask: t.id });
    }
    const replied = await task(state.replyTask);
    await send(undefined, `v18diag:${accountId}`);
    const post = (await app.db.get('generated', state.postGeneratedId))!,
      reply = await app.services.engagement.draft(accountId, replied.results![0]!);
    assert(
      post.valid && !post.approved && reply.status === 'DRAFT',
      'BAD_PREVIEW',
      'Нужны неодобренные предпросмотры',
    );
    assert(
      (await app.db.list('post')).length === state.baselinePosts &&
        (await app.db.list('comment')).length === state.baselineComments,
      'EXTERNAL_SEND',
      'Изменилось число публикаций',
    );
    const rows = (await app.db.list('aiRequest')).filter((r) =>
      [post.aiRequestId, reply.requestId].includes(r.id),
    );
    const report = {
      ok: true,
      checkedAt: new Date().toISOString(),
      transport: state.transport ?? 'synthetic_updates_real_handlers_postgresql_and_telegram_api',
      sourceSaved: state.sourceSaved,
      sourceChars: state.sourceChars,
      sourceKind: state.sourceKind,
      fsmRecoveredAfterServiceRestart: state.fsmRecoveredAfterServiceRestart,
      modelAccess: state.modelAccess,
      search: state.searchMetrics,
      postPreview: post.text,
      replyPreview: reply.text,
      replyUrl: (await app.services.engagement.candidate(accountId, state.candidateId)).url,
      usage: rows.map((r) => ({
        model: r.model,
        effort: r.reasoningEffort,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
        status: r.status,
        responseId: r.providerResponseId,
      })),
      testCostUsd: rows.reduce((s, r) => s + r.costUsd, 0),
      totalCostUsd: (await app.db.list('aiRequest')).reduce((s, r) => s + r.costUsd, 0),
      diagnostics: await app.services.engagement.diagnostics(accountId),
      postsSent: 0,
      repliesSent: 0,
      likesSent: 0,
    };
    await writeFile(
      '/var/lib/content-factory/reports/KEEP-v110-acceptance.json',
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    await save({ completed: true });
    console.log(JSON.stringify(report));
  }
} catch (e) {
  const error = e instanceof Error ? e.message : 'ACCEPTANCE_FAILED';
  await save({ lastError: error });
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v110-acceptance-error.json',
    JSON.stringify(
      {
        phase: process.env.V110_PHASE ?? 'finish',
        error,
        postTask: state.postTask,
        searchTask: state.searchTask,
        replyTask: state.replyTask,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ ok: false, error }));
  process.exitCode = 1;
} finally {
  await app.close();
}
