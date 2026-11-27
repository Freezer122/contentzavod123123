import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ThreadsSession, type Selectors } from '../src/browser/publisher.js';
import { MockBrowserProvider } from '../src/browser/providers.js';
import { fixture } from './helpers.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixtureBrowser } from '../src/browser/fixture.js';
const selectors: Selectors = {
  baseUrl: 'https://www.threads.com',
  loggedIn: '#logged-in',
  identity: "a[href='/@{username}']",
  challenge: '#challenge',
  restricted: '#restricted',
  create: '#create',
  dialog: '[role=dialog]',
  editor: '[contenteditable=true]',
  submit: '#submit',
  ownPost: 'article.post',
  postLink: 'a.permalink',
  reply: '.reply',
  replySubmit: '#reply-submit',
  comment: 'article.comment',
  mediaInput: 'input[type=file]',
  mediaPreview: 'img.attachment',
};
let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  const fixture = await fixtureBrowser();
  browser = fixture.browser;
  closeBrowser = fixture.close;
}, 30000);
afterAll(async () => {
  await closeBrowser?.();
});
async function setup(
  challenge = false,
  delayed = false,
  options: {
    nativeNotice?: boolean;
    hiddenResult?: boolean;
    confirmation?: { timeoutMs: number; pollMs: number };
  } = {},
) {
  const f = await fixture(),
    context = await browser.newContext(),
    page = await context.newPage();
  let posted = false,
    commented = false,
    sends = 0,
    readsAfterPost = 0;
  const article = () =>
    posted && !options.hiddenResult && (!delayed || ++readsAfterPost >= 3)
      ? `<article class="post"><a class="permalink" href="/@test_account/post/confirmed">Пост</a><span>Проверенный текст</span><button class="reply" onclick="openEditor(true)">Ответить</button></article>`
      : '';
  await page.route('https://www.threads.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/send') {
      sends++;
      posted = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/reply') {
      commented = true;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!DOCTYPE html><html><body>${challenge ? '<div id="challenge">Проверка</div>' : '<a id="logged-in">Вход выполнен</a>'}<a href="/@test_account">Мой профиль</a><button id="create" onclick="openEditor(false)">Создать</button>${article()}${delayed && commented ? '<article class="comment"><a href="/@test_account">test_account</a><span>Мой комментарий</span><a class="permalink" href="/@test_account/post/reply">Ссылка</a></article>' : ''}<script>
    function openEditor(reply){const d=document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<div contenteditable="true" role="textbox"></div><button id="'+(reply?'reply-submit':'submit')+'">Отправить</button>';const input=document.createElement('input');input.type='file';input.accept='image/png';d.append(input);let mediaSrc='';input.onchange=()=>{const reader=new FileReader();reader.onload=()=>{mediaSrc=String(reader.result);const img=document.createElement('img');img.className='attachment';img.width=128;img.height=128;img.src=mediaSrc;d.append(img);};reader.readAsDataURL(input.files[0]);};document.body.append(d);d.querySelector('button').onclick=async()=>{await fetch(reply?'/reply':'/send',{method:'POST'});d.remove();if(!reply && ${Boolean(options.nativeNotice)}){const notice=document.createElement('div');notice.setAttribute('role','status');notice.innerHTML='<a class="permalink" href="/@test_account/post/confirmed">View</a>';document.body.append(notice);}if(reply && !${delayed}){const a=document.createElement('article');a.className='comment';a.innerHTML='<a href="/@test_account">test_account</a><span>Мой комментарий</span><a class="permalink" href="/@test_account/post/reply">Ссылка</a>';if(mediaSrc){const img=document.createElement('img');img.className='attachment';img.width=128;img.height=128;img.src=mediaSrc;a.append(img);}document.body.append(a);}};}
    </script></body></html>`,
    });
  });
  const session = new ThreadsSession(
    page,
    null,
    f.provider,
    f.profile.externalId,
    f.account,
    'fixture',
    selectors,
    '/tmp/content-factory-browser-evidence',
    options.confirmation,
  );
  return { ...f, context, page, session, sends: () => sends, commented: () => commented };
}
describe('Playwright: подтверждённый интерфейс на локальной фикстуре', () => {
  it('берёт permalink из post-submit UI и подтверждает его прямым чтением', async () => {
    const f = await setup(false, false, {
      nativeNotice: true,
      confirmation: { timeoutMs: 2000, pollMs: 25 },
    });
    try {
      const result = await f.session.publish('Проверенный текст', async () => {});
      expect(result.url).toContain('/post/confirmed');
      expect(f.page.url()).toBe(result.url);
      expect(f.sends()).toBe(1);
    } finally {
      await f.context.close();
    }
  });
  it('отсутствие надёжного результата сохраняет UNCERTAIN и единственный submit', async () => {
    const f = await setup(false, false, {
      hiddenResult: true,
      confirmation: { timeoutMs: 250, pollMs: 25 },
    });
    try {
      await expect(f.session.publish('Проверенный текст', async () => {})).rejects.toMatchObject({
        code: 'UNCERTAIN',
      });
      expect(f.sends()).toBe(1);
    } finally {
      await f.context.close();
    }
  });
  it('при задержке отображения перечитывает страницу и не повторяет отправку', async () => {
    const f = await setup(false, true);
    try {
      let barriers = 0;
      const post = await f.session.publish('Проверенный текст', async () => {
        barriers++;
      });
      const comment = await f.session.comment(post.url, 'Мой комментарий', async () => {
        barriers++;
      });
      expect(post.url).toContain('/post/confirmed');
      expect(comment.url).toContain('/post/reply');
      expect(f.sends()).toBe(1);
      expect(barriers).toBe(2);
    } finally {
      await f.context.close();
    }
  }, 30000);
  it('проверяет SHA-256 и наличие изображения в CTA до отправки и после подтверждения URL', async () => {
    const f = await setup();
    const dir = await mkdtemp(join(tmpdir(), 'cf-media-'));
    const data = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    const path = join(dir, 'fixture.png');
    await writeFile(path, data);
    try {
      const post = await f.session.publish('Проверенный текст', async () => {});
      let barriers = 0;
      const result = await f.session.comment(
        post.url,
        'Мой комментарий',
        async () => {
          barriers++;
        },
        { path, sha256: createHash('sha256').update(data).digest('hex') },
      );
      expect(result.url).toContain('/post/reply');
      expect(barriers).toBe(1);
      expect(await f.page.locator('article.comment img.attachment').count()).toBe(1);
    } finally {
      await f.context.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
  it('изменённое изображение не проходит барьер отправки CTA', async () => {
    const f = await setup();
    const dir = await mkdtemp(join(tmpdir(), 'cf-media-'));
    const path = join(dir, 'changed.png');
    await writeFile(path, 'changed');
    try {
      const post = await f.session.publish('Проверенный текст', async () => {});
      let barriers = 0;
      await expect(
        f.session.comment(
          post.url,
          'Мой комментарий',
          async () => {
            barriers++;
          },
          { path, sha256: '0'.repeat(64) },
        ),
      ).rejects.toMatchObject({ code: 'MEDIA_CHANGED' });
      expect(barriers).toBe(0);
      expect(f.commented()).toBe(false);
    } finally {
      await f.context.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('проверяет аккаунт, вводит пост, подтверждает URL и собственный комментарий', async () => {
    const f = await setup();
    try {
      let barriers = 0;
      const result = await f.session.publish('Проверенный текст', async () => {
        barriers++;
      });
      expect(result.url).toBe('https://www.threads.com/@test_account/post/confirmed');
      const comment = await f.session.comment(result.url, 'Мой комментарий', async () => {
        barriers++;
      });
      expect(comment.url).toContain('/post/reply');
      expect(f.sends()).toBe(1);
      expect(f.commented()).toBe(true);
      expect(barriers).toBe(2);
    } finally {
      await f.context.close();
    }
  }, 30000);
  it('останавливается на проверке личности без нажатия отправки', async () => {
    const f = await setup(true);
    try {
      await expect(f.session.publish('Проверенный текст', async () => {})).rejects.toMatchObject({
        code: 'CHALLENGE',
      });
      expect(f.sends()).toBe(0);
    } finally {
      await f.context.close();
    }
  });
  it('ошибка фиксации барьера не допускает отправку', async () => {
    const f = await setup();
    try {
      await expect(
        f.session.publish('Проверенный текст', async () => {
          throw new Error('DB unavailable');
        }),
      ).rejects.toThrow('DB unavailable');
      expect(f.sends()).toBe(0);
    } finally {
      await f.context.close();
    }
  });
});
it('проверяет многоабзацный текст по видимому innerText, а не склеенному textContent', async () => {
  const { visibleResults } = await import('../src/browser/results.js');
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<article class=post><a class=permalink href='https://www.threads.com/@test_account/post/multi'>now</a><div>первая строка</div><div>вторая строка</div></article>`,
    );
    expect(
      (
        await visibleResults(
          page,
          'article.post',
          'a.permalink',
          'первая строка\n\nвторая строка',
          'test_account',
        )
      )[0]?.urls,
    ).toContain('https://www.threads.com/@test_account/post/multi');
    expect(
      await visibleResults(
        page,
        'article.post',
        'a.permalink',
        'первая строка\n\nчужой текст',
        'test_account',
      ),
    ).toHaveLength(0);
  } finally {
    await page.close();
  }
});
