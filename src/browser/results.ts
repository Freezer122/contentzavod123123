import type { Page } from 'playwright';
export interface VisibleResult {
  urls: string[];
  mediaCount: number;
}
export async function visibleResults(
  page: Page,
  selector: string,
  postLink: string,
  text: string,
  username: string,
  mediaSelector?: string,
): Promise<VisibleResult[]> {
  return page.locator(selector).evaluateAll(
    (nodes, args) => {
      const plain = (s: string) =>
        s
          .replace(/\p{Cf}/gu, '')
          .replace(/\s+/g, ' ')
          .trim();
      const expected = plain(args.text);
      const matching = nodes.filter((n) => {
        const box = n.getBoundingClientRect();
        if (!box.width || !box.height) return false;
        if (!expected || !plain((n as HTMLElement).innerText).includes(expected)) return false;
        return [...n.querySelectorAll('a[href]')].some((a) => {
          try {
            const path = new URL((a as HTMLAnchorElement).href).pathname.replace(/\/$/, '');
            return path === `/@${args.username}` || path.startsWith(`/@${args.username}/post/`);
          } catch {
            return false;
          }
        });
      });
      return matching
        .filter((n) => !matching.some((child) => child !== n && n.contains(child)))
        .map((n) => ({
          urls: [
            ...new Set(
              [...n.querySelectorAll(args.postLink)].map((a) => (a as HTMLAnchorElement).href),
            ),
          ],
          mediaCount: args.mediaSelector
            ? [...n.querySelectorAll(args.mediaSelector)].filter(
                (img) =>
                  img instanceof HTMLImageElement &&
                  img.complete &&
                  img.naturalWidth > 0 &&
                  img.getBoundingClientRect().width >= 80 &&
                  img.getBoundingClientRect().height >= 80,
              ).length
            : 0,
        }));
    },
    { text, username, postLink, mediaSelector },
  );
}
export async function waitResults(
  page: Page,
  selector: string,
  postLink: string,
  text: string,
  username: string,
  timeoutMs = 7000,
) {
  const end = Date.now() + timeoutMs;
  let result = await visibleResults(page, selector, postLink, text, username);
  while (!result.length && Date.now() < end) {
    await page.waitForTimeout(Math.min(1000, Math.max(1, end - Date.now())));
    result = await visibleResults(page, selector, postLink, text, username);
  }
  return result;
}
