import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AdsPowerProvider } from '../src/browser/providers.js';
import { ThreadsSession, type Selectors } from '../src/browser/publisher.js';
import { PrismaDatabase } from '../src/db/database.js';
import { AppError, assert } from '../src/core/errors.js';

// Runs on the VPS. The production publisher must stop at its durable pre-send hook.
const output = process.env.PROBE_OUTPUT_DIR ?? '/var/lib/content-factory/reports/preflight';
await mkdir(output, { recursive: true, mode: 0o700 });
const provider = new AdsPowerProvider(
  process.env.ADSPOWER_BASE_URL!,
  process.env.ADSPOWER_API_KEY!,
  undefined,
  ['k1j71gt4'],
);
const db = PrismaDatabase.connect(process.env.DATABASE_URL!);
const account = await db.get('account', 'threads02');
assert(account?.username === 'beh4ppy01', 'WRONG_ACCOUNT', 'Unexpected account');
assert(!(await provider.status('k1j71gt4')), 'PROFILE_BUSY', 'Profile must be closed');
const result: Record<string, unknown> = {
  mode: 'DRY_RUN',
  postsSent: 0,
  commentsSent: 0,
  llmRequests: 0,
};
let browser;
let page;
let ownedDraft = false;
try {
  const started = await provider.start('k1j71gt4');
  browser = await chromium.connectOverCDP(started.cdpEndpoint);
  page = await browser.contexts()[0]!.newPage();
  page.setDefaultTimeout(20000);
  const selectors: Selectors = JSON.parse(
    await readFile(process.env.THREADS_SELECTORS_PATH!, 'utf8'),
  );
  await page.goto(selectors.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('a[href="/@beh4ppy01"]').filter({ visible: true }).first().waitFor();
  await page.locator('a[href*="/post/"]').filter({ visible: true }).first().waitFor();
  result.identity = await page.locator('a[href="/@beh4ppy01"]').evaluateAll((nodes) =>
    nodes.map((n) => ({
      visible: !!n.getClientRects().length,
      html: n.outerHTML.slice(0, 2500),
    })),
  );
  const rows = page.locator('[data-pressable-container="true"]').filter({ visible: true });
  result.postContainers = await rows.count();
  result.rowControls = await rows
    .first()
    .locator('button,[role="button"]')
    .evaluateAll((nodes) =>
      nodes.map((n) => ({
        label: n.getAttribute('aria-label'),
        text: n.textContent?.slice(0, 50),
        svg: [...n.querySelectorAll('svg')].map((s) => ({
          label: s.getAttribute('aria-label'),
          title: s.getAttribute('title'),
          role: s.getAttribute('role'),
        })),
      })),
    );
  result.firstPostLinks = await rows
    .first()
    .locator('a[href*="/post/"]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('href')));
  if (process.env.PREFLIGHT_REPLY_INSPECT === '1') {
    const href = await rows.first().locator('a[href*="/post/"]').first().getAttribute('href');
    await page.goto(new URL(href!, selectors.baseUrl).href, { waitUntil: 'domcontentloaded' });
    const original = page
      .locator(selectors.ownPost)
      .filter({ has: page.locator(`a[href="${href}"]`) })
      .filter({ visible: true });
    await original.first().waitFor();
    result.detailOriginalCount = await original.count();
    result.detailReplyCount = await original
      .locator(selectors.reply)
      .filter({ visible: true })
      .count();
    assert(
      result.detailOriginalCount === 1 && result.detailReplyCount === 1,
      'UI_CHANGED',
      'Reply selector is ambiguous',
    );
    await original.locator(selectors.reply).filter({ visible: true }).click();
    const dialog = page.locator(selectors.dialog).filter({ visible: true });
    await dialog.waitFor();
    result.replyInputs = await dialog.locator('input').evaluateAll((nodes) =>
      nodes.map((node) => {
        const n = node as HTMLInputElement;
        return { type: n.type, accept: n.accept, multiple: n.multiple };
      }),
    );
    result.replyControls = await dialog.locator('[role="button"],button').evaluateAll((nodes) =>
      nodes.map((n) => ({
        text: n.textContent?.slice(0, 80),
        label: n.getAttribute('aria-label'),
      })),
    );
    assert(
      !(await dialog.locator(selectors.editor).innerText()).trim(),
      'EXISTING_DRAFT',
      'Reply is not empty',
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  }
  if (process.env.PREFLIGHT_INSPECT_ONLY !== '1') {
    const text = await readFile(process.env.PROBE_DRAFT_PATH!, 'utf8');
    const session = new ThreadsSession(
      page,
      null,
      provider,
      'k1j71gt4',
      account,
      'production-preflight',
      selectors,
      output,
    );
    try {
      await session.publish(text, async () => {
        ownedDraft = true;
        result.productionBeforeSendReached = true;
        throw new AppError('DRY_RUN_STOP', 'No external submit');
      });
      throw new Error('Pre-send barrier unexpectedly returned');
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'DRY_RUN_STOP') throw error;
    }
    const editor = page
      .locator(selectors.dialog)
      .filter({ visible: true })
      .locator(selectors.editor);
    await editor.fill('');
    assert(!(await editor.innerText()).trim(), 'DRAFT_CLEANUP_FAILED', 'Draft remains');
    ownedDraft = false;
    await page.keyboard.press('Escape');
    result.draftCleared = true;
  }
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? error.message : String(error);
  if (page)
    result.dialogButtons = await page
      .locator('[role="dialog"] [role="button"], [role="dialog"] button')
      .evaluateAll((nodes) =>
        nodes.map((n) => ({ text: n.textContent?.slice(0, 80), html: n.outerHTML.slice(0, 1800) })),
      )
      .catch(() => []);
} finally {
  if (page && process.env.PROBE_DRAFT_PATH) {
    const editor = page
      .locator('[role="dialog"] [contenteditable="true"][role="textbox"]')
      .filter({ visible: true });
    const expected = (await readFile(process.env.PROBE_DRAFT_PATH, 'utf8')).trim();
    if ((await editor.count()) === 1 && (await editor.innerText()).trim() === expected) {
      await editor.fill('');
      result.draftCleared = !(await editor.innerText()).trim();
    }
  }
  await page?.close().catch(() => {});
  await provider.stop('k1j71gt4');
  result.closedNormally = !(await provider.status('k1j71gt4'));
  await browser?.close().catch(() => {});
  await db.close();
  await writeFile(
    resolve(
      output,
      process.env.PREFLIGHT_INSPECT_ONLY === '1'
        ? 'publisher-structure.json'
        : 'publisher-preflight.json',
    ),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
}
console.log(
  JSON.stringify({
    ok: result.ok,
    beforeSendReached: result.productionBeforeSendReached,
    closedNormally: result.closedNormally,
    error: result.error,
  }),
);
if (!result.ok) process.exitCode = 1;
