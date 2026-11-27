/** One bounded, non-publishing experiment. Real work runs in the existing worker. */
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument, hashDocument } from '../src/db/documents.js';
import { assert, AppError } from '../src/core/errors.js';
import { writeFile } from 'node:fs/promises';
import { InlineKeyboard } from 'grammy';
const cfg = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }),
  app = await createApplication(cfg),
  owner = cfg.TELEGRAM_OWNER_ID,
  key = 'v115-model-ab-acceptance';
let state: any = (await getDocument(app.db, key)) ?? {};
const save = async (v: object) => {
  state = { ...state, ...v };
  await putDocument(app.db, key, state);
};
const safety = async () => ({
  manual: await app.services.manual.settings('threads02'),
  factoryPaused: await getDocument(app.db, 'factoryPaused'),
  automationPaused: await getDocument(app.db, 'automationPaused'),
  emergencyStop: await getDocument(app.db, 'emergencyStop'),
  posts: await Promise.all(
    (await app.db.list('post')).map(async (p) => ({
      id: p.id,
      url: p.url,
      text: (await app.db.get('generated', p.generatedId))!.text,
    })),
  ),
  comments: await app.db.list('comment'),
  replies: await Promise.all(
    (await app.services.engagement.jobs())
      .filter((j) => j.submittedAt)
      .map(async (j) => ({
        id: j.id,
        status: j.status,
        url: j.url,
        text: j.draftId ? (await app.services.engagement.draft(j.accountId, j.draftId)).text : null,
      })),
  ),
  replyModel: cfg.REPLY_MODEL,
  postModel: cfg.POST_MODEL,
});
try {
  assert(
    (await getDocument<any>(app.db, 'v115-generation-hotfix-verified'))?.passed,
    'HOTFIX_FIRST',
    'Part A must pass before experiment',
  );
  assert(
    cfg.BROWSER_EXECUTION_MODE === 'DRY_RUN' && cfg.ENGAGEMENT_EXECUTION_MODE === 'DRY_RUN',
    'SAFETY',
    'Automatic modes must remain DRY_RUN',
  );
  if (!state.startedAt) await save({ startedAt: new Date().toISOString(), before: await safety() });
  const phase = process.env.V115_PHASE ?? 'sample';
  if (phase === 'sample' && !state.sampleAttemptedAt) {
    // Existing daily session limit is respected; never widen the age or relevance filter.
    await save({ sampleAttemptedAt: new Date().toISOString() });
    try {
      const metrics = await app.services.engagement.search('threads02', owner, {
        manual: true,
        targetCandidates: 20,
        viewLimit: 100,
      });
      await save({ discovery: metrics });
    } catch (e) {
      await save({
        discoveryError:
          e instanceof AppError
            ? { code: e.code, message: e.message }
            : { code: 'DISCOVERY_FAILED' },
      });
    }
  }
  if (phase === 'prepare' && !state.experimentId) {
    const e = await app.services.quality.createExperiment(
      'threads02',
      owner,
      await app.services.engagement.candidates('threads02'),
      await app.services.engagement.settings('threads02'),
    );
    const t = await app.services.generation.enqueue(
      {
        kind: 'MODEL_AB',
        experimentId: e.id,
        actor: owner,
        chatId: Number(owner),
        accountId: 'threads02',
      },
      'v115-sol-terra-once',
    );
    await save({ experimentId: e.id, taskId: t.id, pairs: e.pairs.length });
  }
  const experiment = state.experimentId
    ? await app.services.quality.experiment(state.experimentId)
    : null;
  const stats = state.experimentId
    ? await app.services.quality.experimentStats(state.experimentId)
    : null;
  const task = state.taskId
    ? await getDocument<any>(app.db, 'generation-task-' + state.taskId)
    : null;
  const scope = state.experimentId
    ? await getDocument<any>(app.db, 'llm-scope-' + state.experimentId)
    : null;
  const ids = new Set((scope?.entries ?? []).map((e: any) => e.requestId)),
    requests = (await app.db.list('aiRequest')).filter((r) => ids.has(r.id));
  const spent = requests.reduce(
    (s, r) => s + (['RESERVED', 'UNKNOWN'].includes(r.status) ? r.reservedUsd : r.costUsd),
    0,
  );
  assert(requests.length <= 40 && spent <= 0.25, 'AB_BUDGET_BROKEN', 'Experiment exceeds cap');
  assert(
    hashDocument(await safety()) === hashDocument(state.before),
    'EXPERIMENT_SAFETY_CHANGED',
    'Publishing/model/permissions changed during experiment',
  );
  if (
    phase === 'notify' &&
    experiment &&
    ['READY', 'STOPPED'].includes(experiment.status) &&
    !state.notifiedAt
  ) {
    await app.bot!.api.sendMessage(
      Number(owner),
      `Sol vs Terra: подготовлено ${experiment.pairs.length} пар из запрошенных 20\nПлатных запросов: ${requests.length}, расход $${requests.reduce((s, r) => s + r.costUsd, 0).toFixed(6)}\n${state.discoveryError ? 'Поиск ограничен: ' + state.discoveryError.message : 'Выборка отобрана из свежей ленты'}\nМодели скрыты под A/B, оценки сохраняются отдельно. Настройки production и права публикации не менялись`,
      {
        reply_markup: new InlineKeyboard()
          .text('Начать слепое сравнение', `v115abopen:${experiment.id}`)
          .row()
          .text('Тест моделей', 'v115abmenu'),
      },
    );
    await save({ notifiedAt: new Date().toISOString() });
  }
  await save({
    checkedAt: new Date().toISOString(),
    experiment,
    stats,
    task,
    requests: requests.map((r) => ({
      id: r.id,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      reasoningTokens: r.reasoningTokens,
      costUsd: r.costUsd,
      status: r.status,
    })),
    reservedAndSpentUsd: spent,
    safetyUnchanged: true,
  });
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v115-model-ab.json',
    JSON.stringify(state, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      phase,
      experiment: experiment
        ? { id: experiment.id, status: experiment.status, pairs: experiment.pairs.length }
        : null,
      task: task
        ? { id: task.id, status: task.status, deliveredAt: task.deliveredAt, error: task.error }
        : null,
      requests: requests.length,
      costUsd: stats?.costUsd,
      rated: stats?.rated,
      discovery: state.discovery,
      discoveryError: state.discoveryError,
      safetyUnchanged: true,
    }),
  );
} finally {
  await app.close();
}
