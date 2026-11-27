/** One bounded retry of the approved first reply, verified never submitted; no generation. */
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument, hashDocument } from '../src/db/documents.js';
import { audit } from '../src/db/database.js';
import { assert } from '../src/core/errors.js';
import { localTime, minutes } from '../src/autopilot/schedule.js';
const app = await createApplication(loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }));
try {
  assert(process.env.V117_WORKER_STOPPED === '1', 'MAINTENANCE', 'Consumers must be stopped');
  const s = app.services,
    a: any = await getDocument(app.db, 'v117-acceptance'),
    ap = await s.autopilotPolicy.settings('threads02'),
    slots = await s.autopilot.schedule('threads02'),
    first = slots.find((x) => x.id === a.replySlotIds[0])!,
    v = await s.engagement.jobView(first.publishingJobId!);
  assert(
    ap.state === 'RUNNING' && ap.epoch === a.epoch && a.liveApprovedAt && !a.replyRecoveryAt,
    'SCOPE',
    'One retry under existing consent only',
  );
  assert(
    v.job.status === 'FAILED' &&
      !v.job.submittedAt &&
      hashDocument(v.draft!.text) === hashDocument(a.prepared[1].text),
    'ALREADY_STARTED',
    'Never retry submitted or changed text',
  );
  const interval = ap.config.replyIntervalMinutes * 60000,
    start = Date.now() + 60000,
    moves = new Map<string, number>(
      a.replySlotIds.map((id: string, i: number) => [id, start + i * interval]),
    );
  let last = start + (a.replySlotIds.length - 1) * interval;
  for (const slot of slots.filter(
    (x) =>
      x.kind === 'REPLY' &&
      x.localDate === first.localDate &&
      !a.replySlotIds.includes(x.id) &&
      x.status === 'PLANNED',
  )) {
    const when = Math.max(Date.parse(slot.at), last + interval);
    assert(
      localTime(when, ap.config.timezone).minute < minutes(ap.config.end),
      'WINDOW_CAPACITY',
      'Window full',
    );
    if (when !== Date.parse(slot.at)) moves.set(slot.id, when);
    last = when;
  }
  for (const [id, when] of [...moves].sort((a, b) => b[1] - a[1]))
    await s.autopilot.changeSlot('threads02', id, ap.enabledBy!, 'move', when);
  await app.db.transaction(async (tx) => {
    const current = (await s.engagement.jobView(v.job.id)).job;
    assert(
      !current.submittedAt && current.status === 'FAILED',
      'ALREADY_STARTED',
      'No repeat after submit',
    );
    await putDocument(tx, `engagement-job-${v.job.id}`, {
      ...current,
      status: 'QUEUED',
      phase: 'QUEUED',
      executionStatus: 'WAITING',
      error: undefined,
    });
    const p: any = await getDocument(tx, first.scheduleId);
    p.slots = p.slots.map((x: any) =>
      x.id === first.id
        ? { ...x, status: 'READY', failureReason: undefined, notifiedAt: undefined }
        : x,
    );
    await putDocument(tx, first.scheduleId, p);
    for (const task of await s.generation.list())
      if (
        task.kind === 'AUTOPILOT_SEND_REPLY' &&
        task.autoWorkId === first.contentJobId &&
        task.status === 'FAILED'
      )
        await putDocument(tx, `generation-task-${task.id}`, {
          ...task,
          status: 'QUEUED',
          error: undefined,
          errorCode: undefined,
          deliveredAt: undefined,
          finishedAt: undefined,
        });
    await audit(
      tx,
      'codex-v117',
      'V117_UNSENT_REPLY_RECOVERY',
      v.job.id,
      JSON.stringify({
        previous: v.job,
        scope: 'same approved text; full queue hard DRY passed; zero submit',
      }),
    );
    await putDocument(tx, 'v117-acceptance', { ...a, replyRecoveryAt: new Date().toISOString() });
  });
  const watched = (await s.autopilot.schedule('threads02')).filter((x) =>
    a.replySlotIds.includes(x.id),
  );
  await app.bot!.api.sendMessage(
    7842338078,
    'V1.17: первый ответ остановился ДО submit. Полная репетиция очереди с закрытым барьером пройдена. Одобренные ответы перенесены, новых генераций нет\n' +
      watched
        .map(
          (x) =>
            new Date(x.at).toLocaleTimeString('ru-RU', { timeZone: ap.config.timezone }) +
            ' — ' +
            x.status,
        )
        .join('\n'),
  );
  console.log(JSON.stringify({ recovery: 'one unsent approved job', watched }));
} finally {
  await app.close();
}
