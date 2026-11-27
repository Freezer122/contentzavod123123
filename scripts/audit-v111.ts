import { PrismaDatabase } from '../src/db/database.js';
import { getDocument, listDocuments } from '../src/db/documents.js';
import { writeFile } from 'node:fs/promises';
const db = PrismaDatabase.connect(process.env.DATABASE_URL!);
try {
  const ids = ['beb4873f-94a3-4529-9ef1-d03c080c48da', '7ffdec03-c818-48f7-bc4c-f1e782ec1571'];
  const rows = [];
  for (const id of ids) {
    const job = await getDocument<any>(db, `engagement-job-${id}`);
    const d = await getDocument<any>(db, `engagement-draft-${job.accountId}-${job.draftId}`);
    const c = await getDocument<any>(
      db,
      `engagement-candidate-${job.accountId}-${job.candidateId}`,
    );
    const audit = (await db.list('audit')).filter((a) => a.entityId === id);
    rows.push({
      jobId: id,
      accountId: job.accountId,
      sourceUrl: c.url,
      draftId: d.id,
      text: d.text,
      createdAt: (await db.get('setting', `engagement-draft-${job.accountId}-${d.id}`))?.createdAt,
      jobCreatedAt: (await db.get('setting', `engagement-job-${id}`))?.createdAt,
      approvedAt: d.approvedAt,
      approvalStatus: d.status,
      queueStatus: job.status,
      scheduledAt: job.scheduledAt,
      error: job.error ?? null,
      submittedAt: job.submittedAt ?? null,
      confirmedAt: job.confirmedAt ?? null,
      url: job.url ?? null,
      audit: audit.map((a) => ({ action: a.action, at: a.createdAt, detail: a.detail })),
    });
  }
  const report = {
    at: new Date().toISOString(),
    factoryPaused: (await db.get('setting', 'factoryPaused'))?.value,
    accountStatus: (await db.get('account', 'threads02'))?.status,
    engagement: await getDocument(db, 'engagement-config-threads02'),
    publishingMode: process.env.BROWSER_EXECUTION_MODE,
    engagementMode: process.env.ENGAGEMENT_EXECUTION_MODE,
    rows,
    jobsCount: (await listDocuments(db, 'engagement-job-')).length,
  };
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v111-before-audit.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  await db.close();
}
