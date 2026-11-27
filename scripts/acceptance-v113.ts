import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { postCard } from '../src/bot/manual-card.js';
import { sourceRights } from '../src/content/rights.js';
import { assert } from '../src/core/errors.js';
import { readFile, writeFile } from 'node:fs/promises';
import { InlineKeyboard } from 'grammy';
import type { GenerationTask } from '../src/content/jobs.js';
const config = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }),
  app = await createApplication(config),
  owner = config.TELEGRAM_OWNER_ID,
  key = 'v113-acceptance';
let state: any = (await getDocument(app.db, key)) ?? {};
const save = async (patch: object) => {
  state = { ...state, ...patch };
  await putDocument(app.db, key, state);
};
const original = '2c6ddd0c-b0f5-4071-9e8d-9847c4345802';
const wait = async (id: string) => {
  const end = Date.now() + 240000;
  while (Date.now() < end) {
    const t = await getDocument<GenerationTask>(app.db, `generation-task-${id}`);
    if (t && !['QUEUED', 'RUNNING'].includes(t.status) && t.deliveredAt) return t;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw Error('BOUNDED_WAIT_EXPIRED_NO_RETRY');
};
try {
  assert(
    config.BROWSER_EXECUTION_MODE === 'DRY_RUN' && config.ENGAGEMENT_EXECUTION_MODE === 'DRY_RUN',
    'UNSAFE',
    'Automatic modes must remain DRY_RUN',
  );
  if (!state.startedAt)
    await save({
      startedAt: new Date().toISOString(),
      postsBefore: (await app.db.list('post')).length,
      commentsBefore: (await app.db.list('comment')).length,
      manualBefore: await app.services.manual.settings('threads02'),
      aiBefore: (await app.db.list('aiRequest')).length,
      submittedBefore: (await app.services.engagement.jobs())
        .filter((j) => j.submittedAt)
        .map((j) => ({ id: j.id, at: j.submittedAt })),
    });
  await app.bot!.init();
  const phase = process.env.V113_PHASE;
  if (phase === 'verify') {
    if (!state.verifyTask || state.verifierVersion !== 2) {
      const t = await app.services.generation.enqueue(
        {
          kind: 'REPLY_VERIFY',
          replyJobId: original,
          accountId: 'threads02',
          actor: owner,
          chatId: Number(owner),
        },
        'v113-render-aware-verification',
      );
      await save({ previousVerifyTask: state.verifyTask, verifyTask: t.id, verifierVersion: 2 });
    }
    const t = await wait(state.verifyTask),
      view = await app.services.engagement.jobView(original);
    await save({
      verifiedReply: {
        taskStatus: t.status,
        status: view.job.status,
        url: view.job.url ?? null,
        submittedAt: view.job.submittedAt,
        confirmedAt: view.job.confirmedAt,
        error: t.error ?? null,
        deliveredAt: t.deliveredAt,
      },
    });
    const dom = JSON.parse(
      await readFile('/var/lib/content-factory/reports/KEEP-v113-readonly-reply-dom.json', 'utf8'),
    );
    const date = dom.source.times.find((t: any) => t.href === view.candidate.url)?.date;
    if (date) {
      await putDocument(app.db, `engagement-candidate-threads02-${view.candidate.id}`, {
        ...view.candidate,
        publishedAt: date,
        timestampConfidence: 'EXACT',
        feedSource: 'UNKNOWN',
      });
      await save({
        oldPostPublishedAt: date,
        oldPostAssessment: app.services.engagement.assess(
          { ...view.candidate, publishedAt: date, timestampConfidence: 'EXACT' },
          await app.services.engagement.settings('threads02'),
        ),
      });
    }
  }
  if (phase === 'feed') {
    if (!state.feedTask) {
      const t = await app.services.generation.enqueue(
        { kind: 'SEARCH', accountId: 'threads02', actor: owner, chatId: Number(owner) },
        'v113-feed-readonly',
      );
      await save({ feedTask: t.id });
    }
    const t = await wait(state.feedTask);
    await save({
      feed: {
        status: t.status,
        error: t.error ?? null,
        metrics: t.metrics,
        deliveredAt: t.deliveredAt,
      },
    });
  }
  if (phase === 'dry' && !state.dryResult) {
    let job = (await app.services.engagement.jobs('threads02')).find(
      (j) =>
        j.kind === 'REPLY' && ['QUEUED', 'PREVIEWED'].includes(j.status) && /^\d+$/.test(j.actor),
    );
    let internal = false;
    if (!job) {
      const c = (await app.services.engagement.eligibleCandidates('threads02'))[0];
      if (c) {
        const d = await app.services.engagement.edit(
          'threads02',
          c.id,
          'план проще соблюдать, когда риск определён заранее',
          'v113-readonly-check',
        );
        job = await app.services.engagement.approve(
          'threads02',
          d.id,
          d.hash,
          'v113-readonly-check',
        );
        internal = true;
      }
    }
    if (job) {
      const start = Date.now();
      try {
        const result = await app.services.engagementQueue.execute(job.id, true);
        await save({
          dryResult: {
            jobId: job.id,
            status: result.status,
            dryRunAt: result.dryRunAt,
            actuallyExecuted:
              result.status === 'PREVIEWED' &&
              !!result.dryRunAt &&
              Date.parse(result.dryRunAt) >= start,
            submittedAt: result.submittedAt ?? null,
          },
        });
      } catch (e) {
        await save({
          dryResult: {
            jobId: job.id,
            error: e instanceof Error ? e.message : 'FAILED',
            actuallyExecuted: false,
          },
        });
      } finally {
        if (internal) {
          const v = await app.services.engagement.jobView(job.id);
          if (!v.job.submittedAt)
            await app.services.engagement.reject('threads02', v.draft!.id, 'v113-readonly-check');
        }
      }
    } else
      await save({
        dryResult: {
          actuallyExecuted: false,
          reason: 'Нет доступного ожидающего ответа и свежего подходящего кандидата',
        },
      });
  }
  if (phase === 'cleanup' && state.dryResult?.jobId) {
    const v = await app.services.engagement.jobView(state.dryResult.jobId);
    const events = await app.db.list('audit', { entityId: v.draft!.id });
    const last = events
      .filter((e) => e.action === 'ENGAGEMENT_REJECTED')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .at(-1);
    if (
      v.job.actor === 'v113-readonly-check' &&
      last?.actor === 'v113-readonly-check' &&
      v.candidate.status === 'REJECTED' &&
      !v.candidate.rejectionReasons?.includes('Пропущен пользователем')
    ) {
      await putDocument(app.db, `engagement-candidate-threads02-${v.candidate.id}`, {
        ...v.candidate,
        status: 'NEW',
      });
      await save({ testCandidateRestored: v.candidate.id });
    }
  }
  if (phase === 'cards' && !state.cardsSent) {
    await app.bot!.api.sendMessage(
      Number(owner),
      'V1.13: поиск в ленте с проверкой свежести, происхождение исходника и статусы отправки обновлены. Новых LIVE-отправок тесты не выполняют',
      {
        reply_markup: new InlineKeyboard()
          .text('Поиск публикаций', 'v113discovery:threads02')
          .row()
          .text('Свежесть публикаций', 'v113age:threads02'),
      },
    );
    const g = (await app.db.list('generated', { accountId: 'threads02' })).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];
    if (g) {
      const card = await postCard(app.services, g.id, owner);
      await app.bot!.api.sendMessage(Number(owner), card.text, { reply_markup: card.reply_markup });
      await save({
        previewId: g.id,
        sourceId: g.sourceId,
        sourceRights: await sourceRights(app.db, g.sourceId),
      });
    }
    await save({ cardsSent: true });
  }
  const ai = await app.db.list('aiRequest'),
    jobs = await app.services.engagement.jobs();
  const submittedAfter = jobs
    .filter((j) => j.submittedAt)
    .map((j) => ({ id: j.id, at: j.submittedAt }));
  const candidates = await app.services.engagement.candidates('threads02'),
    settings = await app.services.engagement.settings('threads02');
  const report = {
    ...state,
    manualAfter: await app.services.manual.settings('threads02'),
    settings,
    posts: (await app.db.list('post')).length,
    comments: (await app.db.list('comment')).length,
    submittedAfter,
    eligible: (await app.services.engagement.eligibleCandidates('threads02')).map((c) => ({
      url: c.url,
      author: c.author,
      publishedAt: c.publishedAt,
      ageHours: app.services.engagement.assess(c, settings).ageHours,
      feedSource: c.feedSource,
      score: c.tradingRelevanceScore,
    })),
    candidatesTotal: candidates.length,
    aiRequests: ai.length,
    aiTotalUsd: ai.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    ownSourceRights: state.sourceId ? await sourceRights(app.db, state.sourceId) : null,
  };
  const userPosts = (await app.db.list('post')).filter(
    (p) => p.createdAt.getTime() >= Date.parse(state.startedAt),
  );
  const userJobs = [];
  for (const p of userPosts) {
    const j = (await app.db.get('publishJob', p.jobId))!;
    const grant = await getDocument<any>(app.db, `manual-post-${j.id}`);
    const cards = (await app.db.list('setting'))
      .filter((r) => r.id.startsWith('manual-card-'))
      .map((r) => JSON.parse(r.value));
    const card = cards.find((c) => c.resultId === j.id && c.used && c.actor === owner);
    assert(
      grant?.actor === owner && card,
      'UNAUTHORIZED_POST',
      'New own post must have an explicit owner card',
    );
    userJobs.push({
      jobId: j.id,
      url: p.url,
      commentStatus: j.commentStatus,
      authorizedByOwner: owner,
    });
  }
  const userComments = (await app.db.list('comment')).filter((c) =>
    userPosts.some((p) => p.id === c.postId),
  );
  Object.assign(report, { userInitiatedPublications: userJobs });
  assert(
    report.posts === state.postsBefore + userPosts.length &&
      report.comments === state.commentsBefore + userComments.length &&
      JSON.stringify(submittedAfter) === JSON.stringify(state.submittedBefore),
    'NEW_SUBMIT',
    'No automatic extra submissions allowed',
  );
  assert(
    JSON.stringify(report.manualAfter) === JSON.stringify(state.manualBefore),
    'MODE_CHANGED',
    'Manual policy must be preserved',
  );
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v113-acceptance.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      phase,
      verifiedReply: report.verifiedReply,
      feed: report.feed,
      dryResult: report.dryResult,
      cardsSent: report.cardsSent,
      eligible: report.eligible,
      aiRequests: report.aiRequests,
      aiTotalUsd: report.aiTotalUsd,
      manualLiveEnabled: report.manualAfter.manualLiveEnabled,
    }),
  );
} finally {
  await app.close();
}
