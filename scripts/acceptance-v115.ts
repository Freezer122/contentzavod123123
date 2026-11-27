import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument, hashDocument, listDocuments } from '../src/db/documents.js';
import { assert } from '../src/core/errors.js';
import { InlineKeyboard } from 'grammy';
import { writeFile } from 'node:fs/promises';
import { audit } from '../src/db/database.js';
const cfg = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }),
  app = await createApplication(cfg),
  owner = cfg.TELEGRAM_OWNER_ID,
  key = 'v115-hotfix-acceptance';
let state: any = (await getDocument(app.db, key)) ?? {};
const save = async (v: object) => {
  state = { ...state, ...v };
  await putDocument(app.db, key, state);
};
const snapshot = async () => ({
  manual: await app.services.manual.settings('threads02'),
  factoryPaused: await getDocument(app.db, 'factoryPaused'),
  automationPaused: await getDocument(app.db, 'automationPaused'),
  emergencyStop: await getDocument(app.db, 'emergencyStop'),
  published: await Promise.all(
    (await app.db.list('post')).map(async (p) => ({
      id: p.id,
      hash: hashDocument(p),
      body: (await app.db.get('generated', p.generatedId))!.text,
    })),
  ),
  comments: await app.db.list('comment'),
  publishedReplies: await Promise.all(
    (await app.services.engagement.jobs())
      .filter((j) => j.status === 'PUBLISHED')
      .map(async (j) => ({
        id: j.id,
        url: j.url,
        text: (await app.services.engagement.draft(j.accountId, j.draftId!)).text,
      })),
  ),
});
try {
  assert(
    cfg.BROWSER_EXECUTION_MODE === 'DRY_RUN' && cfg.ENGAGEMENT_EXECUTION_MODE === 'DRY_RUN',
    'SAFETY',
    'Automatic modes changed',
  );
  if (!state.startedAt)
    await save({
      startedAt: new Date().toISOString(),
      before: await snapshot(),
      aiBefore: (await app.db.list('aiRequest')).map((r) => r.id),
      tasksBefore: (await app.services.generation.list()).map((t) => t.id),
    });
  const phase = process.env.V115_PHASE ?? 'cards';
  if (phase === 'batch' && !state.cliBatchInvokedAt) {
    const selection = await app.services.generation.replySelection(
      'threads02',
      owner,
      Number(owner),
    );
    await audit(
      app.db,
      'codex-v115-acceptance',
      'V115_ACCEPTANCE_SELECTION_CLI',
      'threads02',
      JSON.stringify(selection.counts),
    );
    await save({
      cliBatchInvokedAt: new Date().toISOString(),
      cliBatch: selection,
      cliBatchProvenance:
        'Direct call to the same GenerationQueue.replySelection used by the Telegram button; not a fabricated callback',
    });
    await app.bot!.api.sendMessage(
      Number(owner),
      `Проверка массовой подготовки на VPS: создано ${selection.counts.created}, уже в обработке ${selection.counts.processing}, с черновиком ${selection.counts.alreadyDrafted}. Результаты придут автоматически. Вызван тот же обработчик, что у кнопки; нажатие пользователя не имитировалось. Отправки в Threads нет`,
    );
  }
  if (phase === 'zero') {
    const selection = await app.services.generation.replySelection(
      'threads02',
      owner,
      Number(owner),
    );
    await audit(
      app.db,
      'codex-v115-acceptance',
      'V115_ACCEPTANCE_ZERO_CLI',
      'threads02',
      JSON.stringify(selection.counts),
    );
    await save({ cliZero: selection });
    await app.bot!.api.sendMessage(
      Number(owner),
      `Повторная проверка: новых задач ${selection.counts.created}, в обработке ${selection.counts.processing}, уже имеют черновик ${selection.counts.alreadyDrafted}. ${selection.reasons.join('; ')}. Дополнительного платного повтора нет`,
    );
  }
  if (phase === 'resumeLegacy' && !state.legacyResumedAt) {
    const id = '4f78157b9fcbac8467813d4e0ba02461';
    const task = await getDocument<any>(app.db, 'generation-task-' + id);
    assert(
      task?.status === 'FAILED' &&
        task.actor === owner &&
        task.force &&
        task.errorCode === 'LEGACY_SOURCE_NEEDS_REFRESH',
      'NO_SAFE_RESUME',
      'Only the explicitly requested regeneration rejected before LLM may resume',
    );
    await putDocument(app.db, 'v115-before-legacy-recovery-' + id, task);
    await putDocument(app.db, 'generation-task-' + id, {
      ...task,
      status: 'QUEUED',
      startedAt: undefined,
      finishedAt: undefined,
      error: undefined,
      errorCode: undefined,
      deliveredAt: undefined,
      deliveryMessageIds: undefined,
      deliveryError: undefined,
      deliveryRetryAt: undefined,
    });
    await save({ legacyResumedAt: new Date().toISOString(), legacyTask: id });
  }
  if (phase === 'cards' && !state.cardsSentAt) {
    await app.bot!.init(AbortSignal.timeout(20000) as any);
    const msg = await app.bot!.api.sendMessage(
      Number(owner),
      'V1.15: проверка генерации без публикации. Сначала открой сохранённого кандидата и нажми «Сгенерировать ответ»: уже готовый ответ должен появиться сразу, без нового запроса. Кнопка массовой подготовки показывает точные причины нуля. Реальные публикации в этой проверке не подтверждаем',
      {
        reply_markup: new InlineKeyboard()
          .text('Открыть кандидата', 'v18candidate:8ddbe8cd9277f61066dcaa83')
          .row()
          .text('Подготовить до 3 ответов', 'v18batch:threads02')
          .row()
          .text('Статус исходной задачи', 'v113status:c1fc7049bcf995a0e5316c3f49e476cf')
          .row()
          .text('Найти новые публикации', 'v18search:threads02'),
      },
    );
    await save({ cardsSentAt: new Date().toISOString(), messageId: msg.message_id });
  }
  if (phase === 'search' && !state.searchTask) {
    const t = await app.services.generation.enqueue(
      { kind: 'SEARCH', actor: owner, chatId: Number(owner), accountId: 'threads02' },
      'v115-hotfix-readonly',
    );
    await save({ searchTask: t.id });
  }
  const tasks = (await app.services.generation.list()).filter(
      (t) => !state.tasksBefore.includes(t.id),
    ),
    requests = (await app.db.list('aiRequest')).filter((r) => !state.aiBefore.includes(r.id));
  const selections = (await app.db.list('audit'))
    .filter((a) => a.action === 'REPLY_SELECTION' && a.createdAt.toISOString() >= state.startedAt)
    .map((a) => ({ actor: a.actor, at: a.createdAt, ...JSON.parse(a.detail) }));
  const after = await snapshot();
  for (const field of ['manual', 'factoryPaused', 'automationPaused', 'emergencyStop'] as const)
    assert(
      hashDocument(after[field]) === hashDocument(state.before[field]),
      'SAFETY_CHANGED',
      field,
    );
  for (const p of state.before.published)
    assert(
      hashDocument(after.published.find((r) => r.id === p.id)) === hashDocument(p),
      'PUBLISHED_CHANGED',
      p.id,
    );
  for (const c of state.before.comments)
    assert(
      hashDocument(after.comments.find((r) => r.id === c.id)) === hashDocument(c),
      'CTA_CHANGED',
      c.id,
    );
  const cards = await listDocuments<any>(app.db, 'manual-card-'),
    actions = await app.db.list('audit');
  const ownAction = (jobId: string) =>
    cards.find(
      (c) =>
        c.actor === owner &&
        c.used &&
        (c.resultId === jobId || c.ctaJobId === jobId) &&
        actions.some(
          (a) =>
            a.actor === owner &&
            a.action === 'TELEGRAM_ACTION' &&
            ['v112send:' + c.id, 'v113ctasend:' + c.id].includes(a.detail) &&
            a.createdAt.toISOString() >= state.startedAt,
        ),
    );
  const independentOwnPosts = after.published.filter(
    (p) => !state.before.published.some((b: any) => b.id === p.id),
  );
  for (const p of independentOwnPosts) {
    const row = (await app.db.get('post', p.id))!;
    assert(ownAction(row.jobId), 'UNATTRIBUTED_POST', 'Own post lacks owner confirmation');
  }
  const independentCtas = after.comments.filter(
    (c) => !state.before.comments.some((b: any) => b.id === c.id),
  );
  for (const c of independentCtas) {
    const row = (await app.db.get('post', c.postId))!;
    assert(ownAction(row.jobId), 'UNATTRIBUTED_CTA', 'CTA lacks owner confirmation');
  }
  for (const p of state.before.publishedReplies)
    assert(
      hashDocument(after.publishedReplies.find((r) => r.id === p.id)) === hashDocument(p),
      'PUBLISHED_REPLY_CHANGED',
      p.id,
    );
  const independentUserReplies = after.publishedReplies.filter(
    (p) => !state.before.publishedReplies.some((b: any) => b.id === p.id),
  );
  for (const p of independentUserReplies) {
    const job = (await app.services.engagement.jobs()).find((j) => j.id === p.id)!;
    const permission = await getDocument<any>(app.db, 'reply-permission-' + job.permissionId);
    const cards = await listDocuments<any>(app.db, 'manual-card-');
    const card = cards.find(
      (c) => c.actor === owner && c.used && c.resultId === permission?.id && c.hash === job.hash,
    );
    const action = (await app.db.list('audit')).find(
      (a) =>
        a.actor === owner &&
        a.action === 'TELEGRAM_ACTION' &&
        a.detail === 'v112send:' + card?.id &&
        a.createdAt.toISOString() >= state.startedAt,
    );
    assert(
      job.actor === owner && permission?.state === 'CONSUMED' && card && action,
      'UNATTRIBUTED_SEND',
      'A send not attributable to a genuine owner confirmation',
    );
  }
  if (phase === 'markA') {
    assert(
      selections.some((s) => s.actor === owner && s.counts.created === 3) &&
        selections.some(
          (s) => s.actor === owner && s.counts.created === 0 && s.counts.processing === 0,
        ),
      'REAL_BATCH_NOT_VERIFIED',
      'Need real three-item batch and terminal zero',
    );
    assert(
      tasks.filter((t) => t.kind === 'REPLY' && !t.force).length >= 3 &&
        tasks
          .filter((t) => t.kind === 'REPLY' && !t.force)
          .every((t) => ['COMPLETED', 'NEEDS_EDIT'].includes(t.status) && t.deliveredAt),
      'DELIVERY_NOT_VERIFIED',
      'Need completed and delivered reply results',
    );
    await putDocument(app.db, 'v115-generation-hotfix-verified', {
      passed: true,
      owner,
      at: new Date().toISOString(),
      telegramUserConfirmed: true,
      independentUserReplies,
    });
  }
  await save({
    checkedAt: new Date().toISOString(),
    tasks,
    requests: requests.map((r) => ({
      id: r.id,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
      status: r.status,
    })),
    selections,
    safetyUnchanged: true,
    independentUserReplies,
    independentOwnPosts,
    independentCtas,
    originalTask: await getDocument(app.db, 'generation-task-c1fc7049bcf995a0e5316c3f49e476cf'),
    search: state.searchTask
      ? await getDocument(app.db, 'generation-task-' + state.searchTask)
      : null,
    eligible: (await app.services.engagement.eligibleCandidates('threads02')).map((c) => ({
      id: c.id,
      url: c.url,
      text: c.text,
      extractionVersion: c.extractionVersion,
    })),
    generationState: await getDocument(app.db, 'reply-selection-threads02-' + owner),
  });
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v115-hotfix-acceptance.json',
    JSON.stringify(state, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      phase,
      startedAt: state.startedAt,
      cardsSentAt: state.cardsSentAt,
      originalTask: state.originalTask,
      tasks: tasks.map((t) => ({
        id: t.id,
        kind: t.kind,
        status: t.status,
        deliveredAt: t.deliveredAt,
        deliveryMessageIds: t.deliveryMessageIds,
        error: t.error,
      })),
      search: state.search,
      selections,
      requests: state.requests,
      eligible: state.eligible,
      safetyUnchanged: true,
    }),
  );
} finally {
  await app.close();
}
