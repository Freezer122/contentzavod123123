import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { BrowserCoordinator } from '../src/browser/coordinator.js';
import { writeFile, readFile } from 'node:fs/promises';
const app = await createApplication(
  loadConfig({ ...process.env, PROCESS_ROLE: 'worker', BROWSER_EXECUTION_MODE: 'DRY_RUN' }),
);
try {
  const c = (await app.services.engagement.candidates('threads02'))[0]!;
  const report = await new BrowserCoordinator(app.db, app.services.providers).use(
    'threads02',
    'REPLY',
    async (page) => {
      await page.goto(c.url, { waitUntil: 'domcontentloaded' });
      const s = JSON.parse(await readFile(process.env.THREADS_SELECTORS_PATH!, 'utf8'));
      const original = page
        .locator(s.ownPost)
        .filter({ has: page.locator(s.postLink + `[href*="${new URL(c.url).pathname}"]`) })
        .filter({ visible: true });
      await original.first().waitFor();
      return {
        mode: 'READ_ONLY_LIKE_UI',
        rows: await original.count(),
        buttons: await original.getByRole('button').evaluateAll((nodes) =>
          nodes.map((n) => ({
            text: n.textContent?.slice(0, 120),
            label: n.getAttribute('aria-label'),
            pressed: n.getAttribute('aria-pressed'),
            svg: [...n.querySelectorAll('svg')].map((s) => ({
              title: s.getAttribute('title'),
              fill: s.getAttribute('fill'),
              paths: [...s.querySelectorAll('path')].map((p) => ({
                fill: p.getAttribute('fill'),
                style: p.getAttribute('style'),
              })),
            })),
          })),
        ),
        likesSent: 0,
      };
    },
  );
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v18-like-ui.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  await app.close();
}
