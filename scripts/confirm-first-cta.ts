import { readFile, writeFile } from 'node:fs/promises';
import { PrismaDatabase, base, audit } from '../src/db/database.js';
import { assert } from '../src/core/errors.js';
const output = '/var/lib/content-factory/reports/first-publication';
const evidence = JSON.parse(await readFile(output + '/cta-reconciliation.json', 'utf8'));
const intent = JSON.parse(
  await readFile('/var/lib/content-factory/approvals/first-publication.json', 'utf8'),
);
const matches = evidence.matches.filter((m: any) => m.exactTextMatch && m.images.length > 0);
assert(
  evidence.ok && evidence.closedNormally && matches.length === 1,
  'NOT_VERIFIED',
  'CTA not verified',
);
const url = matches[0].url;
assert(
  /^https:\/\/www\.threads\.com\/@beh4ppy01\/post\/[a-zA-Z0-9_-]+$/.test(url),
  'WRONG_ACCOUNT',
  'Wrong CTA URL',
);
const db = PrismaDatabase.connect(process.env.DATABASE_URL!);
try {
  await db.transaction(async (tx) => {
    const job = await tx.get('publishJob', '610abfb0-7cc3-4f91-81c3-b55b10529500');
    assert(
      job?.status === 'NEEDS_REVIEW' &&
        job.postStatus === 'PUBLISHED' &&
        job.commentStatus === 'UNCERTAIN',
      'INVALID_STATE',
      'CTA is not awaiting reconciliation',
    );
    assert(
      job.ctaText === intent.cta && job.ctaMediaSha256 === intent.ctaImage.sha256,
      'APPROVAL_CHANGED',
      'CTA changed',
    );
    const post = (await tx.list('post', { jobId: job.id }))[0]!;
    assert(post.url !== url, 'WRONG_URL', 'CTA must have its own URL');
    await tx.insert('comment', {
      ...base(),
      postId: post.id,
      text: job.ctaText!,
      url,
      status: 'PUBLISHED',
    });
    await tx.update('publishJob', job.id, {
      status: 'COMPLETED',
      commentStatus: 'PUBLISHED',
      lastError: null,
      updatedAt: new Date(),
    });
    await tx.update('setting', 'factoryPaused', { value: 'true' });
    await tx.update('account', 'threads02', { status: 'PAUSED' });
    await audit(
      tx,
      'browser-exact-text-and-image-reconciliation',
      'MANUAL_VERIFY_COMMENT',
      job.id,
      url,
    );
  });
  const job = (await db.get('publishJob', '610abfb0-7cc3-4f91-81c3-b55b10529500'))!;
  const post = (await db.list('post', { jobId: job.id }))[0]!;
  const comment = (await db.list('comment', { postId: post.id }))[0]!;
  const report = {
    status: job.status,
    postStatus: job.postStatus,
    commentStatus: job.commentStatus,
    jobId: job.id,
    postUrl: post.url,
    commentUrl: comment.url,
    postCount: (await db.list('post')).length,
    commentCount: (await db.list('comment')).length,
    llmRequests: (await db.list('aiRequest')).length,
    factoryPaused: (await db.get('setting', 'factoryPaused'))?.value,
    accountStatus: (await db.get('account', 'threads02'))?.status,
    reconciled: true,
    imageSha256: job.ctaMediaSha256,
  };
  await writeFile(output + '/final-publication-result.json', JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
} finally {
  await db.close();
}
