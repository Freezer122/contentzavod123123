import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { AdsPowerProvider } from '../src/browser/providers.js';
import { assert } from '../src/core/errors.js';
const output = '/var/lib/content-factory/reports/first-publication';
const intent = JSON.parse(
  await readFile('/var/lib/content-factory/approvals/first-publication.json', 'utf8'),
);
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const provider = new AdsPowerProvider(
  process.env.ADSPOWER_BASE_URL!,
  process.env.ADSPOWER_API_KEY!,
  undefined,
  ['k1j71gt4'],
);
assert(!(await provider.status('k1j71gt4')), 'PROFILE_BUSY', 'Profile is open');
const report: Record<string, unknown> = {
  mode: 'READ_ONLY_RECONCILIATION',
  postsSent: 0,
  commentsSent: 0,
};
let browser;
const candidates = new Map<string, unknown>();
const pending: Promise<void>[] = [];
try {
  const started = await provider.start('k1j71gt4');
  browser = await chromium.connectOverCDP(started.cdpEndpoint);
  const page = await browser.contexts()[0]!.newPage();
  page.setDefaultTimeout(20000);
  page.on('response', (response) => {
    if (!response.url().includes('/graphql')) return;
    pending.push(
      (async () => {
        try {
          let raw = await response.text();
          raw = raw.replace(/^for\s*\(;;\);\s*/, '');
          const visit = (value: any) => {
            if (!value || typeof value !== 'object') return;
            if (value.user?.username === 'beh4ppy01' && typeof value.code === 'string') {
              const text = value.caption?.text ?? value.text ?? '';
              if (typeof text === 'string' && normalize(text) === normalize(intent.post))
                candidates.set(value.code, { code: value.code, text, takenAt: value.taken_at });
            }
            for (const item of Object.values(value)) if (typeof item === 'object') visit(item);
          };
          for (const line of raw.split('\n')) {
            try {
              visit(JSON.parse(line));
            } catch {}
          }
        } catch {}
      })(),
    );
  });
  await page.goto('https://www.threads.com/@beh4ppy01', { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /^(Edit profile|Profil bearbeiten|Редактировать профиль)$/i })
    .filter({ visible: true })
    .waitFor();
  await page.waitForTimeout(5000);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(3000);
  report.profileText = await page.locator('body').innerText();
  report.profileLinks = await page
    .locator('a[href*="/post/"]')
    .evaluateAll((nodes) =>
      nodes.map((n) => ({ href: n.getAttribute('href'), visible: !!n.getClientRects().length })),
    );
  await page.screenshot({ path: output + '/reconcile-profile.png', fullPage: true });
  await Promise.allSettled(pending);
  report.networkMatches = [...candidates.values()];
  const codes = new Set(candidates.keys());
  for (const link of report.profileLinks as { href: string }[]) {
    const m = link.href.match(/^\/@beh4ppy01\/post\/([^/]+)$/);
    if (m) codes.add(m[1]!);
  }
  const matches = [];
  for (const code of codes) {
    assert(/^[a-zA-Z0-9_-]+$/.test(code), 'INVALID_CODE', 'Invalid permalink');
    const url = 'https://www.threads.com/@beh4ppy01/post/' + code;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const body = await page.locator('body').innerText();
    const exactTextMatch = normalize(body).includes(normalize(intent.post));
    matches.push({ url, exactTextMatch, body });
    if (exactTextMatch)
      await page.screenshot({ path: output + '/confirmed-post.png', fullPage: true });
  }
  report.matches = matches;
  report.ok = matches.filter((m) => m.exactTextMatch).length === 1;
  await page.close();
} catch (e) {
  report.ok = false;
  report.error = e instanceof Error ? e.message : String(e);
} finally {
  await provider.stop('k1j71gt4');
  report.closedNormally = !(await provider.status('k1j71gt4'));
  await browser?.close().catch(() => {});
  await writeFile(output + '/post-reconciliation.json', JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
}
console.log(
  JSON.stringify({
    ok: report.ok,
    matches: report.matches,
    profileLinks: report.profileLinks,
    networkMatches: report.networkMatches,
    closedNormally: report.closedNormally,
    error: report.error,
  }),
);
