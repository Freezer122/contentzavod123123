import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { hashDocument } from '../src/db/documents.js';
import { writeFile } from 'node:fs/promises';
const app = await createApplication(
  loadConfig({
    ...process.env,
    PROCESS_ROLE: 'worker',
    BROWSER_EXECUTION_MODE: 'DRY_RUN',
    PROFILE_CHANGES_ALLOWED: '0',
    ENGAGEMENT_EXECUTION_MODE: 'DRY_RUN',
    LLM_API_KEY: '',
  }),
);
const report: Record<string, unknown> = {
  mode: 'LIKE_BUTTON_DRY_RUN',
  likesSent: 0,
  postsSent: 0,
  commentsSent: 0,
};
try {
  const c = (await app.services.engagement.candidates('threads02'))[0];
  if (!c) throw new Error('NO_CANDIDATE');
  await app.services.engagement.port.like(
    {
      id: 'v18-like-readonly',
      accountId: 'threads02',
      candidateId: c.id,
      kind: 'LIKE',
      hash: hashDocument(c.url),
      actor: 'v18-readonly-check',
      status: 'QUEUED',
      scheduledAt: new Date().toISOString(),
    },
    c,
    false,
    async () => {
      throw new Error('NO_SUBMIT_ALLOWED');
    },
  );
  report.ok = true;
} catch (e) {
  report.ok = false;
  report.error = e instanceof Error ? e.message : 'CHECK_FAILED';
  process.exitCode = 1;
} finally {
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v18-like-check.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
  await app.close();
}
