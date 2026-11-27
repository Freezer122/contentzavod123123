import { chromium, type Browser, type BrowserContext } from 'playwright';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MemoryDatabase, base } from '../src/db/database.js';
import { seedStyles } from '../src/db/seed.js';
import { MockBrowserProvider } from '../src/browser/providers.js';
import { ThreadsSession, type Publisher, type Selectors } from '../src/browser/publisher.js';
import { PublishingWorker, realClock, type WorkerClock } from '../src/scheduler/worker.js';
import { Scheduler } from '../src/scheduler/service.js';
import { CtaService, renderCta } from '../src/cta/service.js';
import { AppError } from '../src/core/errors.js';
import { createHash } from 'node:crypto';
import { fixtureBrowser } from '../src/browser/fixture.js';
import { publicationTiming } from '../src/scheduler/timing.js';

// An isolated, unauthenticated browser. Every page request is fulfilled in memory.
// No real provider, account database, Telegram client or LLM is reachable here.
const output = resolve(process.env.REHEARSAL_OUTPUT_DIR ?? '.local/rehearsal');
await mkdir(output, { recursive: true, mode: 0o700 });
await chmod(output, 0o700);
const selectors: Selectors = {
  baseUrl: 'https://www.threads.com',
  loggedIn: '#logged-in',
  identity: 'a.identity[href="/@{username}"]',
  challenge: '#challenge',
  restricted: '#restricted',
  create: '#create',
  dialog: '[role="dialog"]',
  editor: '[contenteditable="true"][role="textbox"]',
  submit: '#submit',
  ownPost: 'article.post',
  postLink: 'a.permalink',
  reply: '.reply',
  replySubmit: '#reply-submit',
  comment: 'article.comment',
  mediaInput: 'input[type=file]',
  mediaPreview: 'img.attachment',
};
const text = 'Проверяю текст перед отправкой. Сначала сверяю аккаунт и результат.';
const scenarios = [
  'OK',
  'UNCERTAIN_POST',
  'COMMENT_FAILED',
  'UNCERTAIN_COMMENT',
  'RECOVER_PENDING',
  'RECOVER_SENDING',
  'APPROVAL_CHANGED',
  'MEDIA_CHANGED',
] as const;
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const check = (condition: unknown, label: string) => {
  if (!condition) throw new Error(label);
};
const fixtureConnection = await fixtureBrowser();
const browser = fixtureConnection.browser;
const results: Record<string, unknown>[] = [];

