import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { writeFile } from 'node:fs/promises';
import type { ProfileData } from '../src/profile/service.js';
import { hashDocument, putDocument } from '../src/db/documents.js';
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
const accountId = 'threads02',
  report: Record<string, unknown> = {
    mode: 'READ_ONLY_AND_DRY_RUN',
    postsSent: 0,
    commentsSent: 0,
    likesSent: 0,
    profileSaves: 0,
    stages: [],
  };
const stages = report.stages as string[];
const settings = await app.services.engagement.settings(accountId);
const beforeRequests = (await app.db.list('aiRequest')).length;
try {
  const before = await app.services.profileManager.snapshot(accountId, true);
  report.profileBeforeHash = hashDocument(before);
  const cases: Array<[string, Partial<Pick<ProfileData, 'bio' | 'links'>>]> = [
    ['BIO', { bio: 'проверка редактора без сохранения' }],
    ['ADD_LINK', { links: [...before.links, 'https://example.com/cf-v18-dry-run'] }],
    [
      'EDIT_LINK',
      {
        links: before.links.map((link, i) =>
          i === 0 ? 'https://example.com/cf-v18-dry-edit' : link,
        ),
      },
    ],
    ['DELETE_LINK', { links: before.links.slice(0, -1) }],
  ];
  for (const [name, patch] of cases) {
    if (name === 'ADD_LINK' && before.links.length >= before.linkCapacity) continue;
    if ((name === 'EDIT_LINK' || name === 'DELETE_LINK') && !before.links.length) continue;
    const draft = await app.services.profileManager.draft(accountId, patch, 'v18-readonly-check');
    await app.services.profileManager.approve(draft.id, draft.hash, 'v18-readonly-check');
    await app.services.profileManager.apply(draft.id, draft.hash, 'v18-readonly-check', true);
    stages.push(name + '_DRY_RUN_OK');
  }
  const after = await app.services.profileManager.snapshot(accountId, true);
  report.profileUnchanged = hashDocument(before) === hashDocument(after);
  await app.services.engagement.configure(
    accountId,
    { ...settings, enabled: true },
    'v18-readonly-check',
  );
  const result = await app.services.engagement.search(accountId, 'v18-readonly-check');
  report.search = result;
  stages.push('SEARCH_READ_ONLY_OK');
  const candidate = (await app.services.engagement.candidates(accountId)).find(
    (c) => c.status === 'NEW',
  );
  if (candidate) {
    const draft = await app.services.engagement.edit(
      accountId,
      candidate.id,
      'сначала стоит определить допустимый риск, а уже потом выбирать размер позиции',
      'v18-readonly-check',
    );
    const job = await app.services.engagement.approve(
      accountId,
      draft.id,
      draft.hash,
      'v18-readonly-check',
    );
    await app.services.engagementQueue.execute(job.id, true);
    stages.push('REPLY_EDITOR_DRY_RUN_OK');
  }
  report.llmRequests = (await app.db.list('aiRequest')).length - beforeRequests;
  if (!report.profileUnchanged || report.llmRequests !== 0)
    throw new Error('UNEXPECTED_SIDE_EFFECT');
  report.ok = true;
} catch (e) {
  report.ok = false;
  report.error = e instanceof Error ? e.message : 'FEATURE_CHECK_FAILED';
  process.exitCode = 1;
} finally {
  for (const job of await app.services.engagement.jobs(accountId))
    if (job.actor === 'v18-readonly-check' && job.status === 'QUEUED')
      await putDocument(app.db, `engagement-job-${job.id}`, {
        ...job,
        status: 'FAILED',
        error: 'Тест завершён. Реальная отправка не разрешена.',
      });
  await app.services.engagement.configure(accountId, settings, 'v18-readonly-check');
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v18-feature-check.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
  await app.close();
}
