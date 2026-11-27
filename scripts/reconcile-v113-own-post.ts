import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { BrowserCoordinator } from '../src/browser/coordinator.js';
import { waitResults } from '../src/browser/results.js';
import { exactTimestamp } from '../src/engagement/freshness.js';
import { getDocument, putDocument, hashDocument } from '../src/db/documents.js';
import { base, audit } from '../src/db/database.js';
import { contentFeatures } from '../src/content/features.js';
import { assert } from '../src/core/errors.js';
import { readFile, writeFile } from 'node:fs/promises';
const config = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }),
  app = await createApplication(config),
  id = '3a54f7b8-c10c-48d6-9726-b118718f1446';
try {
  const job = await app.db.get('publishJob', id);
  assert(job, 'NOT_FOUND', 'Job missing');
  const g = (await app.db.get('generated', job.generatedId))!,
    account = (await app.db.get('account', job.accountId))!,
    s = JSON.parse(await readFile(config.THREADS_SELECTORS_PATH, 'utf8'));
  const grant = await getDocument<any>(app.db, `manual-post-${id}`);
  assert(
    grant?.actor === config.TELEGRAM_OWNER_ID && grant.hash === hashDocument(g.text),
    'NOT_OWNER_CONFIRMED',
    'Missing original user action',
  );
  const access = new BrowserCoordinator(app.db, app.services.providers);
  const result = await access.use(job.accountId, 'PROFILE', async (page) => {
    await page.goto(`https://www.threads.com/@${account.username}`, {
      waitUntil: 'domcontentloaded',
    });
    assert(
      !(await page.locator(s.challenge).count()) && !(await page.locator(s.restricted).count()),
      'RESTRICTED',
      'Platform check',
    );
    const rows = await waitResults(page, s.ownPost, s.postLink, g.text, account.username, 12000);
    const urls = [...new Set(rows.flatMap((r) => r.urls))].filter((v) => {
      const u = new URL(v);
      return (
        u.protocol === 'https:' &&
        ['www.threads.com', 'threads.com'].includes(u.hostname) &&
        u.pathname.startsWith(`/@${account.username}/post/`)
      );
    });
    assert(urls.length === 1, 'UNCERTAIN', 'No unique exact post result');
    const url = urls[0]!;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const direct = await waitResults(page, s.ownPost, s.postLink, g.text, account.username, 12000);
    assert(
      direct.length === 1 &&
        direct[0]!.urls.some((v) => new URL(v).pathname === new URL(url).pathname),
      'UNCERTAIN',
      'Direct exact post not confirmed',
    );
    const dates = await page
      .locator('time')
      .evaluateAll(
        (ts, path) =>
          ts
            .filter((t) => t.closest('a')?.getAttribute('href') === path)
            .map((t) => t.getAttribute('datetime')),
        new URL(url).pathname,
      );
    const exact = [...new Set(dates.map(exactTimestamp).filter(Boolean))];
    assert(exact.length === 1, 'UNCERTAIN', 'No unique published timestamp');
    return { url, publishedAt: exact[0]!, exactTextVerified: true };
  });
  await app.db.transaction(async (tx) => {
    const current = (await tx.get('publishJob', id))!;
    if (current.postStatus === 'PUBLISHED') return;
    assert(
      current.status === 'NEEDS_REVIEW' &&
        current.postStatus === 'UNCERTAIN' &&
        !current.ctaSubmitAt,
      'INVALID_STATE',
      'Only unresolved post without CTA submit',
    );
    assert(
      !(await tx.list('post', { jobId: id })).length,
      'ALREADY_RECORDED',
      'Post already exists',
    );
    const source = (await tx.get('source', g.sourceId))!;
    const post = await tx.insert('post', {
      ...base(),
      jobId: id,
      accountId: job.accountId,
      generatedId: g.id,
      url: result.url,
      externalId: null,
      publishedAt: new Date(result.publishedAt),
    });
    await tx.update('publishJob', id, {
      postStatus: 'PUBLISHED',
      status: 'PAUSED',
      postConfirmedAt: new Date(),
      lastError: 'Пост подтверждён чтением. CTA не отправлен; требуется действие владельца',
      updatedAt: new Date(),
    });
    await tx.update('account', job.accountId, { lastPublishedAt: post.publishedAt });
    await tx.insert('contentPerformance', {
      ...base(),
      postId: post.id,
      sourceText: source.text,
      finalText: g.text,
      ...contentFeatures(g.text, source),
      templateId: g.templateId ?? null,
      templateSnapshot: g.templateSnapshot ?? null,
    });
    await audit(tx, 'read-only-reconciliation', 'MANUAL_VERIFY_POST', id, result.url);
    await tx.insert('systemEvent', {
      ...base(`publish-status-${id}-post`),
      level: 'INFO',
      code: 'NOTIFICATION',
      message: `Пост опубликован и подтверждён: ${result.url}\nВремя: ${result.publishedAt}\nCTA не отправлен, ожидает подтверждения после сверки. Повторной отправки поста нет`,
    });
  });
  const report = {
    ...result,
    jobId: id,
    submittedAt: job.postSubmitAt,
    originalOwnerAction: grant.actor,
    postResubmitted: false,
    ctaSubmitted: false,
  };
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v113-own-post-confirmed.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  await app.close();
}
