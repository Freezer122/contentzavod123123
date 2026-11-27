import { chromium } from 'playwright';
import { AdsPowerProvider } from '../src/browser/providers.js';
import { assert } from '../src/core/errors.js';
import { writeFile } from 'node:fs/promises';
const provider = new AdsPowerProvider(
  process.env.ADSPOWER_BASE_URL!,
  process.env.ADSPOWER_API_KEY!,
  undefined,
  ['k1j71gt4'],
  process.env.ADSPOWER_HEADLESS === '1',
);
assert(!(await provider.status('k1j71gt4')), 'PROFILE_BUSY', 'Profile is open');
const report: Record<string, unknown> = {
  mode: 'READ_ONLY_SINGLE_PROFILE_BENCHMARK',
  postsSent: 0,
  commentsSent: 0,
  llmRequests: 0,
  startedAt: new Date().toISOString(),
};
let browser;
try {
  const session = await provider.start('k1j71gt4');
  browser = await chromium.connectOverCDP(session.cdpEndpoint);
  const page = await browser.contexts()[0]!.newPage();
  await page.goto('https://www.threads.com/@beh4ppy01/post/Df6zbr6AkyI', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page
    .getByText('почему никто не говорит что проп-фирмы изменили розничную торговлю навсегда?', {
      exact: false,
    })
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 30000 });
  report.existingPostRead = true;
  await page.waitForTimeout(45000);
  await page.close();
  report.ok = true;
} catch (e) {
  report.ok = false;
  report.error = e instanceof Error ? e.message : String(e);
} finally {
  await provider.stop('k1j71gt4');
  report.closedNormally = !(await provider.status('k1j71gt4'));
  await browser?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await writeFile(
    process.env.BENCHMARK_OUTPUT ?? '/var/lib/content-factory/reports/v15-benchmark.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
}
console.log(JSON.stringify(report));