async function scenario(kind: (typeof scenarios)[number], browser: Browser) {
  const db = new MemoryDatabase(resolve(output, `${kind}.json`));
  await seedStyles(db);
  const provider = new MockBrowserProvider();
  const profile = await db.insert('browserProfile', {
    ...base(),
    provider: 'MOCK',
    externalId: 'isolated-fixture-only',
    name: 'Offline fixture',
  });
  const account = await db.insert('account', {
    ...base(),
    name: 'Offline fixture',
    username: 'fixture_account',
    profileUrl: 'https://www.threads.com/@fixture_account',
    profileId: profile.id,
    styleId: 'style-1',
    status: 'ACTIVE',
    autoApprove: false,
    followers: null,
    lastPublishedAt: null,
    ctaId: null,
    insightsUserId: null,
  });
  const source = await db.insert('source', {
    ...base(),
    url: null,
    fingerprint: kind,
    text: 'Check the account before publishing.',
    author: null,
    rights: 'OWN',
  });
  const generated = await db.insert('generated', {
    ...base(),
    sourceId: source.id,
    accountId: account.id,
    styleId: account.styleId,
    text,
    version: 1,
    valid: true,
    approved: false,
  });
  const ctas = new CtaService(db);
  await ctas.update(
    account.id,
    'Тестовый CTA только для изолированной фикстуры.',
    'https://t.me/fixture_only',
    'rehearsal',
  );
  const cta = await ctas.ensure(account.id);
  const expectedComment = renderCta(cta.text, cta.url);
  const scheduler = new Scheduler(db);
  const [job] = await scheduler.createBatch(
    [generated.id],
    'isolated-rehearsal',
    'MANUAL_APPROVAL',
    `fixture-${kind}`,
  );
  check(job, 'JOB_NOT_CREATED');
  const duplicate = await scheduler.createBatch(
    [generated.id],
    'isolated-rehearsal',
    'MANUAL_APPROVAL',
    `fixture-${kind}`,
  );
  check(duplicate[0]!.id === job!.id, 'REQUEST_DUPLICATED');
  if (kind === 'OK' || kind === 'MEDIA_CHANGED') {
    const path = resolve(output, 'fixture.png');
    const data = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(path, data, { mode: 0o600 });
    await db.update('publishJob', job!.id, {
      ctaMediaPath: path,
      ctaMediaSha256:
        kind === 'MEDIA_CHANGED' ? '0'.repeat(64) : createHash('sha256').update(data).digest('hex'),
    });
  }
  let offset = 0;
  const clock: WorkerClock =
    kind === 'OK'
      ? realClock
      : {
          now: () => Date.now() + offset,
          sleep: async (ms, signal) => {
            signal.throwIfAborted();
            offset += ms;
          },
        };
  let postRequests = 0,
    commentRequests = 0,
    opens = 0,
    closes = 0,
    blockedRequests = 0;
  let postedAt = 0,
    commentedAt = 0,
    postText = '',
    commentText = '';
  let firstCommentFailure = kind === 'COMMENT_FAILED';
  const contexts = new Set<BrowserContext>();
  const postUrl = 'https://www.threads.com/@fixture_account/post/fixture-post';
  const commentUrl = 'https://www.threads.com/@fixture_account/post/fixture-comment';
  const publisher: Publisher = {
    open: async (p, id, a, jobId) => {
      await p.start(id);
      opens++;
      const context = await browser.newContext({ serviceWorkers: 'block' });
      contexts.add(context);
      await context.route('**/*', async (route) => {
        const u = new URL(route.request().url());
        if (u.origin !== 'https://www.threads.com') {
          blockedRequests++;
          return route.abort();
        }
        if (u.pathname === '/send') {
          postRequests++;
          postText = JSON.parse(route.request().postData()!).text;
          postedAt = Date.now();
          return route.fulfill({ json: { ok: true } });
        }
        if (u.pathname === '/reply') {
          commentRequests++;
          commentText = JSON.parse(route.request().postData()!).text;
          commentedAt = Date.now();
          return route.fulfill({ json: { ok: true } });
        }
        const post = postRequests
          ? `<article class="post"><a class="permalink" href="${postUrl}">Пост</a><span>${escape(postText)}</span><button class="reply" onclick="openEditor(true)">Ответить</button></article>`
          : '';
        const comment = commentRequests
          ? `<article class="comment"><a href="/@fixture_account">fixture_account</a><span>${escape(commentText)}</span><a class="permalink" href="${commentUrl}">Комментарий</a></article>`
          : '';
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html><body><a id="logged-in">Вход выполнен</a><a class="identity" href="/@fixture_account">fixture_account</a><button id="create" onclick="openEditor(false)">Создать</button>${post}${comment}<script>
          function openEditor(reply) { const dialog=document.createElement('div'); dialog.setAttribute('role','dialog'); dialog.innerHTML='<div contenteditable="true" role="textbox"></div><button id="'+(reply?'reply-submit':'submit')+'">Отправить</button>'; let attachmentSrc='';const input=document.createElement('input');input.type='file';input.accept='image/png';dialog.append(input);input.onchange=()=>{const reader=new FileReader();reader.onload=()=>{attachmentSrc=String(reader.result);const img=document.createElement('img');img.className='attachment';img.width=128;img.height=128;img.src=attachmentSrc;dialog.append(img);};reader.readAsDataURL(input.files[0]);};document.body.append(dialog); dialog.querySelector('button').onclick=async()=>{ const text=dialog.querySelector('[contenteditable]').innerText; await fetch(reply?'/reply':'/send',{method:'POST',body:JSON.stringify({text})}); dialog.remove(); if(reply){ const article=document.createElement('article'); article.className='comment'; const author=document.createElement('a'); author.href='/@fixture_account'; author.textContent='fixture_account'; const body=document.createElement('span'); body.textContent=text; const link=document.createElement('a'); link.className='permalink'; link.href=${JSON.stringify(commentUrl)}; link.textContent='Комментарий'; article.append(author,body,link);if(attachmentSrc){const img=document.createElement('img');img.className='attachment';img.width=128;img.height=128;img.src=attachmentSrc;article.append(img);}document.body.append(article); } }; }
        </script></body></html>`,
        });
      });
      const page = await context.newPage();
      const session = new ThreadsSession(page, null, p, id, a, jobId, selectors, output);
      return {
        check: () => session.check(),
        publish: async (draft, beforeSend, onSubmitted) => {
          if (kind === 'APPROVAL_CHANGED')
            await db.update('generated', generated.id, { approved: false, version: 2 });
          const result = await session.publish(draft, beforeSend, onSubmitted);
          if (kind === 'UNCERTAIN_POST')
            throw new AppError('CONNECTION_LOST', 'Fixture: result lost after submit');
          return result;
        },
        comment: async (url, draft, beforeSend, attachment, onSubmitted) => {
          if (firstCommentFailure) {
            firstCommentFailure = false;
            throw new AppError('BEFORE_COMMENT', 'Fixture: comment not sent');
          }
          const result = await session.comment(url, draft, beforeSend, attachment, onSubmitted);
          if (kind === 'UNCERTAIN_COMMENT')
            throw new AppError('CONNECTION_LOST', 'Fixture: comment result lost');
          return result;
        },
        find: (draft) => session.find(draft),
        evidence: (error) => session.evidence(error),
        close: async () => {
          await context.close();
          contexts.delete(context);
          await session.close();
          closes++;
        },
      };
    },
  };
  const worker = new PublishingWorker(
    db,
    { MOCK: provider, ADSPOWER: provider, DOLPHIN: provider },
    publisher,
    async () => {},
    1,
    clock,
    true,
  );
  try {
    if (kind.startsWith('RECOVER_')) {
      await db.update('publishJob', job!.id, {
        status: 'RUNNING',
        postStatus: kind === 'RECOVER_SENDING' ? 'SENDING' : 'PENDING',
        updatedAt: new Date(0),
      });
      await worker.recover();
    }
    await worker.execute(job!.id);
    if (kind === 'COMMENT_FAILED') {
      await scheduler.retryComment(job!.id, 'rehearsal');
      await worker.execute(job!.id);
    }
    await worker.execute(job!.id);
    const state = (await db.get('publishJob', job!.id))!;
    if (['OK', 'COMMENT_FAILED', 'RECOVER_PENDING'].includes(kind)) {
      check(
        state.status === 'COMPLETED' &&
          state.postStatus === 'PUBLISHED' &&
          state.commentStatus === 'PUBLISHED',
        'SUCCESS_STATE',
      );
      check(
        postRequests === 1 &&
          commentRequests === 1 &&
          postText === text &&
          commentText === expectedComment,
        'DUPLICATE_OR_TEXT_MISMATCH',
      );
      check(
        (await db.list('post'))[0]?.url === postUrl &&
          (await db.list('comment'))[0]?.url === commentUrl,
        'URL_NOT_VERIFIED',
      );
      if (kind === 'OK') check(commentedAt - postedAt >= 20000, 'CTA_TOO_EARLY');
      const [another] = await scheduler.createBatch(
        [generated.id],
        'rehearsal',
        'MANUAL_APPROVAL',
        `another-${kind}`,
      );
      await worker.execute(another!.id);
      check(
        (await db.get('publishJob', another!.id))?.lastError?.startsWith('DUPLICATE_POST'),
        'CROSS_JOB_DUPLICATE',
      );
      check(postRequests === 1, 'SECOND_POST_SENT');
    } else if (kind === 'MEDIA_CHANGED') {
      check(
        state.lastError?.startsWith('MEDIA_CHANGED') &&
          postRequests === 0 &&
          commentRequests === 0 &&
          opens === 0,
        'CHANGED_MEDIA_SENT',
      );
    } else if (kind === 'APPROVAL_CHANGED') {
      check(
        state.lastError?.startsWith('APPROVAL_CHANGED') &&
          postRequests === 0 &&
          commentRequests === 0,
        'STALE_APPROVAL_SENT',
      );
    } else {
      check(state.status === 'NEEDS_REVIEW', 'UNCERTAIN_RESENT');
      check(postRequests === (kind === 'RECOVER_SENDING' ? 0 : 1), 'UNEXPECTED_POST_COUNT');
      check(commentRequests === (kind === 'UNCERTAIN_COMMENT' ? 1 : 0), 'UNEXPECTED_COMMENT_COUNT');
      if (kind === 'UNCERTAIN_POST') {
        const [another] = await scheduler.createBatch(
          [generated.id],
          'rehearsal',
          'MANUAL_APPROVAL',
          `another-${kind}`,
        );
        await worker.execute(another!.id);
        check(
          (await db.get('publishJob', another!.id))?.lastError?.startsWith('DUPLICATE_UNCERTAIN'),
          'UNCERTAIN_CROSS_JOB_RESENT',
        );
      }
    }
    check(
      provider.sessions.size === 0 && opens === closes && contexts.size === 0,
      'PROFILE_NOT_CLOSED',
    );
    check((await db.list('lease')).length === 0, 'LEASE_NOT_RELEASED');
    check((await db.list('aiRequest')).length === 0, 'LLM_CALLED');
    return {
      scenario: kind,
      ...publicationTiming(state),
      ok: true,
      status: state.status,
      postStatus: state.postStatus,
      commentStatus: state.commentStatus,
      simulatedPostRequests: postRequests,
      simulatedCommentRequests: commentRequests,
      actualCtaDelayMs: kind === 'OK' ? commentedAt - postedAt : null,
      opens,
      closes,
      blockedRequests,
      llmRequests: 0,
    };
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await db.close();
  }
}

try {
  for (const kind of scenarios) results.push(await scenario(kind, browser));
} finally {
  await fixtureConnection.close();
}
const report = {
  mode: 'DRY_RUN',
  transport: 'ISOLATED_PLAYWRIGHT_FIXTURE',
  simulated: true,
  host: process.platform,
  realProfilesUsed: 0,
  realPostsSent: 0,
  realCommentsSent: 0,
  llmRequests: 0,
  ok: results.length === scenarios.length && results.every((r) => r.ok),
  results,
};
await writeFile(resolve(output, 'worker-rehearsal.json'), JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
console.log(JSON.stringify(report));
