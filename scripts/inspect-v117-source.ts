import { readFeedCards } from '../src/engagement/discovery.js';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { getDocument } from '../src/db/documents.js';
import { writeFile, readFile } from 'node:fs/promises';
import { BrowserCoordinator } from '../src/browser/coordinator.js';
const cfg = loadConfig({ ...process.env, PROCESS_ROLE: 'bot' }),
  app = await createApplication(cfg);
try {
  const s = app.services,
    a: any = await getDocument(app.db, 'v117-acceptance'),
    rows = await s.autopilot.schedule('threads02'),
    out: any[] = [];
  const post = rows.find((x) => x.id === a.postSlotId)!,
    pw: any = await getDocument(app.db, `autopilot-work-${post.contentJobId}`);
  out.push({ kind: 'POST', text: pw.text, slot: post });
  for (const id of a.replySlotIds) {
    const slot = rows.find((x) => x.id === id)!,
      w: any = await getDocument(app.db, `autopilot-work-${slot.contentJobId}`),
      view = await s.engagement.jobView(w.resultId);
    out.push({
      kind: 'REPLY',
      slotId: id,
      url: view.candidate.url,
      old: view.candidate.text,
      draft: view.draft?.text,
    });
  }
  const target = out[2].url,
    selectors = JSON.parse(await readFile(cfg.THREADS_SELECTORS_PATH, 'utf8'));
  const dom = await new BrowserCoordinator(app.db, s.providers).use(
    'threads02',
    'PROFILE',
    async (page) => {
      await page.goto(target, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const targetCard = page
        .locator(selectors.ownPost)
        .filter({ has: page.locator(`a[href=${JSON.stringify(new URL(target).pathname)}]`) });
      await targetCard.scrollIntoViewIfNeeded();
      return {
        url: page.url(),
        parsed: await page.locator(selectors.ownPost).evaluateAll(readFeedCards, {
          ownPost: selectors.ownPost,
          postLink: selectors.postLink,
          reply: selectors.reply,
        }),
        blocks: await targetCard.locator('[dir=auto]').evaluateAll((ns) =>
          ns.map((n) => ({
            text: (n as HTMLElement).innerText,
            role: n.closest('[role]')?.getAttribute('role'),
            href: n.closest('a')?.getAttribute('href'),
            html: n.parentElement?.outerHTML.slice(0, 600),
          })),
        ),
        body: (await page.locator('body').innerText()).slice(0, 5000),
        cards: await page.locator(selectors.ownPost).evaluateAll((ns) =>
          ns.slice(0, 15).map((n) => ({
            text: (n as HTMLElement).innerText.slice(0, 1500),
            box: {
              top: n.getBoundingClientRect().top,
              height: n.getBoundingClientRect().height,
            },
            times: [...n.querySelectorAll('time')].map((t) => ({
              at: t.getAttribute('datetime'),
              href: t.closest('a')?.getAttribute('href'),
            })),
            links: [...n.querySelectorAll('a[href*="/post/"]')].map((a) => a.getAttribute('href')),
            dirs: n.querySelectorAll('[dir=auto]').length,
          })),
        ),
      };
    },
  );
  const result = { out, dom };
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v117-source-compare.json',
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
} finally {
  await app.close();
}
