import { beforeAll, afterAll, it, expect } from 'vitest';
import { fixtureBrowser } from '../src/browser/fixture.js';
import { ThreadsEngagementPort } from '../src/engagement/browser.js';
import { fixture } from './helpers.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Candidate, ReplyDraft, EngagementJob } from '../src/engagement/service.js';
let connection: Awaited<ReturnType<typeof fixtureBrowser>>;
beforeAll(async () => {
  connection = await fixtureBrowser();
}, 45000);
afterAll(async () => {
  await connection?.close();
});
async function setup(wrongParent = false, nested = false, renderDelayMs = 0, sourceUi = false) {
  const f = await fixture(),
    context = await connection.browser.newContext(),
    page = await context.newPage(),
    dir = await mkdtemp(join(tmpdir(), 'cf-engagement-browser-'));
  page.setDefaultTimeout(3000);
  let sends = 0,
    likes = 0;
  const selectors = {
    baseUrl: 'https://www.threads.com',
    loggedIn: '#logged-in',
    identity: 'a.identity[href="/@{username}"]',
    challenge: '#challenge',
    restricted: '#restricted',
    ownPost: 'article.post',
    postLink: 'a.permalink',
    reply: '.reply',
    dialog: '#composer',
    editor: '[contenteditable=true]',
    replySubmit: '#reply-submit',
    comment: 'article.comment',
  };
  const path = join(dir, 'selectors.json');
  await writeFile(path, JSON.stringify(selectors));
  await context.route('**/*', (r) => r.abort());
  await context.route('https://www.threads.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/like') {
      likes++;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/reply') {
      sends++;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><body>${renderDelayMs ? '<style id="late-style">.comment{display:none}</style>' : ''}<a id="logged-in">Вход выполнен</a><a class="identity" href="/@test_account">Мой профиль</a><article class="post"><a class="permalink" href="${wrongParent && path.includes('/@test_account/post/') ? '/@other/post/wrong' : '/@other/post/one'}">Пост</a><p dir="auto">трейдинг требует контроля риска</p><button class="reply" onclick="openEditor()">Reply</button><button id="heart" onclick="fetch('/like',{method:'POST'});this.setAttribute('aria-pressed','true');this.querySelector('svg').setAttribute('title','Unlike');"><svg title="Gefällt mir"></svg>22</button></article>${sends ? (nested ? '<article class="comment outer">' : '') + '<article class="comment"><a href="/@test_account">test_account</a><span>сначала нужно определить допустимый риск</span><a class="permalink" href="/@test_account/post/result">ответ</a></article>' + (nested ? '</article>' : '') : ''}<script>setTimeout(()=>document.querySelector('#late-style')?.remove(),${renderDelayMs});document.addEventListener('click',e=>{if(e.target.id==='reply-submit')setTimeout(()=>document.querySelector('#composer')?.remove(),10);});function openEditor(){const d=document.createElement('div');d.id='composer';d.innerHTML='<div contenteditable="true" role="textbox"></div><button id="reply-submit" onclick="fetch(\\'/reply\\',{method:\\'POST\\'})">Reply</button>';document.body.append(d);}document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('#composer')?.remove();});</script></body></html>`,
    });
  });
  if (sourceUi) {
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const post = document.querySelector('article.post')!;
        post.insertAdjacentHTML('afterbegin', '<div dir="auto">Antwort an @other</div>');
        post.insertAdjacentHTML('beforeend', '<span dir="auto">Noch keine Antworten</span>');
        post.setAttribute('style', 'margin-top:1200px');
      });
    });
  }
  const port = new ThreadsEngagementPort(
      { use: async (_id, _purpose, fn) => fn(page, f.account, new AbortController().signal) },
      path,
    ),
    candidate: Candidate = {
      id: 'candidate',
      accountId: f.account.id,
      url: 'https://www.threads.com/@other/post/one',
      author: 'other',
      text: 'трейдинг требует контроля риска',
      language: 'ru',
      category: 'трейдинг',
      discoveredAt: new Date().toISOString(),
      repliesAvailable: true,
      status: 'DRAFTED',
    },
    draft: ReplyDraft = {
      id: 'draft',
      accountId: f.account.id,
      candidateId: candidate.id,
      text: 'сначала нужно определить допустимый риск',
      hash: 'hash',
      status: 'APPROVED',
    },
    job: EngagementJob = {
      id: 'job',
      accountId: f.account.id,
      candidateId: candidate.id,
      draftId: draft.id,
      kind: 'REPLY',
      hash: 'hash',
      actor: '1',
      status: 'QUEUED',
      scheduledAt: new Date().toISOString(),
    };
  return {
    f,
    port,
    candidate,
    draft,
    job,
    page,
    counts: () => ({ sends, likes }),
    close: async () => {
      await context.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
it('ответ и лайк DRY_RUN: ввод очищается, ни одного submit/click', async () => {
  const x = await setup();
  try {
    const noSend = async () => {
      throw new Error('must not send');
    };
    await x.port.like({ ...x.job, kind: 'LIKE' }, x.candidate, false, noSend);
    await x.port.reply(x.job, x.draft, x.candidate, false, noSend);
    expect(x.counts()).toEqual({ sends: 0, likes: 0 });
    expect(await x.page.locator('#composer').count()).toBe(0);
  } finally {
    await x.close();
  }
});
it('счётчик и NBSP в кнопке лайка не ломают селектор; барьер и проверка состояния', async () => {
  const x = await setup();
  let barriers = 0;
  try {
    await x.port.like({ ...x.job, kind: 'LIKE' }, x.candidate, true, async () => {
      barriers++;
    });
    expect(barriers).toBe(1);
    expect(x.counts().likes).toBe(1);
    expect(await x.page.locator('#heart').getAttribute('aria-pressed')).toBe('true');
  } finally {
    await x.close();
  }
});

it('один submit: подтверждает точный текст, аккаунт, родительский пост и permalink на фикстуре', async () => {
  const x = await setup();
  let barriers = 0;
  try {
    const result = await x.port.reply(x.job, x.draft, x.candidate, true, async () => {
      barriers++;
    });
    expect(result.url).toBe('https://www.threads.com/@test_account/post/result');
    expect(x.counts().sends).toBe(1);
    expect(barriers).toBe(1);
  } finally {
    await x.close();
  }
});
it('не подтверждает permalink без связи с исходной публикацией', async () => {
  const x = await setup(true);
  try {
    await expect(
      x.port.reply(x.job, x.draft, x.candidate, true, async () => {}),
    ).rejects.toMatchObject({ code: 'UNCERTAIN' });
    expect(x.counts().sends).toBe(1);
  } finally {
    await x.close();
  }
});
it('read-only проверка не придумывает permalink и ничего не отправляет', async () => {
  const x = await setup();
  try {
    expect(await x.port.verify({ ...x.job, status: 'UNCERTAIN' }, x.draft, x.candidate)).toEqual({
      url: null,
    });
    expect(x.counts()).toEqual({ sends: 0, likes: 0 });
  } finally {
    await x.close();
  }
});

it('вложенные контейнеры одного ответа не создают ложный UNCERTAIN', async () => {
  const f = await setup(false, true);
  try {
    await f.port.reply(f.job, f.draft, f.candidate, true, async () => {});
    const result = await f.port.verify(f.job, f.draft, f.candidate);
    expect(result.url).toContain('/post/result');
    expect(f.counts().sends).toBe(1);
  } finally {
    await f.close();
  }
});

it('поздняя отрисовка ответа не теряется из-за повторной перезагрузки', async () => {
  const f = await setup(false, false, 4000);
  try {
    const result = await f.port.reply(f.job, f.draft, f.candidate, true, async () => {});
    expect(result.url).toContain('/post/result');
    expect(f.counts().sends).toBe(1);
  } finally {
    await f.close();
  }
}, 45000);

it('AUTOPILOT: точное тело исходника перечитывается до редактора; изменение не вызывает submit', async () => {
  const x = await setup();
  try {
    const job = { ...x.job, executionScope: 'AUTOPILOT' as const };
    await x.port.reply(job, x.draft, x.candidate, false, async () => {
      throw Error('must not send');
    });
    expect(x.counts().sends).toBe(0);
    await expect(
      x.port.reply(
        job,
        x.draft,
        { ...x.candidate, text: 'исходник раньше содержал другой текст' },
        true,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(x.counts().sends).toBe(0);
  } finally {
    await x.close();
  }
});

it('AUTOPILOT: прокручивает исходник ниже экрана и отделяет подписи интерфейса от прозы', async () => {
  const x = await setup(false, false, 0, true);
  try {
    const source = await x.port.readPost(x.candidate.accountId, x.candidate.url);
    expect(source.text).toBe(x.candidate.text);
    await x.port.reply(
      { ...x.job, executionScope: 'AUTOPILOT' },
      x.draft,
      x.candidate,
      false,
      async () => {
        throw Error('must not send');
      },
    );
    expect(x.counts()).toEqual({ sends: 0, likes: 0 });
    expect(await x.page.locator('#composer').count()).toBe(0);
  } finally {
    await x.close();
  }
});
