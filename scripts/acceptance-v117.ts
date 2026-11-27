import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument, hashDocument } from '../src/db/documents.js';
import { assert } from '../src/core/errors.js';
import { audit } from '../src/db/database.js';
import { writeFile } from 'node:fs/promises';
import { InlineKeyboard } from '../src/bot/keyboard.js';
import { localTime, minutes } from '../src/autopilot/schedule.js';
import { autopilotCard } from '../src/bot/autopilot.js';
import { engagementSettings } from '../src/engagement/service.js';
const app = await createApplication(loadConfig({ ...process.env, PROCESS_ROLE: 'bot' })),
  s = app.services,
  key = 'v117-acceptance',
  id = 'threads02';
let state: any = (await getDocument(app.db, key)) ?? {};
const save = async (p: any) => {
  state = { ...state, ...p };
  await putDocument(app.db, key, state);
};
const snapshot = async () => ({
  posts: (await app.db.list('post')).map((x) => ({ id: x.id, url: x.url })),
  comments: await app.db.list('comment'),
  replies: (await s.engagement.jobs())
    .filter((j) => j.submittedAt)
    .map((j) => ({ id: j.id, url: j.url, status: j.status })),
  thread01: hashDocument(await app.db.get('account', 'threads01')),
});
try {
  const ap = await s.autopilotPolicy.settings(id),
    owner = ap.enabledBy!;
  assert(
    ap.state === 'RUNNING' && ap.mode === 'LIVE' && owner === '7842338078',
    'CONSENT_MISSING',
    'Нет активного согласия владельца AUTOPILOT LIVE',
  );
  const consent = (await app.db.list('audit'))
    .filter((a) => a.action === 'AUTOPILOT_START' && a.actor === owner && a.entityId === id)
    .at(-1);
  assert(
    consent &&
      JSON.parse(consent.detail).epoch === ap.epoch &&
      JSON.parse(consent.detail).mode === 'LIVE',
    'CONSENT_MISSING',
    'Не подтверждён текущий LIVE epoch',
  );
  const phase = process.env.V117_PHASE ?? 'prepare';
  if (!state.before)
    await save({
      startedAt: new Date().toISOString(),
      before: await snapshot(),
      epoch: ap.epoch,
      consentAuditId: consent.id,
      aiBefore: (await app.db.list('aiRequest')).map((r) => r.id),
    });
  if (phase === 'prepare' && !state.dryPassedAt) {
    // The deployment wrapper keeps ALL consumers stopped here. Only generation and explicit commit=false previews run.
    assert(
      process.env.V117_WORKER_STOPPED === '1',
      'MAINTENANCE_REQUIRED',
      'Нужна остановка publishing consumer для DRY_RUN',
    );
    const group = await s.autopilot.requestReplies(id, 3, owner, Date.now() + 8 * 60000);
    await save({ replySlotIds: group.map((x) => x.id) });
    for (let step = 0; step < 18; step++) {
      await s.autopilot.tick();
      const tasks = (await s.autopilotPolicy.works()).filter(
        (w) => w.accountId === id && w.epoch === ap.epoch && w.status === 'QUEUED',
      );
      for (const w of tasks) await s.autopilot.process(w.id); // Never dispatch AUTOPILOT_SEND_REPLY here.
      await s.autopilot.tick();
      const rows = await s.autopilot.schedule(id),
        p = rows.find((x) => x.kind === 'POST' && x.status === 'READY'),
        replies = group.map((g) => rows.find((x) => x.id === g.id)!);
      if (p && replies.every((x) => x.status === 'READY')) {
        await save({ postSlotId: p.id });
        break;
      }
      if (!tasks.length) break;
    }
    const rows = await s.autopilot.schedule(id),
      post = rows.find((x) => x.id === state.postSlotId);
    assert(
      post?.status === 'READY',
      'POST_NOT_READY',
      'Нет готового собственного поста; см. конкретные причины слотов',
    );
    const replies = state.replySlotIds.map((r: string) => rows.find((x) => x.id === r));
    assert(
      replies.every((r: any) => r?.status === 'READY'),
      'REPLIES_NOT_READY',
      'Не все три ответа готовы; причины сохранены в расписании',
    );
    const previews = [];
    previews.push(await s.autopilot.previewSlot(id, post.id));
    previews.push(await s.autopilot.previewSlot(id, replies[0].id));
    assert(
      hashDocument(await snapshot()) === hashDocument(state.before),
      'DRY_SUBMIT_DETECTED',
      'Во время репетиции изменились опубликованные записи',
    );
    await save({ dryPassedAt: new Date().toISOString(), previews });
    await audit(
      app.db,
      'codex-v117',
      'V117_DRY_PASSED',
      id,
      JSON.stringify({
        consentAuditId: consent.id,
        submit: false,
        slots: [post.id, ...state.replySlotIds],
      }),
    );
  }
  if (phase === 'arm' && !state.armedAt) {
    assert(state.dryPassedAt, 'DRY_FIRST', 'Сначала DRY_RUN');
    const postTime = Date.now() + 2 * 60000,
      baseReply = Math.max(
        Date.now() + 4 * 60000,
        ...(await s.autopilot.schedule(id))
          .filter((x) => state.replySlotIds.includes(x.id))
          .map(
            (x) =>
              Date.parse(x.at) -
              state.replySlotIds.indexOf(x.id) * ap.config.replyIntervalMinutes * 60000 +
              1000,
          ),
      );
    await s.autopilot.changeSlot(id, state.postSlotId, owner, 'move', postTime);
    // Approval/maintenance held the original deadlines. Explicitly replan the
    // reviewed group and only the unprepared suffix it displaces, once.
    const interval = ap.config.replyIntervalMinutes * 60000,
      moves = new Map<string, number>(
        state.replySlotIds.map((slotId: string, i: number) => [slotId, baseReply + i * interval]),
      ),
      remaining = (await s.autopilot.schedule(id)).filter(
        (x) =>
          x.kind === 'REPLY' &&
          x.localDate === localTime(baseReply, ap.config.timezone).day &&
          !state.replySlotIds.includes(x.id) &&
          x.status === 'PLANNED',
      );
    let last = baseReply + (state.replySlotIds.length - 1) * interval;
    for (const slot of remaining) {
      const when = Math.max(Date.parse(slot.at), last + interval);
      assert(
        localTime(when, ap.config.timezone).minute < minutes(ap.config.end),
        'WINDOW_CAPACITY',
        'Группа не помещается в окно',
      );
      if (when !== Date.parse(slot.at)) moves.set(slot.id, when);
      last = when;
    }
    for (const [slotId, when] of [...moves].sort((a, b) => b[1] - a[1]))
      await s.autopilot.changeSlot(id, slotId, owner, 'move', when);
    const slots = (await s.autopilot.schedule(id)).filter(
      (x) => x.id === state.postSlotId || state.replySlotIds.includes(x.id),
    );
    await save({ armedAt: new Date().toISOString(), planned: slots });
    await app.bot!.api.sendMessage(
      Number(owner),
      'V1.17: DRY_RUN завершён без submit. Проверяю реальный путь в рамках твоего действующего AUTOPILOT LIVE от ' +
        new Date(ap.enabledAt!).toLocaleString('ru-RU', { timeZone: ap.config.timezone }) +
        '\n' +
        slots
          .map(
            (x) =>
              `${x.kind} ${new Date(x.at).toLocaleTimeString('ru-RU', { timeZone: ap.config.timezone })} — READY`,
          )
          .join('\n') +
        '\nОтветы идут с интервалом ' +
        ap.config.replyIntervalMinutes +
        ' мин, не залпом. Повторная кнопка «3 ответа» показывает эту же группу',
      {
        reply_markup: new InlineKeyboard()
          .text('Расписание', `ap:schedule:${id}`)
          .text('Автопилот', `ap:home:${id}`)
          .row()
          .text('Сгенерировать и отправить 3 ответа', `ap:sendreplies:${id}:3`),
      },
    );
  }
  if (phase === 'dedup') {
    const before = (await s.autopilot.schedule(id)).filter((x) =>
        state.replySlotIds.includes(x.id),
      ),
      pending = before.filter((x) =>
        ['PLANNED', 'PREPARING', 'READY', 'PUBLISHING'].includes(x.status),
      );
    assert(
      pending.length > 0 && before.length === 3,
      'BATCH_STATE',
      'Нужна существующая активная группа',
    );
    const first = await s.autopilot.requestReplies(id, 3, owner),
      second = await s.autopilot.requestReplies(id, 3, owner),
      after = (await s.autopilot.schedule(id)).filter((x) => state.replySlotIds.includes(x.id));
    assert(
      hashDocument(first) === hashDocument(second) &&
        hashDocument(before) === hashDocument(after) &&
        first.every((x) => pending.some((p) => p.id === x.id)),
      'DUPLICATE_BATCH',
      'Повтор изменил группу',
    );
    await save({
      batchIdempotenceAt: new Date().toISOString(),
      repeatedBatchIds: first.map((x) => x.id),
    });
    console.log(
      JSON.stringify({
        batchIdempotent: true,
        pending: first.length,
        newJobs: 0,
        generated: 0,
        submit: false,
      }),
    );
  }
  if (phase === 'search-cap' && !state.searchCapacityAdjustedAt) {
    const watched = (await s.autopilot.schedule(id)).filter(
      (x) => x.id === state.postSlotId || state.replySlotIds.includes(x.id),
    );
    assert(
      watched.length === 4 && watched.every((x) => x.status === 'PUBLISHED' && x.permalink),
      'LIVE_TEST_FIRST',
      'Сначала завершить четыре одобренных отправки',
    );
    const old = await s.engagement.settings(id),
      sessions = Math.max(6, old.sessionsPerDay);
    if (sessions !== old.sessionsPerDay)
      await app.db.transaction(async (tx) => {
        await putDocument(
          tx,
          `engagement-config-${id}`,
          engagementSettings.parse({ ...old, sessionsPerDay: sessions }),
        );
        await audit(
          tx,
          'codex-v117',
          'V117_READONLY_SEARCH_LIMIT',
          id,
          JSON.stringify({
            from: old.sessionsPerDay,
            to: sessions,
            counterReset: false,
            budgetChanged: false,
          }),
        );
      });
    // A previously exhausted search is cached as unavailable for 30 minutes.
    // Queue one real READ_ONLY recovery search through the existing worker,
    // before reopening future slots. Never reset historical session counters.
    const recoveryId = hashDocument({ v117SearchCapacity: ap.epoch, account: id, sessions }).slice(
        0,
        28,
      ),
      now = new Date().toISOString();
    await s.autopilot.enqueueWork({
      id: recoveryId,
      accountId: id,
      epoch: ap.epoch,
      version: ap.version,
      enabledAt: ap.enabledAt!,
      createdAt: now,
      scheduledAt: now,
      kind: 'DISCOVER',
      mode: ap.mode,
      status: 'QUEUED',
    });
    const today = localTime(Date.now(), ap.config.timezone).day,
      key = `autopilot-plan-${id}-${ap.epoch}-${today}`,
      reopened = await app.db.transaction(async (tx) => {
        const plan: any = await getDocument(tx, key),
          ids: string[] = [];
        plan.slots = plan.slots.map((slot: any) => {
          if (
            slot.status !== 'SKIPPED' ||
            slot.kind !== 'REPLY' ||
            slot.publishingJobId ||
            slot.contentJobId ||
            Date.parse(slot.at) <= Date.now() ||
            !slot.failureReason?.startsWith('SEARCH_UNAVAILABLE: SEARCH_LIMIT')
          )
            return slot;
          ids.push(slot.id);
          return { ...slot, status: 'PLANNED', failureReason: undefined, notifiedAt: undefined };
        });
        await putDocument(tx, key, plan);
        await audit(
          tx,
          'codex-v117',
          'V117_SEARCH_CAPACITY_ADJUSTED',
          id,
          JSON.stringify({
            from: old.sessionsPerDay,
            to: sessions,
            reopened: ids,
            counterReset: false,
          }),
        );
        return ids;
      });
    await save({
      searchCapacityAdjustedAt: new Date().toISOString(),
      searchSessionsBefore: old.sessionsPerDay,
      searchSessionsAfter: sessions,
      reopenedSearchSlots: reopened,
      searchRecoveryWorkId: recoveryId,
    });
    console.log(
      JSON.stringify({
        searchCapacity: sessions,
        previous: old.sessionsPerDay,
        reopened,
        counterReset: false,
        submit: false,
      }),
    );
  }
  const all = await s.autopilot.schedule(id),
    watched = all.filter((x) => x.id === state.postSlotId || state.replySlotIds?.includes(x.id));
  if (phase === 'final' && !state.finalMessageAt) {
    assert(
      watched.length === 4 && watched.every((x) => x.status === 'PUBLISHED' && x.permalink),
      'LIVE_INCOMPLETE',
      'Нет четырёх подтверждённых отправок',
    );
    const sendAudits = (await app.db.list('audit')).filter(
      (x) => x.action === 'ENGAGEMENT_SEND_STARTED',
    );
    assert(
      watched
        .filter((x) => x.kind === 'REPLY')
        .every((x) => sendAudits.filter((a) => a.entityId === x.publishingJobId).length === 1),
      'DUPLICATE_SUBMIT',
      'У ответа не один send barrier',
    );
    const postJob = await app.db.get(
      'publishJob',
      watched.find((x) => x.kind === 'POST')!.publishingJobId!,
    );
    assert(
      postJob?.attempts === 1 && postJob.postStatus === 'PUBLISHED',
      'DUPLICATE_POST',
      'Проверить число попыток поста',
    );
    const card = await autopilotCard(s, id);
    await app.bot!.api.sendMessage(
      Number(owner),
      'V1.17: LIVE-проверка завершена — один пост и три ответа. Ссылки подтверждены, у каждого ответа один submit, интервалы не менее 30 минут\n' +
        watched.map((x) => x.kind + ' ' + x.permalink).join('\n') +
        '\n\n' +
        card.text,
      { reply_markup: card.reply_markup },
    );
    await save({ finalMessageAt: new Date().toISOString() });
  }
  await save({
    checkedAt: new Date().toISOString(),
    slots: all,
    watched,
    after: await snapshot(),
    requests: (await app.db.list('aiRequest'))
      .filter((r) => !state.aiBefore.includes(r.id))
      .map((r) => ({
        id: r.id,
        model: r.model,
        input: r.inputTokens,
        output: r.outputTokens,
        costUsd: r.costUsd,
        status: r.status,
      })),
  });
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v117-acceptance.json',
    JSON.stringify(state, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      phase,
      dryPassed: !!state.dryPassedAt,
      armed: !!state.armedAt,
      watched: watched.map((x) => ({
        id: x.id,
        kind: x.kind,
        status: x.status,
        at: x.at,
        url: x.permalink,
        publishedAt: x.publishedAt,
        reason: x.failureReason,
      })),
      requests: state.requests.length,
      costUsd: state.requests.reduce((n: number, r: any) => n + r.costUsd, 0),
    }),
  );
} catch (e) {
  await save({ error: e instanceof Error ? e.message : 'Ошибка' });
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v117-acceptance.json',
    JSON.stringify(state, null, 2),
    { mode: 0o600 },
  );
  throw e;
} finally {
  await app.close();
}
