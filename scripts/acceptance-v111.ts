import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { replyJobCard } from '../src/bot/reply-card.js';
import { assert } from '../src/core/errors.js';
import type { GenerationTask } from '../src/content/jobs.js';
import { readFile, writeFile } from 'node:fs/promises';
const config = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }),
  app = await createApplication(config),
  owner = 7842338078,
  key = 'v111-acceptance';
let state: any = (await getDocument(app.db, key)) ?? {};
const save = async (patch: object) => {
  state = { ...state, ...patch };
  await putDocument(app.db, key, state);
};
const before = JSON.parse(
  await readFile('/var/lib/content-factory/reports/KEEP-v111-before-audit.json', 'utf8'),
);
let update = Math.floor(Date.now() / 1000) + 1200000000;
const callback = async (data: string) => {
  const sequence = update++;
  await save({ syntheticUpdates: [...(state.syntheticUpdates ?? []), sequence] });
  await app.bot!.handleUpdate({
    update_id: sequence,
    callback_query: {
      id: String(sequence),
      chat_instance: 'v111-test',
      from: { id: owner, is_bot: false, first_name: 'Owner' },
      data,
      message: {
        message_id: sequence,
        date: Math.floor(Date.now() / 1000),
        chat: { id: owner, type: 'private', first_name: 'Owner' },
        text: 'V1.11 acceptance',
      },
    },
  });
};
const wait = async (id: string) => {
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const t = (await getDocument<GenerationTask>(app.db, `generation-task-${id}`))!;
    if (['FAILED', 'NEEDS_REVIEW'].includes(t.status)) return t;
    if (t.status === 'COMPLETED' && t.deliveredAt) return t;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw Error('WAIT_EXPIRED_NO_AUTO_RETRY');
};
try {
  assert(
    config.BROWSER_EXECUTION_MODE === 'DRY_RUN' &&
      config.ENGAGEMENT_EXECUTION_MODE === 'DRY_RUN' &&
      !config.ONE_SHOT_REPLY_JOB_ID &&
      !config.ONE_SHOT_REPLY_USER_ID &&
      !config.ONE_SHOT_REPLY_EXPIRES_AT,
    'UNSAFE',
    'Нужны DRY_RUN и пустое адресное LIVE-разрешение',
  );
  assert(
    (await app.db.get('setting', 'factoryPaused'))?.value === 'true',
    'UNSAFE',
    'Завод должен оставаться PAUSED',
  );
  await app.bot!.init();
  // Only synthetic callback ACK is mocked. Message delivery and all application work are real.
  app.bot!.api.config.use(async (previous, method, payload, signal) =>
    method === 'answerCallbackQuery'
      ? ({ ok: true, result: true } as any)
      : previous(method, payload, signal),
  );
  if (!state.cardsSent) {
    await save({
      startedAt: new Date().toISOString(),
      postsBefore: (await app.db.list('post')).length,
      commentsBefore: (await app.db.list('comment')).length,
    });
    for (const row of before.rows) {
      const card = await replyJobCard(app.services.engagement, row.jobId, config);
      await app.bot!.api.sendMessage(owner, card.text, { reply_markup: card.reply_markup });
    }
    await callback('v111style:threads02');
    await save({ cardsSent: true });
  }
  if (process.env.V111_PHASE === 'cards') {
    console.log('V111_CARDS_DELIVERED_NO_LIVE');
  } else {
    const selected = before.rows[1].jobId;
    if (!state.preflightTask) {
      await callback(`v111publish:${selected}`);
      const t = (await app.services.generation.list())
        .filter((t) => t.kind === 'REPLY_CHECK' && t.replyJobId === selected)
        .at(-1)!;
      assert(t, 'MISSING_TASK', 'Нет задачи preflight');
      await save({ preflightTask: t.id });
    }
    const preflight = await wait(state.preflightTask);
    if (preflight.status === 'COMPLETED' && preflight.permissionId && !state.confirmTested) {
      await callback(`v111confirm:${preflight.permissionId}`);
      assert(
        (await app.services.engagementQueue.permissions.get(preflight.permissionId)).state ===
          'PENDING',
        'UNSAFE',
        'Без оператора разрешение не должно подтверждаться',
      );
      assert(
        !(await app.services.generation.list()).some((t) => t.kind === 'REPLY_SEND'),
        'UNSAFE',
        'Не должно быть задач реальной отправки',
      );
      await save({ confirmTested: true });
    }
    if (!state.candidateId) {
      const c = (await app.services.engagement.candidates('threads02')).find(
        (c) => c.id === '52d6c0eae54955f838c43af1',
      );
      assert(
        c && c.status === 'NEW',
        'CANDIDATE',
        'Выбранный тестовый пост уже обработан; автоматического выбора другого нет',
      );
      await save({ candidateId: c.id });
    }
    if (!state.replyTask) {
      await callback(`v18candidate:${state.candidateId}`);
      await callback('v18generate');
      const t = (await app.services.generation.list()).find(
        (t) => t.kind === 'REPLY' && t.candidateId === state.candidateId,
      )!;
      assert(t, 'MISSING_TASK', 'Нет задачи Terra');
      await save({ replyTask: t.id });
    }
    const generated = await wait(state.replyTask);
    assert(
      generated.status === 'COMPLETED',
      'GENERATION_FAILED',
      generated.error ?? 'Генерация не завершена',
    );
    const draft = await app.services.engagement.draft('threads02', generated.results![0]!),
      usage = (await app.db.get('aiRequest', draft.requestId!))!;
    const after = [];
    for (const row of before.rows) {
      const v = await app.services.engagement.jobView(row.jobId);
      assert(
        v.draft!.text === row.text && v.draft!.approvedAt === row.approvedAt,
        'CHANGED_OLD_TEXT',
        'Старый текст или одобрение изменены',
      );
      after.push({
        jobId: v.job.id,
        approvalStatus: v.approvalStatus,
        executionStatus: v.executionStatus,
        legacyStatus: v.job.status,
        url: v.job.url ?? null,
        submittedAt: v.job.submittedAt ?? null,
        textUnchanged: true,
        approvedAt: v.draft!.approvedAt,
      });
    }
    await callback('v18diag:threads02');
    const published = (await app.db.list('post')).length,
      comments = (await app.db.list('comment')).length;
    assert(
      published === state.postsBefore && comments === state.commentsBefore,
      'UNSAFE',
      'Изменилось число собственных публикаций',
    );
    assert(
      !(await app.services.engagement.jobs()).some((j) => j.submittedAt || j.url),
      'UNSAFE',
      'Началась реальная отправка',
    );
    const report = {
      ok: preflight.status === 'COMPLETED' && draft.generationState === 'READY',
      at: new Date().toISOString(),
      oldReplies: after,
      preflight: {
        taskId: preflight.id,
        status: preflight.status,
        error: preflight.error ?? null,
        operatorConfirmationBlocked: state.confirmTested ?? false,
      },
      terra: {
        text: draft.text,
        promptVersion: draft.promptVersion,
        model: usage.model,
        generationState: draft.generationState,
        validationErrors: draft.validationErrors,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
        responseId: usage.providerResponseId,
        sourceUrl: (await app.services.engagement.candidate('threads02', state.candidateId)).url,
        delivered: !!generated.deliveredAt,
      },
      diagnostics: await app.services.engagement.diagnostics('threads02'),
      queuedSendTasks: (await app.services.generation.list()).filter((t) => t.kind === 'REPLY_SEND')
        .length,
      liveOperatorAuthorization: false,
      factoryPaused: true,
      postsSent: 0,
      repliesSent: 0,
      likesSent: 0,
      telegramDeliveryReal: true,
      automatedCallbacks: true,
    };
    await writeFile(
      '/var/lib/content-factory/reports/KEEP-v111-acceptance.json',
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    await save({ completed: true });
    console.log(JSON.stringify(report));
  }
} catch (e) {
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v111-acceptance-error.json',
    JSON.stringify({
      error: e instanceof Error ? e.message : 'FAILED',
      preflightTask: state.preflightTask,
      replyTask: state.replyTask,
    }),
    { mode: 0o600 },
  );
  console.log('V111_ACCEPTANCE_FAILED_NO_AUTO_RETRY');
  process.exitCode = 1;
} finally {
  await app.close();
}
