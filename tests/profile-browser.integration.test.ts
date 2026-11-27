import { beforeAll, afterAll, it, expect } from 'vitest';
import { fixtureBrowser } from '../src/browser/fixture.js';
import { ThreadsProfilePort } from '../src/profile/browser.js';
import { fixture } from './helpers.js';
let connection: Awaited<ReturnType<typeof fixtureBrowser>>;
beforeAll(async () => {
  connection = await fixtureBrowser();
}, 45000);
afterAll(async () => {
  await connection?.close();
});
it('редактор био/ссылок: DRY_RUN восстанавливает поля и не нажимает сохранение', async () => {
  const f = await fixture(),
    context = await connection.browser.newContext(),
    page = await context.newPage();
  page.setDefaultTimeout(3000);
  const original = { bio: 'исходное био', links: ['https://t.me/example'], linkCapacity: 5 };
  let saves = 0;
  await context.route('**/*', (route) => route.abort());
  await context.route('https://www.threads.com/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/save') {
      saves++;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><body><button onclick="document.querySelector('#main').hidden=false">Edit profile</button><section id="main" hidden><div role="dialog"><button aria-label="Bio" onclick="document.querySelector('#bio').hidden=false">Bio</button><button onclick="document.querySelector('#links').hidden=false">Links 1</button><button onclick="fetch('/save')">Done</button><div id="bio" hidden><textarea>${original.bio}</textarea><button onclick="document.querySelector('#bio').hidden=true">Cancel</button><button onclick="fetch('/save');document.querySelector('#bio').hidden=true">Done</button></div><div id="links" hidden><button onclick="document.querySelector('#links').hidden=true">Cancel</button><button onclick="openLink('${original.links[0]}')">${original.links[0]}</button><button onclick="openLink('')">Add link</button><div id="link-editor" hidden><input placeholder="URL"><input placeholder="Title (optional)"><button onclick="document.querySelector('#link-editor').hidden=true">Cancel</button><button onclick="fetch('/save');document.querySelector('#link-editor').hidden=true">Done</button><button onclick="fetch('/save');document.querySelector('#link-editor').hidden=true">Remove link</button></div></div></div></section><script>function openLink(url){document.querySelector('#link-editor').hidden=false;document.querySelector('input[placeholder=URL]').value=url;}</script></body></html>`,
    });
  });
  const port = new ThreadsProfilePort({
    use: async (_id, _purpose, fn) => fn(page, f.account, new AbortController().signal),
  });
  try {
    expect(await port.read(f.account.id)).toEqual(original);
    for (const after of [
      { ...original, bio: 'новое био' },
      { ...original, links: [...original.links, 'https://example.com/new'] },
      { ...original, links: ['https://example.com/edit'] },
      { ...original, links: [] },
    ]) {
      const result = await port.change(f.account.id, original, after, false, async () => {
        throw new Error('must never save');
      });
      expect(result).toEqual(original);
    }
    expect(saves).toBe(0);
  } finally {
    await context.close();
  }
}, 30000);
