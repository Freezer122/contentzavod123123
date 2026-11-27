import { chromium, type Page, type Locator } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AdsPowerProvider } from '../src/browser/providers.js';
import { ThreadsSession, type Selectors } from '../src/browser/publisher.js';
import { PrismaDatabase } from '../src/db/database.js';
import { AppError, assert } from '../src/core/errors.js';

const output = '/var/lib/content-factory/reports/first-publication';
await mkdir(output, { recursive: true, mode: 0o700 });
const intent = JSON.parse(
  await readFile('/var/lib/content-factory/approvals/first-publication.json', 'utf8'),
);
const image = await readFile(intent.ctaImage.path);
assert(
  createHash('sha256').update(image).digest('hex') === intent.ctaImage.sha256,
  'MEDIA_CHANGED',
  'Image differs',
);
const provider = new AdsPowerProvider(
  process.env.ADSPOWER_BASE_URL!,
  process.env.ADSPOWER_API_KEY!,
  undefined,
  ['k1j71gt4'],
);
const db = PrismaDatabase.connect(process.env.DATABASE_URL!);
const account = await db.get('account', 'threads02');
assert(account?.username === 'beh4ppy01', 'WRONG_ACCOUNT', 'Wrong account');
assert(!(await provider.status('k1j71gt4')), 'PROFILE_BUSY', 'Profile is open');
const selectors: Selectors = JSON.parse(
  await readFile(process.env.THREADS_SELECTORS_PATH!, 'utf8'),
);
const report: Record<string, unknown> = {
  mode: 'DRY_RUN',
  postsSent: 0,
  commentsSent: 0,
  llmRequests: 0,
  imageSha256: intent.ctaImage.sha256,
};
let browser;
let page: Page | undefined;
let editor: Locator | undefined;
let session: ThreadsSession | undefined;
let ownDraft = false;
try {
  const started = await provider.start('k1j71gt4');
  browser = await chromium.connectOverCDP(started.cdpEndpoint);
  page = await browser.contexts()[0]!.newPage();
  page.setDefaultTimeout(20000);
  await page.goto('https://www.threads.com/@beh4ppy01', { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /^(Edit profile|Profil bearbeiten|Редактировать профиль)$/i })
    .filter({ visible: true })
    .waitFor();
  await page.locator(selectors.create).filter({ visible: true }).waitFor();
  const ownLinks = page.locator(selectors.postLink).filter({ visible: true });
  report.existingPostLinks = await ownLinks.evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute('href')),
  );
  session = new ThreadsSession(
    page,
    null,
    provider,
    'k1j71gt4',
    account,
    'cta-image-preflight',
    selectors,
    output,
  );
  const beforeSend = async () => {
    ownDraft = true;
    report.beforeSendReached = true;
    throw new AppError('DRY_RUN_STOP', 'Do not send');
  };
  const ownHref = (report.existingPostLinks as string[]).find((h) =>
    /^\/@beh4ppy01\/post\/[^/]+$/.test(h),
  );
  if (ownHref) {
    report.composer = 'OWN_POST_REPLY';
    try {
      await session.comment(
        new URL(ownHref, selectors.baseUrl).href,
        intent.cta,
        beforeSend,
        intent.ctaImage,
      );
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== 'DRY_RUN_STOP') throw e;
    }
  } else {
    report.composer = 'OWN_PROFILE_DRAFT';
    await page.locator(selectors.create).filter({ visible: true }).click();
    const dialog = page.locator(selectors.dialog).filter({ visible: true });
    await dialog.waitFor();
    editor = dialog.locator(selectors.editor);
    assert(!(await editor.innerText()).trim(), 'EXISTING_DRAFT', 'Existing draft');
    ownDraft = true;
    await editor.fill(intent.cta);
    await dialog.locator(selectors.mediaInput!).setInputFiles(intent.ctaImage.path);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="dialog"] img')].some(
          (n) =>
            n instanceof HTMLImageElement &&
            n.complete &&
            n.naturalWidth > 0 &&
            n.getBoundingClientRect().width >= 80 &&
            n.getBoundingClientRect().height >= 80,
        ),
      {},
      { timeout: 45000 },
    );
  }
  const dialog = page.locator(selectors.dialog).filter({ visible: true });
  editor = dialog.locator(selectors.editor);
  assert((await editor.innerText()).trim() === intent.cta, 'TEXT_MISMATCH', 'CTA differs');
  report.imageVerified = true;
  await dialog.screenshot({ path: output + '/cta-media-preview.png' });
  report.controls = await dialog.locator('[role="button"],button').evaluateAll((nodes) =>
    nodes.map((n) => ({
      label: n.getAttribute('aria-label'),
      text: n.textContent?.slice(0, 100),
      html: n.outerHTML.slice(0, 1200),
    })),
  );
  const remove = dialog
    .getByRole('button', { name: /entfernen|remove|удалить/i })
    .filter({ visible: true });
  report.removeButtons = await remove.count();
  assert(report.removeButtons === 1, 'MEDIA_CLEANUP_REQUIRED', 'No unique remove-media control');
  await remove.click();
  await editor.fill('');
  await page.keyboard.press('Escape');
  const discard = page
    .getByRole('button', { name: /^(Verwerfen|Discard|Отменить изменения|Удалить черновик)$/i })
    .filter({ visible: true });
  if ((await discard.count()) === 1) await discard.click();
  await dialog.waitFor({ state: 'hidden' });
  ownDraft = false;
  report.draftCleared = true;
  report.ok = true;
} catch (e) {
  report.ok = false;
  report.error = e instanceof Error ? e.message : String(e);
  if (page)
    report.finalControls = await page
      .locator('[role="button"],button')
      .filter({ visible: true })
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          label: n.getAttribute('aria-label'),
          text: n.textContent?.slice(0, 100),
        })),
      )
      .catch(() => []);
} finally {
  if (ownDraft && editor) await editor.fill('').catch(() => {});
  await page?.close().catch(() => {});
  await provider.stop('k1j71gt4');
  report.closedNormally = !(await provider.status('k1j71gt4'));
  await browser?.close().catch(() => {});
  await db.close();
  await writeFile(output + '/cta-media-preflight.json', JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
}
console.log(
  JSON.stringify({
    ok: report.ok,
    composer: report.composer,
    imageVerified: report.imageVerified,
    draftCleared: report.draftCleared,
    closedNormally: report.closedNormally,
    error: report.error,
  }),
);
if (!report.ok) process.exitCode = 1;
