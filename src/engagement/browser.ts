import { hashDocument } from '../db/documents.js';
import { visibleResults, waitResults } from '../browser/results.js';
import { FeedDiscovery, readFeedCards } from './discovery.js';
import { tradingSearchQueries } from './relevance.js';
import type { Page, Locator } from 'playwright';
import { readFile } from 'node:fs/promises';
import type { BrowserAccess } from '../browser/coordinator.js';
import type {
  Candidate,
  EngagementSettings,
  EngagementJob,
  ReplyDraft,
  EngagementPort,
} from './service.js';
import type { Selectors } from '../browser/publisher.js';
import { assert, AppError } from '../core/errors.js';
async function one(locator: Locator) {
  const l = locator.filter({ visible: true });
  await l.first().waitFor();
  assert((await l.count()) === 1, 'UI_CHANGED', 'Неоднозначный элемент Threads');
  return l;
}
export class ThreadsEngagementPort implements EngagementPort {
  constructor(
    private access: BrowserAccess,
    private selectorsPath: string,
  ) {}
  private async selectors() {
    return JSON.parse(await readFile(this.selectorsPath, 'utf8')) as Selectors;
  }
  private async guard(page: Page, s: Selectors, username: string) {
    assert(!(await page.locator(s.challenge).count()), 'CHALLENGE', 'Нужна ручная проверка');
    assert(!(await page.locator(s.restricted).count()), 'RESTRICTED', 'Ограничение аккаунта');
    await one(page.locator(s.loggedIn));
    await one(page.locator(s.identity.replaceAll('{username}', username)));
  }
  async search(
    accountId: string,
    config: EngagementSettings,
    options?: { targetCandidates?: number },
  ) {
    return this.access.use(accountId, 'SEARCH', async (page, a, signal) => {
      const s = await this.selectors();
      return new FeedDiscovery(s, (p, account) => this.guard(p, s, account.username)).search(
        page,
        a,
        config,
        signal,
        options,
      );
    });
  }
  async readPost(accountId: string, url: string) {
    return this.access.use(accountId, 'PROFILE', async (page, a) => {
      const s = await this.selectors();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await this.guard(page, s, a.username);
      const path = new URL(url).pathname;
      const target = page.locator(s.ownPost).filter({
        has: page.locator(
          `${s.postLink}[href=${JSON.stringify(path)}],${s.postLink}[href=${JSON.stringify(url)}]`,
        ),
      });
      if ((await target.count()) === 1) await target.scrollIntoViewIfNeeded();
      const end = Date.now() + 12000;
      do {
        const rows = (
          await page.locator(s.ownPost).evaluateAll(readFeedCards, {
            ownPost: s.ownPost,
            postLink: s.postLink,
            reply: s.reply,
          })
        ).filter((r) => new URL(r.url).pathname === path);
        if (rows.length === 1 && rows[0]!.text.trim())
          return {
            text: rows[0]!.text,
            domMetadata: rows[0]!.domMetadata,
            extractionVersion: 'threads-body-v115',
            ...(rows[0]!.datetime
              ? { publishedAt: rows[0]!.datetime!, timestampConfidence: 'EXACT' as const }
              : {}),
          };
        await page.waitForTimeout(2000);
      } while (Date.now() < end);
      throw new AppError(
        'SOURCE_UNCERTAIN',
        'Не удалось однозначно прочитать текст исходного поста. LLM не вызвана',
      );
    });
  }
  async reply(
    job: EngagementJob,
    draft: ReplyDraft,
    candidate: Candidate,
    commit: boolean,
    beforeSend: () => Promise<void>,
    progress?: (phase: NonNullable<EngagementJob['phase']>) => Promise<void>,
  ) {
    return this.access.use(job.accountId, 'REPLY', async (page, a, signal) => {
      const s = await this.selectors();
      await progress?.('OPENING');
      await page.goto(candidate.url, { waitUntil: 'domcontentloaded' });
      await this.guard(page, s, a.username);
      const original = await one(
        page.locator(s.ownPost).filter({
          has: page.locator(
            `${s.postLink}[href=${JSON.stringify(new URL(candidate.url).pathname)}],${s.postLink}[href=${JSON.stringify(candidate.url)}]`,
          ),
        }),
      );
      if (job.executionScope === 'AUTOPILOT') {
        await original.scrollIntoViewIfNeeded();
        const body = (v: string) =>
          v
            .replace(
              /^(?:Antwort an|Replying to|Ответ(?:ить)?(?: пользователю)?)\s+@?[\w.]+(?:\s*…)?\s*$/gim,
              '',
            )
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/gu, ' ')
            .trim();
        let matches = false,
          lastCount = 0,
          lastLength = 0;
        const deadline = Date.now() + 12000;
        do {
          const live = (
            await page.locator(s.ownPost).evaluateAll(readFeedCards, {
              ownPost: s.ownPost,
              postLink: s.postLink,
              reply: s.reply,
            })
          ).filter((r) => new URL(r.url).pathname === new URL(candidate.url).pathname);
          lastCount = live.length;
          lastLength = live[0]?.text.length ?? 0;
          matches =
            live.length === 1 &&
            hashDocument(body(live[0]!.text)) === hashDocument(body(candidate.text));
          if (matches) break;
          await page.waitForTimeout(2000);
        } while (Date.now() < deadline);
        assert(
          matches,
          'SOURCE_CHANGED',
          `Исходный пост изменился или не подтверждён; отправки нет (карточек ${lastCount}, символов ${lastLength}/${candidate.text.length})`,
        );
      }
      const own = () => visibleResults(page, s.comment, s.postLink, draft.text, a.username);
      assert(
        (await own()).length === 0,
        'UNCERTAIN',
        'Уже виден похожий собственный ответ. Сначала ручная сверка',
      );
      await (await one(original.locator(s.reply))).click();
      const dialog = await one(page.locator(s.dialog)),
        editor = await one(dialog.locator(s.editor));
      assert(
        !(await editor.innerText()).trim(),
        'EXISTING_DRAFT',
        'Редактор содержит другой черновик',
      );
      let submitted = false;
      try {
        await editor.fill(draft.text);
        assert(
          (await editor.innerText()).trim() === draft.text,
          'TEXT_MISMATCH',
          'Текст ответа не совпал',
        );
        const button = await one(dialog.locator(s.replySubmit));
        assert(await button.isEnabled(), 'UI_CHANGED', 'Отправка недоступна');
        await progress?.('EDITOR_READY');
        if (!commit) return { url: null };
        signal.throwIfAborted();
        await this.guard(page, s, a.username);
        await beforeSend();
        submitted = true;
        await button.click();
        await progress?.('VERIFYING');
        await dialog.waitFor({ state: 'hidden', timeout: 30000 });
        const until = Date.now() + 90000;
        while (Date.now() < until) {
          signal.throwIfAborted();
          const rows = await waitResults(
            page,
            s.comment,
            s.postLink,
            draft.text,
            a.username,
            Math.min(5000, Math.max(1, until - Date.now())),
          );
          if (rows.length === 1) {
            const links = rows[0]!.urls;
            const urls = [...new Set(links)].filter(
              (url) =>
                new URL(url).protocol === 'https:' &&
                ['www.threads.com', 'threads.com'].includes(new URL(url).hostname) &&
                new URL(url).pathname.startsWith(`/@${a.username}/post/`),
            );
            if (urls.length === 1) {
              const url = urls[0]!;
              await page.goto(url, { waitUntil: 'domcontentloaded' });
              await this.guard(page, s, a.username);
              const reply = await waitResults(page, s.comment, s.postLink, draft.text, a.username);
              assert(reply.length === 1, 'UNCERTAIN', 'Ответ не подтверждён прямым чтением');
              assert(
                (await page
                  .locator(
                    `${s.postLink}[href=${JSON.stringify(new URL(candidate.url).pathname)}],${s.postLink}[href=${JSON.stringify(candidate.url)}]`,
                  )
                  .count()) > 0,
                'UNCERTAIN',
                'Не подтверждена связь ответа с исходным постом',
              );
              return { url };
            }
          }
          await page.waitForTimeout(2500);
          await page.reload({ waitUntil: 'domcontentloaded' });
        }
        throw new AppError('UNCERTAIN', 'URL ответа не подтверждён');
      } finally {
        if (!submitted) {
          await editor.fill('').catch(() => {});
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
    });
  }
  async verify(job: EngagementJob, draft: ReplyDraft, candidate: Candidate) {
    return this.access.use(job.accountId, 'REPLY', async (page, a) => {
      const s = await this.selectors();
      const sourceLinks = `${s.postLink}[href=${JSON.stringify(new URL(candidate.url).pathname)}],${s.postLink}[href=${JSON.stringify(candidate.url)}]`;
      await page.goto(candidate.url, { waitUntil: 'domcontentloaded' });
      await this.guard(page, s, a.username);
      let rows = await waitResults(page, s.comment, s.postLink, draft.text, a.username);
      if (rows.length !== 1) {
        await page.goto(`https://www.threads.com/@${a.username}/replies`, {
          waitUntil: 'domcontentloaded',
        });
        await this.guard(page, s, a.username);
        rows = await waitResults(page, s.comment, s.postLink, draft.text, a.username);
      }
      if (rows.length !== 1) return { url: null };
      const links = rows[0]!.urls;
      const urls = [...new Set(links)].filter((url) => {
        const u = new URL(url);
        return (
          u.protocol === 'https:' &&
          ['www.threads.com', 'threads.com'].includes(u.hostname) &&
          u.pathname.startsWith(`/@${a.username}/post/`)
        );
      });
      if (urls.length !== 1) return { url: null };
      await page.goto(urls[0]!, { waitUntil: 'domcontentloaded' });
      await this.guard(page, s, a.username);
      const own = await waitResults(page, s.comment, s.postLink, draft.text, a.username);
      await page
        .locator(sourceLinks)
        .first()
        .waitFor({ state: 'attached', timeout: 5000 })
        .catch(() => {});
      if (own.length !== 1 || !(await page.locator(sourceLinks).count())) return { url: null };
      return { url: urls[0]! };
    });
  }
  async like(
    job: EngagementJob,
    candidate: Candidate,
    commit: boolean,
    beforeSend: () => Promise<void>,
  ) {
    return this.access.use(job.accountId, 'REPLY', async (page, a, signal) => {
      const s = await this.selectors();
      await page.goto(candidate.url, { waitUntil: 'domcontentloaded' });
      await this.guard(page, s, a.username);
      const original = await one(
        page.locator(s.ownPost).filter({
          has: page.locator(
            `${s.postLink}[href=${JSON.stringify(new URL(candidate.url).pathname)}],${s.postLink}[href=${JSON.stringify(candidate.url)}]`,
          ),
        }),
      );
      const heart = page.locator(
        'svg[title="Like"],svg[title="Gefällt mir"],svg[title="Gefällt mir"],svg[title="Нравится"]',
      );
      const likedHeart = page.locator(
        'svg[title="Unlike"],svg[title="Gefällt mir nicht mehr"],svg[title="Gefällt mir nicht mehr"],svg[title="Не нравится"]',
      );
      const liked = original
        .getByRole('button', {
          name: /^(Unlike|Gefällt[\s\u00a0]+mir[\s\u00a0]+nicht[\s\u00a0]+mehr|Убрать отметку «Нравится»|Не нравится)(?:\s*[\d.,]+[KkMmTt]?)?$/i,
        })
        .or(original.getByRole('button').filter({ has: likedHeart }))
        .or(original.locator('[role=button][aria-pressed=true]').filter({ has: heart }))
        .filter({ visible: true });
      assert((await liked.count()) === 0, 'ALREADY_LIKED', 'Публикация уже отмечена');
      const button = await one(
        original
          .getByRole('button')
          .filter({ has: heart })
          .or(
            original.getByRole('button', {
              name: /^(Like|Gefällt[\s\u00a0]+mir|Нравится)(?:\s*[\d.,]+[KkMmTt]?)?$/i,
            }),
          ),
      );
      if (!commit) return;
      signal.throwIfAborted();
      await beforeSend();
      await button.click();
      await liked.waitFor({ state: 'visible' });
    });
  }
}
