import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { BrowserCoordinator } from '../src/browser/coordinator.js';
import { readFile, writeFile } from 'node:fs/promises';
import { assert } from '../src/core/errors.js';
const config = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }),
  app = await createApplication(config);
try {
  const c = await app.services.engagement.candidate('threads02', '8ddbe8cd9277f61066dcaa83');
  const s = JSON.parse(await readFile(config.THREADS_SELECTORS_PATH, 'utf8'));
  const result = await new BrowserCoordinator(app.db, app.services.providers).use(
    'threads02',
    'PROFILE',
    async (page, a) => {
      await page.goto(c.url, { waitUntil: 'domcontentloaded' });
      await page.locator(s.loggedIn).filter({ visible: true }).first().waitFor();
      assert(
        !(await page.locator(s.challenge).count()) && !(await page.locator(s.restricted).count()),
        'CHALLENGE',
        'Manual check needed',
      );
      await page
        .locator(s.identity.replaceAll('{username}', a.username))
        .filter({ visible: true })
        .first()
        .waitFor();
      await page.waitForTimeout(2500);
      return page.locator(s.ownPost).evaluateAll(
        (nodes, args) =>
          nodes
            .filter((n) =>
              [...n.querySelectorAll('a')].some((a) => a.getAttribute('href') === args.path),
            )
            .slice(-3)
            .map((n) => ({
              text: (n as HTMLElement).innerText,
              blocks: [...n.querySelectorAll('[dir=auto]')].map((e) => ({
                tag: e.tagName,
                attrs: [...e.attributes]
                  .filter((a) => ['role', 'dir', 'data-testid', 'class'].includes(a.name))
                  .map((a) => [a.name, a.value]),
                text: (e as HTMLElement).innerText,
                parents: [e.parentElement, e.parentElement?.parentElement]
                  .filter(Boolean)
                  .map((p) => ({
                    tag: p!.tagName,
                    attrs: [...p!.attributes]
                      .filter((a) => a.name !== 'class')
                      .map((a) => [a.name, a.value]),
                    text: (p as HTMLElement).innerText.slice(0, 500),
                  })),
              })),
              html: n.outerHTML.slice(0, 150000),
            })),
        { path: new URL(c.url).pathname },
      );
    },
  );
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v115-source-dom.json',
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      result.map((r) => ({ text: r.text, blocks: r.blocks })),
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
