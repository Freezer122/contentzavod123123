import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { AdsPowerProvider } from '../src/browser/providers.js';
import { assert } from '../src/core/errors.js';
const out = '/var/lib/content-factory/reports/first-publication';
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
  mode: 'READ_ONLY_CTA_RECONCILIATION',
  postsSent: 0,
  commentsSent: 0,
};
let browser;
try {
  const session = await provider.start('k1j71gt4');
  browser = await chromium.connectOverCDP(session.cdpEndpoint);
  const page = await browser.contexts()[0]!.newPage();
  page.setDefaultTimeout(20000);
  const original = 'https://www.threads.com/@beh4ppy01/post/Df6zbr6AkyI';
  await page.goto(original, { waitUntil: 'domcontentloaded' });
  await page.locator('a[href*="/post/"]').filter({ visible: true }).first().waitFor();
  await page.waitForTimeout(3000);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(2000);
  report.threadText = await page.locator('body').innerText();
  const links = await page.locator('a[href*="/post/"]').evaluateAll((nodes) =>
    nodes.map((n) => ({
      href: (n as HTMLAnchorElement).href,
      text: n.textContent,
      ancestors: (() => {
        const rows = [];
        let e: Element | null = n;
        for (let i = 0; e && i < 12; i++, e = e.parentElement)
          rows.push({
            tag: e.tagName,
            pressable: e.getAttribute('data-pressable-container'),
            role: e.getAttribute('role'),
            text: e.textContent?.slice(0, 650),
          });
        return rows;
      })(),
    })),
  );
  report.links = links;
  await page.screenshot({ path: out + '/post-and-cta.png', fullPage: true });
  const urls = [
    ...new Set(
      links
        .map((l) => l.href)
        .filter(
          (u) =>
            /^https:\/\/www\.threads\.com\/@beh4ppy01\/post\/[a-zA-Z0-9_-]+$/.test(u) &&
            u !== original,
        ),
    ),
  ];
  const matches = [];
  for (const url of urls) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const body = await page.locator('body').innerText();
    const images = await page.locator('img').evaluateAll((nodes) =>
      nodes
        .map((node) => node as HTMLImageElement)
        .filter(
          (n) =>
            n.complete &&
            n.naturalWidth > 0 &&
            n.getBoundingClientRect().width >= 80 &&
            n.getBoundingClientRect().height >= 80,
        )
        .map((n) => ({
          naturalWidth: n.naturalWidth,
          naturalHeight: n.naturalHeight,
          width: n.getBoundingClientRect().width,
          height: n.getBoundingClientRect().height,
          alt: n.alt,
        })),
    );
    const match = {
      url,
      exactTextMatch: normalize(body).includes(normalize(intent.cta)),
      images,
      body,
    };
    matches.push(match);
    if (match.exactTextMatch && images.length)
      await page.screenshot({ path: out + '/confirmed-cta.png', fullPage: true });
  }
  report.matches = matches;
  report.ok = matches.filter((m) => m.exactTextMatch && m.images.length).length === 1;
  await page.close();
} catch (e) {
  report.ok = false;
  report.error = e instanceof Error ? e.message : String(e);
} finally {
  await provider.stop('k1j71gt4');
  report.closedNormally = !(await provider.status('k1j71gt4'));
  await browser?.close().catch(() => {});
  await writeFile(out + '/cta-reconciliation.json', JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
}
console.log(
  JSON.stringify({
    ok: report.ok,
    matches: report.matches,
    closedNormally: report.closedNormally,
    error: report.error,
  }),
);
