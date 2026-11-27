/** Read-only evidence. No generation, scheduler tick, browser or publishing calls. */
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument, listDocuments } from '../src/db/documents.js';
import { writeFile } from 'node:fs/promises';
const app = await createApplication(loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }));
try {
  const s = app.services,
    a: any = await getDocument(app.db, 'v117-acceptance'),
    slots = await s.autopilot.schedule('threads02'),
    watched = slots.filter((x) => x.id === a.postSlotId || a.replySlotIds.includes(x.id)),
    works = (await s.autopilotPolicy.works()).filter((w) =>
      watched.some((x) => x.contentJobId === w.id),
    ),
    requests = (await app.db.list('aiRequest')).filter((r) => !a.aiBefore.includes(r.id)),
    nextPost = slots.find(
      (x) => x.kind === 'POST' && ['PLANNED', 'PREPARING', 'READY'].includes(x.status),
    ),
    result = {
      at: new Date().toISOString(),
      release: process.cwd(),
      settings: await s.autopilotPolicy.settings('threads02'),
      automationPaused: await getDocument(app.db, 'automationPaused'),
      emergencyStop: await getDocument(app.db, 'emergencyStop'),
      dryPassedAt: a.dryPassedAt,
      armedAt: a.armedAt,
      stats: await s.autopilot.stats('threads02'),
      slots,
      watched,
      works,
      nextPost,
      nextPostWork: nextPost?.contentJobId
        ? await getDocument(app.db, `autopilot-work-${nextPost.contentJobId}`)
        : null,
      publishing: await app.db.list('publishJob'),
      replies: await s.engagement.jobs('threads02'),
      tasks: (await listDocuments<any>(app.db, 'generation-task-')).filter((t) =>
        works.some((w) => w.id === t.autoWorkId),
      ),
      submitAudits: (await app.db.list('audit'))
        .filter(
          (a) =>
            a.action === 'ENGAGEMENT_SEND_STARTED' &&
            watched.some((x) => x.publishingJobId === a.entityId),
        )
        .map((a) => ({ jobId: a.entityId, at: a.createdAt })),
      requests: requests.map((r) => ({
        id: r.id,
        model: r.model,
        input: r.inputTokens,
        output: r.outputTokens,
        costUsd: r.costUsd,
        status: r.status,
      })),
      totalCostUsd: (await app.db.list('aiRequest')).reduce((n, r) => n + r.costUsd, 0),
      heartbeat: await getDocument(app.db, 'autopilot-scheduler-heartbeat'),
    };
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v117-status.json',
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
} finally {
  await app.close();
}
