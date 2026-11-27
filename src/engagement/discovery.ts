import type { Page } from 'playwright';
import type { Account } from '../core/domain.js';
import type { Selectors } from '../browser/publisher.js';
import type { Candidate, EngagementSettings } from './service.js';
import { exactTimestamp, freshness, type FeedSource } from './freshness.js';
import { tradingRelevance, tradingSearchQueries } from './relevance.js';
import { isRussian } from '../content/normalizer.js';
export type Discovered = Omit<Candidate, 'id' | 'accountId' | 'status'>;
export class FeedDiscovery {
  constructor(
    private s: Selectors,
    private guard: (p: Page, a: Account) => Promise<void>,
  ) {}
  async search(
    page: Page,
    a: Account,
    config: EngagementSettings,
    signal: AbortSignal,
    options: { targetCandidates?: number } = {},
  ): Promise<Discovered[]> {
    const found: Discovered[] = [],
      seen = new Set<string>();
    let scrolls = 0,
      fallbackReads = 0;
    const end = Date.now() + 120000;
    let detail: Page | undefined;
    const clickLabel = async (pattern: RegExp) => {
      for (const role of ['tab', 'link', 'button'] as const) {
        const target = page.getByRole(role, { name: pattern }).filter({ visible: true });
        if ((await target.count()) === 1) {
          await target.click();
          await page.waitForTimeout(1500);
          await this.guard(page, a);
          return true;
        }
      }
      return false;
    };
    const read = async (source: FeedSource) => {
      const rows = await page.locator(this.s.ownPost).evaluateAll(readFeedCards, {
        postLink: this.s.postLink,
        ownPost: this.s.ownPost,
        reply: this.s.reply,
      });
      let added = 0;
      for (const r of rows) {
        if (found.length >= config.viewLimit || Date.now() >= end) break;
        let url: URL;
        try {
          url = new URL(r.url);
        } catch {
          continue;
        }
        if (
          !['www.threads.com', 'threads.com'].includes(url.hostname) ||
          !/^\/@[\w.]+\/post\/[\w-]+\/?$/.test(url.pathname)
        )
          continue;
        const canonical = 'https://www.threads.com' + url.pathname.replace(/\/$/, '');
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        added++;
        let publishedAt = exactTimestamp(r.datetime);
        if (!publishedAt && fallbackReads < 6 && Date.now() < end) {
          fallbackReads++;
          detail ??= await page.context().newPage();
          await detail.goto(canonical, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.guard(detail, a);
          const dates = await detail.locator('time').evaluateAll(
            (ts, path) =>
              ts
                .filter((t) => {
                  const href = t.closest('a')?.getAttribute('href');
                  return href === path || href?.endsWith(path);
                })
                .map((t) => t.getAttribute('datetime')),
            url.pathname,
          );
          const exact = [...new Set(dates.map(exactTimestamp).filter(Boolean))];
          if (exact.length === 1) publishedAt = exact[0]!;
        }
        const date = freshness(
          {
            publishedAt: publishedAt ?? undefined,
            timestampConfidence: publishedAt ? 'EXACT' : 'UNKNOWN',
          },
          config.maxAgeHours,
        );
        found.push({
          url: canonical,
          author: url.pathname.split('/')[1]!.slice(1),
          text: r.text,
          language: isRussian(r.text) ? 'ru' : 'other',
          category: config.categories[0]!,
          discoveredAt: new Date().toISOString(),
          publishedAt: publishedAt ?? undefined,
          timestampConfidence: publishedAt ? 'EXACT' : 'UNKNOWN',
          ageHours: date.ageHours,
          feedSource: source,
          repliesAvailable: r.repliesAvailable,
          extractionVersion: 'threads-body-v115',
          domMetadata: r.domMetadata,
        });
      }
      return added;
    };
    try {
      const sources: ('FEED' | 'FOR_YOU' | 'FOLLOWING' | 'RECENT')[] =
        config.discoverySource === 'FEED'
          ? ['FEED', 'FOR_YOU', 'FOLLOWING', 'RECENT']
          : [config.discoverySource];
      for (const requested of sources) {
        if (found.length >= config.viewLimit || Date.now() >= end) break;
        signal.throwIfAborted();
        let source: FeedSource;
        if (requested === 'RECENT') {
          await page.goto(
            'https://www.threads.com/search?q=' +
              encodeURIComponent(tradingSearchQueries(config.keywords)[0]!),
            { waitUntil: 'domcontentloaded', timeout: 30000 },
          );
          await this.guard(page, a);
          if (!(await clickLabel(/^(Recent|Latest|Недавние|Последние|Neueste|Aktuell)$/i)))
            continue;
          source = 'RECENT';
        } else {
          await page.goto('https://www.threads.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await this.guard(page, a);
          if (requested === 'FEED') {
            // Use a topical feed only when the interface explicitly exposes it.
            const label = config.categories[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (!(await clickLabel(new RegExp('^' + label + '$', 'i')))) continue;
            source = 'THEMATIC';
          } else if (requested === 'FOLLOWING') {
            if (!(await clickLabel(/^(Following|Подписки|Gefolgt)$/i))) continue;
            source = 'FOLLOWING';
          } else {
            await clickLabel(/^(For you|Для вас|Für dich)$/i);
            source = 'FOR_YOU';
          }
        }
        await page
          .locator(this.s.ownPost)
          .first()
          .waitFor({ timeout: 12000 })
          .catch(() => {});
        for (let group = 0; group < 3 && scrolls < 9; group++) {
          signal.throwIfAborted();
          if (found.length >= config.viewLimit || Date.now() >= end) break;
          await read(source);
          const eligible = found.filter(
            (c) =>
              freshness(c, config.maxAgeHours).accepted &&
              isRussian(c.text) &&
              c.repliesAvailable &&
              tradingRelevance(c.text, config.strictness, config.exclusions, config.keywords)
                .accepted,
          ).length;
          if (eligible >= Math.min(options.targetCandidates ?? 5, config.maxCandidates)) break;
          const point = await page.locator(this.s.ownPost).evaluateAll((nodes) => {
            const box = nodes
              .map((n) => n.getBoundingClientRect())
              .find((b) => b.width && b.height && b.bottom > 60 && b.top < innerHeight - 60);
            return box
              ? {
                  x: Math.min(innerWidth - 20, Math.max(20, box.left + box.width / 2)),
                  y: Math.min(
                    innerHeight - 60,
                    Math.max(60, (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2),
                  ),
                }
              : null;
          });
          if (point) await page.mouse.move(point.x, point.y);
          await page.mouse.wheel(0, Math.max(500, await page.evaluate(() => innerHeight - 100)));
          scrolls++;
          await page.waitForTimeout(1200);
          await this.guard(page, a);
        }
        if (
          found.filter(
            (c) =>
              freshness(c, config.maxAgeHours).accepted &&
              isRussian(c.text) &&
              c.repliesAvailable &&
              tradingRelevance(c.text, config.strictness, config.exclusions, config.keywords)
                .accepted,
          ).length >= Math.min(options.targetCandidates ?? 5, config.maxCandidates)
        )
          break;
      }
      return found;
    } finally {
      await detail?.close().catch(() => {});
    }
  }
}

export function readFeedCards(
  nodes: Element[],
  args: { postLink: string; ownPost: string; reply: string },
) {
  const result: {
    url: string;
    text: string;
    datetime: string | null;
    repliesAvailable: boolean;
    domMetadata: { interfaceText: string[]; counts: { label: string; text: string }[] };
  }[] = [];
  for (const n of nodes) {
    const box = n.getBoundingClientRect();
    if (!box.height || box.bottom <= 0 || box.top >= innerHeight) continue;
    const times = [...n.querySelectorAll('time')];
    const time =
      times.find((t) => t.closest('a')?.getAttribute('href')?.includes('/post/')) ?? times[0];
    const link = time?.closest('a') ?? n.querySelector(args.postLink);
    if (!link) continue;
    // Prefer the smallest post container owning the timestamp, never a feed wrapper.
    if (time && time.closest(args.ownPost) !== n) continue;
    const url = (link as HTMLAnchorElement).href;
    const excluded =
      'button,[role=button],time,[role=textbox],[contenteditable=true],[aria-hidden=true],nav';
    const blocks = [...n.querySelectorAll('[dir=auto]')];
    const interfaceText: string[] = [];
    const eligible = blocks.filter((el) => {
      const anchor = el.closest('a'),
        href = anchor?.getAttribute('href');
      const metadata =
        !!el.closest(excluded) ||
        !!el.querySelector('time') ||
        // Threads renders this empty-state label inside the post region, outside
        // its buttons. Match a whole label only; never remove words from prose.
        (el.tagName === 'SPAN' &&
          /^(?:Noch keine Antworten|No replies yet|Пока нет ответов|Ответов пока нет)$/u.test(
            el.textContent?.trim() ?? '',
          )) ||
        !!(href && (/^\/@[\w.]+\/?$/.test(href) || href === new URL(url).pathname));
      if (metadata) interfaceText.push((el as HTMLElement).innerText);
      return !metadata;
    });
    const text = eligible
      .filter((el) => !eligible.some((other) => other !== el && other.contains(el)))
      .map((el) => {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll(excluded).forEach((e) => e.remove());
        const read = (node: Node): string =>
          node.nodeType === Node.TEXT_NODE
            ? (node.textContent ?? '')
            : node instanceof HTMLElement && node.tagName === 'BR'
              ? '\n'
              : [...node.childNodes].map(read).join('') +
                (node instanceof HTMLElement && ['DIV', 'P'].includes(node.tagName) ? '\n' : '');
        return read(clone)
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+\n/g, '\n')
          .trim();
      })
      .filter(Boolean)
      .join('\n')
      .replace(
        /^(?:Antwort an|Replying to|Ответ(?:ить)?(?: пользователю)?)\s+@?[\w.]+(?:\s*…)?\s*$/gim,
        (m) => {
          interfaceText.push(m);
          return '';
        },
      )
      .trim();
    if (!text) continue; // Fail closed; never send the whole card as author prose.
    // reply is a CSS selector in the production selector set.
    const replies = [...n.querySelectorAll(args.reply)].filter((el) => {
      const b = el.getBoundingClientRect();
      return b.height > 0;
    });
    result.push({
      url,
      text: text.slice(0, 3000),
      domMetadata: {
        interfaceText,
        counts: [...n.querySelectorAll('button,[role=button]')]
          .map((el) => ({
            label:
              el.getAttribute('aria-label') ??
              el.querySelector('svg title')?.textContent ??
              el.querySelector('[aria-label]')?.getAttribute('aria-label') ??
              '',
            text: (el as HTMLElement).innerText,
          }))
          .filter((v) => v.text || v.label),
      },
      datetime: time?.getAttribute('datetime') ?? null,
      repliesAvailable:
        replies.length === 1 &&
        replies[0]!.getAttribute('aria-disabled') !== 'true' &&
        !(replies[0] as HTMLButtonElement).disabled,
    });
  }
  return result;
}
