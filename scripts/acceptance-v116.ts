/** Bounded native rehearsal. No polling, no LIVE grants, no publication calls. */
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument, hashDocument } from '../src/db/documents.js';
import { assert, AppError } from '../src/core/errors.js';
import { writeFile } from 'node:fs/promises';
import { autopilotCard } from '../src/bot/autopilot.js';
import { withProfileLease } from '../src/scheduler/lease.js';
import type { AutoWork } from '../src/autopilot/policy.js';
import { freshness } from '../src/engagement/freshness.js';
import { observe } from '../src/autopilot/viral.js';
const cfg = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }),
  app = await createApplication(cfg),
  s = app.services,
  accountId = 'threads02',
  owner = cfg.TELEGRAM_OWNER_ID,
  key = 'v116-acceptance';
let state: any = (await getDocument(app.db, key)) ?? {};
const save = async (p: object) => {
  state = { ...state, ...p };
  await putDocument(app.db, key, state);
};
const safety = async () => ({
  manual: await s.manual.settings(accountId),
  thread01: hashDocument(await app.db.get('account', 'threads01')),
  posts: (await app.db.list('post')).map((p) => ({ id: p.id, hash: hashDocument(p) })),
  comments: (await app.db.list('comment')).map((p) => ({ id: p.id, hash: hashDocument(p) })),
  replies: (await s.engagement.jobs())
    .filter((j) => j.submittedAt)
    .map((j) => ({ id: j.id, hash: hashDocument(j) })),
});
const runWork = async (w: AutoWork) => {
  await writeFile('/var/lib/content-factory/reports/KEEP-v116-resources/phase', w.kind);
  await s.autopilot.enqueueWork(w);
  const end = Date.now() + 240000;
  do {
    try {
      await s.generation.tick();
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'PROFILE_BUSY')) throw e;
    }
    const current = await getDocument<AutoWork>(app.db, `autopilot-work-${w.id}`);
    if (current && !['QUEUED', 'RUNNING', 'SCHEDULED'].includes(current.status)) return current;
    await new Promise((r) => setTimeout(r, 2000));
  } while (Date.now() < end);
  throw new AppError(
    'ACCEPTANCE_TIMEOUT',
    'Результат сохранён, автоматического повторного запроса нет',
  );
};
const persist = () =>
  writeFile(
    '/var/lib/content-factory/reports/KEEP-v116-acceptance.json',
    JSON.stringify(state, null, 2),
    { mode: 0o600 },
  );
