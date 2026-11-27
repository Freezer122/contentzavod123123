/** One-time continuation after explicit owner approval in Codex. Consumers must be stopped. */
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, putDocument, hashDocument } from '../src/db/documents.js';
import { assert } from '../src/core/errors.js';
import { audit } from '../src/db/database.js';
const app = await createApplication(loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }));
try {
  assert(process.env.V117_WORKER_STOPPED === '1', 'MAINTENANCE', 'Consumers must be stopped');
  const s = app.services,
    a: any = await getDocument(app.db, 'v117-acceptance'),
    ap = await s.autopilotPolicy.settings('threads02');
  assert(
    ap.state === 'ERROR' && ap.epoch === a.epoch && ap.enabledBy === '7842338078',
    'SCOPE',
    'Unexpected autopilot state',
  );
  assert(a.dryPassedAt && a.prepared.length === 4, 'DRY_FIRST', 'Four previews required');
  assert(!(await getDocument(app.db, 'emergencyStop')), 'EMERGENCY', 'Emergency stop');
  for (const p of a.prepared) {
    const w: any = await getDocument(app.db, `autopilot-work-${p.slot.contentJobId}`);
    assert(
      w.status === 'SCHEDULED' && hashDocument(w.text) === hashDocument(p.text),
      'TEXT_CHANGED',
      'Approved text changed',
    );
    const j: any =
      p.slot.kind === 'POST'
        ? await app.db.get('publishJob', p.slot.publishingJobId)
        : (await s.engagement.jobView(p.slot.publishingJobId)).job;
    assert(
      j && !j.submittedAt && !j.postSubmitAt && ['QUEUED', 'PAUSED'].includes(j.status),
      'ALREADY_STARTED',
      'No retry after submit',
    );
    if (p.slot.kind === 'REPLY') {
      const c = await s.engagement.candidate('threads02', w.candidateId);
      assert(
        c.publishedAt &&
          Date.now() - Date.parse(c.publishedAt) < ap.config.maxAgeHours * 3600000 - 35 * 60000,
        'STALE_SOURCE',
        'Insufficient freshness remaining for approved test',
      );
    }
  }
  await app.db.transaction(async (tx) => {
    await audit(
      tx,
      '7842338078',
      'V117_LIVE_TEST_APPROVED',
      'threads02',
      JSON.stringify({
        source: 'Explicit Codex user reply',
        scope:
          'one post, three replies and continuation 5/20 daily, 09:00–22:00 Moscow; CTA disabled',
        epoch: ap.epoch,
        hashes: a.prepared.map((p: any) => hashDocument(p.text)),
      }),
    );
    await putDocument(tx, 'autopilot-account-threads02', {
      ...ap,
      state: 'RUNNING',
      error: undefined,
      failures: 0,
    });
    await putDocument(tx, 'automationPaused', false);
    await putDocument(tx, 'v117-acceptance', { ...a, liveApprovedAt: new Date().toISOString() });
  });
  console.log(JSON.stringify({ restoredCurrentEpoch: ap.epoch, approvedTexts: 4, submit: false }));
} finally {
  await app.close();
}
