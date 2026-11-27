import { beforeAll, afterAll, it, expect } from 'vitest';
import { fixtureBrowser } from '../src/browser/fixture.js';
import { FeedDiscovery } from '../src/engagement/discovery.js';
import { engagementSettings } from '../src/engagement/service.js';
import { freshness } from '../src/engagement/freshness.js';
import { fixture } from './helpers.js';
let connection: Awaited<ReturnType<typeof fixtureBrowser>>;
beforeAll(async () => {
  connection = await fixtureBrowser();
}, 45000);
afterAll(async () => {
  await connection?.close();
});
it('V1.15 отделяет тело, автора, время, перевод и счётчики; числа и ссылки автора сохраняются', async () => {
  const context = await connection.browser.newContext(),
    page = await context.newPage(),
    f = await fixture();
  await context.route('**/*', (r) => r.abort());
  await context.route('https://www.threads.com/**', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<meta charset=utf-8><article class=post><a href='/@other'><span dir=auto>other</span></a><span dir=auto><a href='/@other/post/clean'><time datetime='${new Date().toISOString()}'>1 Tag</time></a></span><div><span dir=auto>BTC по 100000, риск 2%<br>27<br><a href='https://example.com/API_Key'>API_Key</a><div role=button>Übersetzen</div></span></div><button aria-label=likes><span dir=auto>30</span></button><button class=reply><span dir=auto>16</span></button><div role=button><span dir=auto>Beliebteste</span></div><div role=textbox contenteditable=true><span dir=auto>Antwort an other</span></div></article>`,
    }),
  );
  try {
    const rows = await new FeedDiscovery(
      { ownPost: 'article.post', postLink: 'a[href*=post]', reply: '.reply' } as any,
      async () => {},
    ).search(
      page,
      f.account,
      engagementSettings.parse({ discoverySource: 'FOR_YOU', viewLimit: 1 }),
      new AbortController().signal,
    );
    expect(rows[0]?.text).toBe('BTC по 100000, риск 2%\n27\nAPI_Key');
    expect(rows[0]?.domMetadata?.interfaceText).toContain('other');
    expect(rows[0]?.domMetadata?.counts.some((c) => c.text === '30')).toBe(true);
    expect(rows[0]?.extractionVersion).toBe('threads-body-v115');
  } finally {
    await context.close();
  }
});
it('лента извлекает реальные datetime, соблюдает лимит, не кликает reply и различает неизвестную дату', async () => {
  const context = await connection.browser.newContext({ viewport: { width: 1000, height: 1000 } }),
    page = await context.newPage(),
    f = await fixture();
  let submits = 0;
  await context.route('**/*', (r) => r.abort());
  const fresh = new Date(Date.now() - 3600000).toISOString();
  await context.route('https://www.threads.com/**', (route) => {
    if (route.request().method() !== 'GET') submits++;
    return route.fulfill({
      contentType: 'text/html',
      body: `<html><body><a href='/activity'>activity</a>${[fresh, '2024-11-23T11:21:29Z', null, fresh].map((date, i) => `<article class='post' style='height:110px'><a class='permalink' href='/@other/post/p${i}'><time ${date ? `datetime='${date}'` : ''}>${date ?? '2h'}</time></a><p dir='auto'>торговая стратегия и стоп-лосс требуют соблюдения риска</p><button class='reply'>ответить</button></article>`).join('')}</body></html>`,
    });
  });
  try {
    const engine = new FeedDiscovery(
      { ownPost: 'article.post', postLink: 'a.permalink', reply: '.reply' } as any,
      async () => {},
    );
    const rows = await engine.search(
      page,
      f.account,
      engagementSettings.parse({ discoverySource: 'FOR_YOU', viewLimit: 3 }),
      new AbortController().signal,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.timestampConfidence).toBe('EXACT');
    expect(freshness(rows[0]!).accepted).toBe(true);
    expect(freshness(rows[1]!).reason).toContain('старше');
    expect(rows[2]?.timestampConfidence).toBe('UNKNOWN');
    expect(freshness(rows[2]!).accepted).toBe(false);
    expect(submits).toBe(0);
    expect(context.pages()).toHaveLength(1);
  } finally {
    await context.close();
  }
});
it('дубли между группами не раздувают число просмотренных публикаций', async () => {
  const context = await connection.browser.newContext(),
    page = await context.newPage(),
    f = await fixture();
  await context.route('**/*', (r) => r.abort());
  await context.route('https://www.threads.com/**', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<article class='post'><a href='/@other/post/same'><time datetime='${new Date().toISOString()}'>now</time></a><p dir=auto>торговая стратегия для трейдинга</p><button class=reply>ответ</button></article>`,
    }),
  );
  try {
    const engine = new FeedDiscovery(
      { ownPost: 'article.post', postLink: 'a', reply: '.reply' } as any,
      async () => {},
    );
    const rows = await engine.search(
      page,
      f.account,
      engagementSettings.parse({ discoverySource: 'FOR_YOU', viewLimit: 40 }),
      new AbortController().signal,
    );
    expect(rows).toHaveLength(1);
  } finally {
    await context.close();
  }
});
it('скроллинг не возвращается к первому посту и просматривает следующие группы', async () => {
  const context = await connection.browser.newContext({ viewport: { width: 800, height: 400 } }),
    page = await context.newPage(),
    f = await fixture();
  await context.route('**/*', (r) => r.abort());
  await context.route('https://www.threads.com/**', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<html><body style='margin:0'>${Array.from({ length: 8 }, (_, i) => `<article class=post style='height:180px'><a class=permalink href='/@other/post/scroll${i}'><time datetime='${new Date().toISOString()}'>now</time></a><p dir=auto>обычная бытовая история без торгового контекста</p><button class=reply>ответ</button></article>`).join('')}</body></html>`,
    }),
  );
  try {
    const engine = new FeedDiscovery(
      { ownPost: 'article.post', postLink: 'a.permalink', reply: '.reply' } as any,
      async () => {},
    );
    const rows = await engine.search(
      page,
      f.account,
      engagementSettings.parse({ discoverySource: 'FOR_YOU', viewLimit: 40 }),
      new AbortController().signal,
    );
    expect(rows.length).toBeGreaterThan(4);
  } finally {
    await context.close();
  }
});