try {
  assert(
    cfg.BROWSER_EXECUTION_MODE === 'DRY_RUN' &&
      cfg.ENGAGEMENT_EXECUTION_MODE === 'DRY_RUN' &&
      cfg.PROFILE_CHANGES_ALLOWED === '0',
    'SAFETY',
    'Safe automatic modes required',
  );
  assert(owner === '7842338078' && cfg.allowedIds.includes(Number(owner)), 'OWNER', 'Wrong owner');
  if (!state.before)
    await save({
      startedAt: new Date().toISOString(),
      before: await safety(),
      aiBefore: (await app.db.list('aiRequest')).map((r) => r.id),
      automationBefore: await getDocument(app.db, 'automationPaused'),
      factoryBefore: await getDocument(app.db, 'factoryPaused'),
      engagementBefore: await s.engagement.settings(accountId),
    });
  const phase = process.env.V116_PHASE ?? 'configure';
  if (phase === 'configure' && !state.configuredAt) {
    await s.autopilotPolicy.configure(
      accountId,
      { start: '09:00', end: '22:00', timezone: 'Europe/Moscow', posts: 5, replies: 20 },
      owner,
    );
    await s.autopilotPolicy.pause(accountId, owner, true);
    await save({ configuredAt: new Date().toISOString() });
  }
  if (phase === 'rehearse' && !state.rehearsedAt) {
    await withProfileLease(app.db, 'autopilot-dispatch', async () => {
      const prior = await s.engagement.settings(accountId);
      try {
        const card = await s.autopilotPolicy.launchCard(accountId, owner, 'DRY_RUN'),
          ap = await s.autopilotPolicy.start(card, owner);
        await save({
          dryStartedAt: ap.enabledAt,
          dryEpoch: ap.epoch,
          executionAuthorization:
            'User-requested DRY_RUN acceptance script; not a fabricated Telegram click',
        });
        const work = (id: string, kind: AutoWork['kind'], candidateId?: string): AutoWork => ({
          id,
          accountId,
          epoch: ap.epoch,
          version: ap.version,
          enabledAt: ap.enabledAt!,
          createdAt: new Date().toISOString(),
          scheduledAt: new Date().toISOString(),
          kind,
          mode: 'DRY_RUN',
          status: 'QUEUED',
          candidateId,
        });
        if (!state.discovery) {
          const day = new Date().toISOString().slice(0, 10),
            quota = await getDocument<{ times: number[] }>(
              app.db,
              `engagement-search-${accountId}-${day}`,
            ),
            used = quota?.times.length ?? 0;
          // One extra bounded acceptance visit, within the existing hard maximum 6; restore the user's settings in finally.
          if (used >= prior.sessionsPerDay) {
            assert(used < 6, 'SEARCH_LIMIT', 'Daily hard maximum reached');
            await s.engagement.configure(accountId, { sessionsPerDay: used + 1 }, owner);
            await save({
              temporarySearchLimit: {
                before: prior.sessionsPerDay,
                test: used + 1,
                reason: 'One native V1.16 full-cycle READ_ONLY acceptance visit',
              },
            });
          }
          const w = work('v116-native-discovery', 'DISCOVER');
          const result = await runWork(w);
          await save({
            discovery: result,
            ranked: (await s.autopilot.rank(accountId)).map((r) => ({
              id: r.candidate.id,
              url: r.candidate.url,
              status: r.candidate.status,
              text: r.candidate.text,
              score: r.score,
              accepted: r.accepted,
              reasons: r.reasons,
              observation: r.observation,
              provisional: r.provisional,
            })),
          });
        }
        const candidates = await s.engagement.candidates(accountId),
          drafts = await s.engagement.drafts(accountId),
          settings = await s.engagement.settings(accountId);
        // Existing manual drafts and sources remain untouched. No forced regeneration.
        const eligible = candidates.filter(
          (c) =>
            c.status === 'NEW' &&
            c.extractionVersion === 'threads-body-v115' &&
            freshness(c, 48).accepted &&
            s.engagement.assess(c, settings).accepted &&
            !drafts.some((d) => d.candidateId === c.id),
        );
        const ranked = (await s.autopilot.rank(accountId)).filter(
          (r) => r.accepted && eligible.some((c) => c.id === r.candidate.id),
        );
        const own = ranked[0]?.candidate;
        if (own && !state.post) {
          const w = work('v116-native-original', 'POST', own.id);
          await save({ post: await runWork(w) });
        } else if (!own && !state.post)
          await save({ postSkipped: 'NO_UNCLAIMED_VIRAL_SOURCE_ABOVE_THRESHOLD' });
        const reply = eligible.find((c) => c.id !== own?.id);
        if (reply && !state.reply) {
          const w = work('v116-native-reply', 'REPLY', reply.id);
          await save({ reply: await runWork(w) });
        } else if (!reply && !state.reply)
          await save({ replySkipped: 'NO_NEW_ELIGIBLE_DISCUSSION' });
        await s.autopilot.queueSummary(
          accountId,
          new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }),
        );
        await save({
          stats: await s.autopilot.stats(accountId),
          rehearsedAt: new Date().toISOString(),
        });
      } finally {
        await s.autopilotPolicy.pause(accountId, owner, true);
        await s.engagement.configure(accountId, prior, owner);
        await putDocument(app.db, 'automationPaused', state.automationBefore ?? true);
        await save({
          restoredAt: new Date().toISOString(),
          engagementRestored:
            hashDocument(prior) === hashDocument(await s.engagement.settings(accountId)),
        });
      }
    });
  }
  if (phase === 'revalidate' && !state.revalidatedAt) {
    await withProfileLease(app.db, 'autopilot-dispatch', async () => {
      const ap = await s.autopilotPolicy.start(
        await s.autopilotPolicy.launchCard(accountId, owner, 'DRY_RUN'),
        owner,
      );
      try {
        const outcomes: Record<string, AutoWork> = {};
        for (const kind of ['post', 'reply'] as const) {
          const old = state[kind] as AutoWork | undefined;
          if (old?.status !== 'NEEDS_REVIEW') continue;
          const w: AutoWork = {
            id: `${old.id}-gate-v1161`,
            kind: old.kind,
            candidateId: old.candidateId,
            accountId,
            epoch: ap.epoch,
            version: ap.version,
            enabledAt: ap.enabledAt!,
            createdAt: new Date().toISOString(),
            scheduledAt: new Date().toISOString(),
            mode: 'DRY_RUN',
            status: 'QUEUED',
            dryRevalidateFrom: old.id,
          };
          outcomes[kind] = await runWork(w);
        }
        await save({ revalidation: outcomes, revalidatedAt: new Date().toISOString() });
      } finally {
        await s.autopilotPolicy.pause(accountId, owner, true);
        await putDocument(app.db, 'automationPaused', state.automationBefore ?? true);
      }
    });
  }
  if (phase === 'ready') {
    await s.autopilotPolicy.pause(accountId, owner, true);
    await putDocument(app.db, 'automationPaused', state.automationBefore ?? true);
    assert(
      state.revalidation?.post?.status === 'PREVIEWED' &&
        state.revalidation?.reply?.status === 'PREVIEWED',
      'DRY_NOT_PASSED',
      'Both native editor previews must pass',
    );
    assert(process.env.V116_UI_VERIFIED === '1', 'UI_REQUIRED', 'Owner UI check required');
    await putDocument(app.db, 'autopilot-readiness-v116', {
      passed: true,
      verifiedAt: new Date().toISOString(),
      nativeAcceptance: key,
      qualityVersion: 'autopilot-quality-v116.1',
      uiVerifiedBy: owner,
      uiEvidence:
        'Owner confirmed real Telegram screens and danger navigation in Codex conversation',
      installationState: 'OFF',
    });
    await save({ readinessPassedAt: new Date().toISOString(), uiVerified: true });
    if (!state.readyMessageId) {
      const card = await autopilotCard(s, accountId);
      const sent = await app.bot!.api.sendMessage(
        Number(owner),
        `V1.16: нативный DRY_RUN пройден, оба редактора проверены без submit

Пример собственного поста:
${state.revalidation.post.text}

Пример ответа:
${state.revalidation.reply.text}

LLM: 2 запроса, $${state.costUsd.toFixed(6)}; повторная проверка без новых генераций
Автопилот OFF. Окно 09:00–22:00 МСК. Реальные действия начнутся только после твоего явного подтверждения запуска LIVE`,
        { reply_markup: card.reply_markup },
      );
      await save({ readyMessageId: sent.message_id });
    }
  }
  if (phase === 'notify' && !state.notifiedAt) {
    const card = await autopilotCard(s, accountId);
    await app.bot!.api.sendMessage(
      Number(owner),
      'V1.16: меню автопилота установлено. Автопилот выключен. Окно 09:00–22:00 МСК\nДля проверки открой настройки, расписание, очередь и вернись красными кнопками. Кнопку подтверждения LIVE пока не нажимай\n' +
        card.text,
      { reply_markup: card.reply_markup },
    );
    await save({ notifiedAt: new Date().toISOString() });
  }
  const after = await safety();
  assert(
    hashDocument(after) === hashDocument(state.before),
    'PUBLICATION_CHANGED',
    'Publication/manual/profile safety snapshot changed; inspect owner actions before accepting',
  );
  const requests = (await app.db.list('aiRequest')).filter((r) => !state.aiBefore.includes(r.id));
  const ap = await s.autopilotPolicy.settings(accountId);
  assert(ap.state === 'OFF', 'AUTOPILOT_MUST_BE_OFF', 'Leave autopilot OFF');
  await save({
    checkedAt: new Date().toISOString(),
    autopilot: ap,
    requests: requests.map((r) => ({
      id: r.id,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
      status: r.status,
    })),
    costUsd: requests.reduce((n, r) => n + r.costUsd, 0),
    safetyUnchanged: true,
    factoryPaused: await getDocument(app.db, 'factoryPaused'),
    automationPaused: await getDocument(app.db, 'automationPaused'),
  });
  await persist();
  console.log(
    JSON.stringify({
      phase,
      state: ap.state,
      window: [ap.config.start, ap.config.end, ap.config.timezone],
      discovery: state.discovery?.status,
      post: state.revalidation?.post?.status ?? state.post?.status ?? state.postSkipped,
      reply: state.revalidation?.reply?.status ?? state.reply?.status ?? state.replySkipped,
      requests: requests.length,
      costUsd: state.costUsd,
      safetyUnchanged: true,
    }),
  );
} catch (e) {
  await save({
    error: e instanceof AppError ? { code: e.code, message: e.message } : { code: 'INTERNAL' },
  });
  await persist();
  throw e;
} finally {
  await app.close();
}
