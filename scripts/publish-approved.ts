import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { PrismaDatabase, base, audit } from '../src/db/database.js';
import { AdsPowerProvider } from '../src/browser/providers.js';
import { ThreadsPublisher } from '../src/browser/publisher.js';
import { PublishingWorker } from '../src/scheduler/worker.js';
import { Scheduler } from '../src/scheduler/service.js';
import { validateContent } from '../src/content/service.js';
import { renderCta } from '../src/cta/service.js';
import { assert } from '../src/core/errors.js';

// A single explicitly approved publication; the persistent worker stays DRY_RUN.
const schema = z.object({
  accountId: z.literal('threads02'),
  profileId: z.literal('k1j71gt4'),
  username: z.literal('beh4ppy01'),
  post: z.string().min(1),
  cta: z.string().min(1),
  ctaUrl: z.string().url().nullable(),
  ctaImage: z
    .object({
      path: z.string().startsWith('/var/lib/content-factory/media/'),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .nullable(),
  approved: z.boolean(),
  approvedAt: z.string().datetime().nullable(),
});
const raw = await readFile(process.env.PUBLICATION_MANIFEST!, 'utf8');
const intent = schema.parse(JSON.parse(raw));
const digest = createHash('sha256').update(raw).digest('hex');
const mode = process.env.PUBLICATION_MODE ?? 'DRY_RUN';
assert(['DRY_RUN', 'LIVE'].includes(mode), 'INVALID_MODE', 'Unknown mode');
assert(
  [...intent.post].length <= 500 && [...renderCta(intent.cta, intent.ctaUrl)].length <= 500,
  'TEXT_LENGTH',
  'Post or CTA exceeds 500 characters',
);
assert(intent.ctaImage, 'MEDIA_REQUIRED', 'The approved CTA image has not been supplied');
const image = await readFile(intent.ctaImage.path);
assert(
  image.length > 0 &&
    image.length <= 10 * 1024 * 1024 &&
    createHash('sha256').update(image).digest('hex') === intent.ctaImage.sha256,
  'MEDIA_CHANGED',
  'CTA image does not match the manifest',
);
if (mode === 'LIVE')
  assert(
    intent.approved && intent.approvedAt && process.env.PUBLICATION_APPROVAL_SHA256 === digest,
    'APPROVAL_REQUIRED',
    'The complete post + CTA + image requires explicit approval',
  );
const output = '/var/lib/content-factory/reports/first-publication';
await mkdir(output, { recursive: true, mode: 0o700 });
const lockPath = resolve(output, 'publishing.lock');
const lock = await open(lockPath, 'wx', 0o600);
await lock.writeFile(String(process.pid));
const db = PrismaDatabase.connect(process.env.DATABASE_URL!);
const provider = new AdsPowerProvider(
  process.env.ADSPOWER_BASE_URL!,
  process.env.ADSPOWER_API_KEY!,
  undefined,
  ['k1j71gt4'],
);
const scheduler = new Scheduler(db);
const contentHash = createHash('sha256').update(intent.post).digest('hex');
const requestHash = createHash('sha256')
  .update(JSON.stringify([intent.post, intent.cta, intent.ctaUrl, intent.ctaImage.sha256]))
  .digest('hex');
let disarm = false;
try {
  const account = await db.get('account', intent.accountId);
  const profile = account && (await db.get('browserProfile', account.profileId));
  assert(
    account?.username === intent.username &&
      profile?.provider === 'ADSPOWER' &&
      profile.externalId === intent.profileId,
    'WRONG_ACCOUNT',
    'Profile mapping changed',
  );
  assert(
    (await db.get('setting', 'factoryPaused'))?.value === 'true',
    'NOT_PAUSED',
    'Factory must be paused before a one-off publication',
  );
  assert(!(await provider.status(intent.profileId)), 'PROFILE_BUSY', 'Profile is already open');
  const summary = {
    mode,
    manifestSha256: digest,
    postCharacters: [...intent.post].length,
    ctaCharacters: [...renderCta(intent.cta, intent.ctaUrl)].length,
    imageSha256: intent.ctaImage.sha256,
    llmRequests: 0,
  };
  if (mode === 'DRY_RUN') {
    console.log(JSON.stringify({ ...summary, validated: true, postsSent: 0, commentsSent: 0 }));
  } else {
    const jobs = await db.list('publishJob', { accountId: account.id });
    assert(
      !jobs.some((j) => ['QUEUED', 'RUNNING', 'PAUSED', 'NEEDS_REVIEW'].includes(j.status)),
      'PENDING_JOB',
      'Resolve an existing job before creating another',
    );
    const existing = (await db.list('post', { accountId: account.id })).find(
      (p) => p.generatedId === `manual-${contentHash}`,
    );
    assert(!existing, 'DUPLICATE_POST', 'This post has already been published');
    disarm = true;
    await db.transaction(async (tx) => {
      const style = await tx.get('style', account.styleId);
      assert(
        style?.ownerAccountId === account.id,
        'SHARED_STYLE',
        'Only the account-owned style may be adjusted',
      );
      const paragraphs = intent.post.split(/\n\s*\n/).length;
      const ownStyle = { ...style, maxParagraphs: Math.max(style.maxParagraphs, paragraphs) };
      assert(
        !validateContent(intent.post, intent.post, ownStyle).length,
        'INVALID_DRAFT',
        'Approved post fails the account checks',
      );
      if (ownStyle.maxParagraphs !== style.maxParagraphs)
        await tx.update('style', style.id, { maxParagraphs: ownStyle.maxParagraphs });
      if (!(await tx.get('source', `manual-source-${contentHash}`)))
        await tx.insert('source', {
          ...base(`manual-source-${contentHash}`),
          url: null,
          fingerprint: `manual-${contentHash}`,
          text: intent.post,
          author: 'user-approved',
          rights: 'OWN',
        });
      if (!(await tx.get('generated', `manual-${contentHash}`)))
        await tx.insert('generated', {
          ...base(`manual-${contentHash}`),
          sourceId: `manual-source-${contentHash}`,
          accountId: account.id,
          styleId: account.styleId,
          text: intent.post,
          version: 1,
          valid: true,
          approved: false,
        });
      await tx.update('account', account.id, { status: 'ACTIVE' });
      await audit(tx, 'user-approved', 'APPROVE_PUBLICATION_MANIFEST', account.id, digest);
    });
    const [job] = await scheduler.createBatch(
      [`manual-${contentHash}`],
      'user-approved',
      'MANUAL_APPROVAL',
      `first-publication-${requestHash}`,
    );
    assert(
      job?.status === 'QUEUED' && job.postStatus === 'PENDING',
      'ALREADY_ATTEMPTED',
      'Existing job must be reviewed, not resent',
    );
    await db.update('publishJob', job.id, {
      ctaCapturedAt: new Date(),
      ctaEnabled: true,
      ctaText: intent.cta,
      ctaUrl: intent.ctaUrl,
      ctaVersion: 1,
      ctaUpdatedAt: new Date(),
      commentStatus: 'PENDING',
      ctaMediaPath: intent.ctaImage.path,
      ctaMediaSha256: intent.ctaImage.sha256,
    });
    await scheduler.pause(false, 'approved-one-off');
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
    await worker.execute(job.id);
    const state = await db.get('publishJob', job.id);
    const post = (await db.list('post', { jobId: job.id }))[0];
    const comment = post && (await db.list('comment', { postId: post.id }))[0];
    const report = {
      ...summary,
      jobId: job.id,
      status: state?.status,
      postStatus: state?.postStatus,
      commentStatus: state?.commentStatus,
      postUrl: post?.url,
      commentUrl: comment?.url,
      error: state?.lastError,
      closedNormally: !(await provider.status(intent.profileId)),
    };
    await writeFile(resolve(output, `${job.id}.json`), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    console.log(JSON.stringify(report));
    if (
      state?.postStatus !== 'PUBLISHED' ||
      state?.commentStatus !== 'PUBLISHED' ||
      !report.closedNormally
    )
      process.exitCode = 1;
  }
} finally {
  if (disarm) {
    await scheduler.pause(true, 'one-off-finished');
    const account = await db.get('account', intent.accountId);
    if (account?.status === 'ACTIVE') await db.update('account', account.id, { status: 'PAUSED' });
  }
  await db.close();
  await lock.close();
  await unlink(lockPath);
}
