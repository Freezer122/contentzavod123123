import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PrismaDatabase, base, audit } from '../src/db/database.js';
import { AdsPowerProvider } from '../src/browser/providers.js';
import { ThreadsPublisher } from '../src/browser/publisher.js';
import { PublishingWorker } from '../src/scheduler/worker.js';
import { Scheduler } from '../src/scheduler/service.js';
import { assert } from '../src/core/errors.js';

const output = '/var/lib/content-factory/reports/first-publication';
const raw = await readFile('/var/lib/content-factory/approvals/first-publication.json', 'utf8');
const intent = JSON.parse(raw);
assert(
  intent.approved &&
    createHash('sha256').update(raw).digest('hex') === process.env.PUBLICATION_APPROVAL_SHA256,
  'APPROVAL_REQUIRED',
  'Manifest not approved',
);
const reconciliation = JSON.parse(await readFile(output + '/post-reconciliation.json', 'utf8'));
const matches = reconciliation.matches.filter((m: { exactTextMatch: boolean }) => m.exactTextMatch);
assert(
  reconciliation.ok && reconciliation.closedNormally && matches.length === 1,
  'NOT_VERIFIED',
  'A unique exact post must be verified in the browser',
);
const url = matches[0].url as string;
assert(
  /^https:\/\/www\.threads\.com\/@beh4ppy01\/post\/[a-zA-Z0-9_-]+$/.test(url),
  'WRONG_ACCOUNT',
  'Wrong post URL',
);
const id = '610abfb0-7cc3-4f91-81c3-b55b10529500';
const db = PrismaDatabase.connect(process.env.DATABASE_URL!);
const scheduler = new Scheduler(db);
const provider = new AdsPowerProvider(
  process.env.ADSPOWER_BASE_URL!,
  process.env.ADSPOWER_API_KEY!,
  undefined,
  ['k1j71gt4'],
);
try {
  assert(!(await provider.status('k1j71gt4')), 'PROFILE_BUSY', 'Profile is open');
  await db.transaction(async (tx) => {
    const j = await tx.get('publishJob', id);
    assert(
      j?.status === 'NEEDS_REVIEW' && j.postStatus === 'UNCERTAIN' && j.commentStatus === 'PENDING',
      'INVALID_STATE',
      'Only the unresolved first post may be confirmed',
    );
    const g = await tx.get('generated', j.generatedId);
    assert(
      g?.text === intent.post &&
        j.accountId === 'threads02' &&
        j.ctaText === intent.cta &&
        j.ctaUrl === null &&
        j.ctaMediaSha256 === intent.ctaImage.sha256,
      'APPROVAL_CHANGED',
      'Publication content changed',
    );
    assert(
      (await tx.list('post', { jobId: id })).length === 0,
      'ALREADY_VERIFIED',
      'Post already recorded',
    );
    const confirmedAt = new Date();
    await tx.insert('post', {
      ...base(),
      jobId: id,
      accountId: j.accountId,
      generatedId: j.generatedId,
      url,
      externalId: null,
      publishedAt: confirmedAt,
    });
    await tx.update('account', j.accountId, { status: 'ACTIVE', lastPublishedAt: confirmedAt });
    await tx.update('publishJob', id, {
      postStatus: 'PUBLISHED',
      status: 'COMPLETED',
      commentStatus: 'FAILED',
      lastError: null,
      updatedAt: confirmedAt,
    });
    await audit(tx, 'browser-exact-text-reconciliation', 'MANUAL_VERIFY_POST', id, url);
  });
  await scheduler.retryComment(id, 'user-approved-cta-only');
  await scheduler.pause(false, 'confirmed-post-cta-only');
  const publisher = new ThreadsPublisher(
    process.env.THREADS_SELECTORS_PATH!,
    process.env.ARTIFACTS_DIR!,
  );
  const worker = new PublishingWorker(
    db,
    { ADSPOWER: provider, DOLPHIN: provider, MOCK: provider },
    publisher,
    undefined,
    1,
    undefined,
    true,
  );
  await worker.execute(id);
  const state = await db.get('publishJob', id);
  const post = (await db.list('post', { jobId: id }))[0]!;
  const comment = (await db.list('comment', { postId: post.id }))[0];
  const report = {
    mode: 'LIVE_CTA_ONLY_AFTER_BROWSER_RECONCILIATION',
    jobId: id,
    status: state?.status,
    postStatus: state?.postStatus,
    commentStatus: state?.commentStatus,
    postUrl: post.url,
    postConfirmedAt: post.publishedAt,
    commentUrl: comment?.url,
    commentConfirmedAt: comment?.createdAt,
    error: state?.lastError,
    closedNormally: !(await provider.status('k1j71gt4')),
    llmRequests: 0,
  };
  await writeFile(output + '/publication-result.json', JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
  if (state?.commentStatus !== 'PUBLISHED' || !report.closedNormally) process.exitCode = 1;
} finally {
  await scheduler.pause(true, 'cta-only-finished');
  const a = await db.get('account', 'threads02');
  if (a?.status === 'ACTIVE') await db.update('account', a.id, { status: 'PAUSED' });
  await db.close();
}
