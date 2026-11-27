/** Read-only preflight and a browser rehearsal with a throwing barrier, never a click. */
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument } from '../src/db/documents.js';
import { assert } from '../src/core/errors.js';
import { checkReply } from '../src/engagement/reply-style.js';
const app = await createApplication(loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }));
try {
  const s = app.services,
    a: any = await getDocument(app.db, 'v117-acceptance'),
    slot = (await s.autopilot.schedule('threads02')).find((x) => x.id === a.replySlotIds[0])!,
    v = await s.engagement.jobView(slot.publishingJobId!),
    voice = await s.engagement.settings('threads02');
  console.log(
    JSON.stringify({
      step: 'preflight',
      length: voice.replyLength,
      assessment: s.engagement.assess(v.candidate, voice),
      check: checkReply(v.draft!.text, v.candidate.text, voice.replyLength, voice),
    }),
  );
  console.log(
    JSON.stringify({
      step: 'scope',
      grant: !!(await s.autopilotPolicy.validate(v.job.id, 'REPLY')),
    }),
  );
  const jobs = await app.db.list('publishJob');
  console.log(
    JSON.stringify({
      step: 'priority',
      urgent: jobs
        .filter(
          (j) =>
            j.status === 'RUNNING' ||
            (j.status === 'QUEUED' && j.scheduledAt.getTime() <= Date.now() + 60000),
        )
        .map((j) => j.id),
    }),
  );
  const sentinel = new Error('V117_HARD_DRY_BARRIER');
  let reached = false;
  if (process.env.V117_FULL_QUEUE_DRY === '1') {
    assert(
      process.env.V117_WORKER_STOPPED === '1' && !v.job.submittedAt && v.job.status === 'FAILED',
      'SAFETY',
      'Only unsent failed job with consumers stopped',
    );
    const ap = await s.autopilotPolicy.settings('threads02'),
      original = s.engagement.port.reply.bind(s.engagement.port);
    try {
      await putDocument(app.db, `engagement-job-${v.job.id}`, {
        ...v.job,
        status: 'QUEUED',
        phase: 'QUEUED',
        executionStatus: 'WAITING',
      });
      s.engagement.port.reply = async (job, draft, candidate, _commit, _barrier, progress) =>
        original(
          job,
          draft,
          candidate,
          true,
          async () => {
            reached = true;
            throw sentinel;
          },
          progress,
        );
      await s.engagementQueue.execute(v.job.id, false, { autopilot: true, actor: ap.enabledBy! });
    } catch (e) {
      if (e !== sentinel) throw e;
    } finally {
      const current = (await s.engagement.jobView(v.job.id)).job;
      assert(!current.submittedAt, 'UNEXPECTED_SUBMIT', 'Hard barrier was crossed');
      await putDocument(app.db, `engagement-job-${v.job.id}`, v.job);
      await putDocument(app.db, 'autopilot-account-threads02', ap);
    }
    console.log(JSON.stringify({ fullQueueDryPassed: reached, submit: false }));
    process.exitCode = reached ? 0 : 1;
  } else {
    try {
      await s.engagement.port.reply(
        v.job,
        v.draft!,
        v.candidate,
        true,
        async () => {
          reached = true;
          throw sentinel;
        },
        async (phase) => {
          console.log(JSON.stringify({ step: phase }));
        },
      );
    } catch (e) {
      if (e !== sentinel) throw e;
    }
    console.log(JSON.stringify({ hardDryPassed: reached, submit: false }));
  }
} catch (e) {
  let message = e instanceof Error ? (e.stack ?? e.message) : String(e);
  for (const [key, value] of Object.entries(process.env))
    if (value && /TOKEN|PASSWORD|SECRET|API_KEY|DATABASE_URL/i.test(key))
      message = message.replaceAll(value, '[REDACTED]');
  console.log(JSON.stringify({ diagnosticError: message.slice(0, 3500) }));
  process.exitCode = 1;
} finally {
  await app.close();
}
