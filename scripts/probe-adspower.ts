import { chromium, type Browser, type Page } from 'playwright';
import { parse } from 'dotenv';
import { readFile, writeFile, mkdir, chmod, open, unlink } from 'node:fs/promises';
import { createServer, isIP, type AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { AdsPowerProvider, localEndpoint } from '../src/browser/providers.js';
import { AppError } from '../src/core/errors.js';

// Optional draft entry is cleared without clicking any submit button.
const exec = promisify(execFile);
const output = resolve(process.env.PROBE_OUTPUT_DIR ?? '.local/v15');
await mkdir(output, { recursive: true, mode: 0o700 });
await chmod(output, 0o700);
const report: Record<string, unknown> = {
  mode: 'LIVE_READ_ONLY',
  checkedAt: new Date().toISOString(),
  postsSent: 0,
  commentsSent: 0,
};
const stages: string[] = [];
report.stages = stages;
const lockPath = resolve(output, 'probe.lock');
const lock = await open(lockPath, 'wx', 0o600);
await lock.writeFile(String(process.pid));
let provider: AdsPowerProvider | undefined;
let profileId: string | undefined;
let started = false;
let browser: Browser | undefined;
let page: Page | undefined;
let forwarding: string | undefined;
let ownedDraft: string | undefined;

function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new AppError(code, code);
}

async function save(name: string, data: unknown) {
  const path = resolve(output, name);
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

async function ssh(args: string[]) {
  requireCondition(process.env.PROBE_SSH_CONFIG, 'SSH_CONFIG_REQUIRED');
  requireCondition(process.env.PROBE_SSH_SOCKET, 'SSH_SOCKET_REQUIRED');
  return exec(
    'ssh',
    [
      '-F',
      process.env.PROBE_SSH_CONFIG,
      '-S',
      process.env.PROBE_SSH_SOCKET,
      ...args,
      process.env.PROBE_SSH_HOST ?? 'content-factory-test-v14',
    ],
    { timeout: 15000 },
  );
}

async function prepareEndpoint(endpoint: string) {
  const url = new URL(localEndpoint(endpoint));
  if (!process.env.PROBE_SSH_SOCKET) return url.href;
  const listener = createServer();
  await new Promise<void>((ok, fail) => {
    listener.once('error', fail);
    listener.listen(0, '127.0.0.1', ok);
  });
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>((ok, fail) => listener.close((error) => (error ? fail(error) : ok())));
  const spec = `127.0.0.1:${port}:127.0.0.1:${url.port}`;
  await ssh(['-O', 'forward', '-L', spec]);
  forwarding = spec;
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return url.href;
}

try {
  const keyFile = process.env.ADSPOWER_API_KEY_FILE ?? '.local/secrets/adspower-test.env';
  const key = process.env.ADSPOWER_API_KEY ?? parse(await readFile(keyFile)).ADSPOWER_API_KEY;
  requireCondition(key && !/[\r\n]/.test(key), 'API_KEY_REQUIRED');
  const base = new URL(process.env.ADSPOWER_BASE_URL ?? 'http://127.0.0.1:50325');
  requireCondition(
    base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname),
    'LOCAL_API_ONLY',
  );
  provider = new AdsPowerProvider(
    base.href,
    key,
    undefined,
    (process.env.ADSPOWER_ALLOWED_PROFILE_IDS ?? '').split(',').filter(Boolean),
    process.env.ADSPOWER_HEADLESS === '1',
  );
  const profiles = await provider.listProfiles();
  stages.push('API_LIST_OK');
  const requestedName = process.env.PROBE_PROFILE_NAME ?? 'Threads 02';
  const matches = profiles.filter((profile) => profile.name === requestedName);
  requireCondition(matches.length === 1, 'PROFILE_NAME_NOT_UNIQUE');
  const profile = matches[0]!;
  profileId = profile.id;
  report.profile = profile;
  if (process.env.PROBE_EXPECTED_PROFILE_ID)
    requireCondition(profileId === process.env.PROBE_EXPECTED_PROFILE_ID, 'PROFILE_ID_MISMATCH');
  requireCondition(!(await provider.status(profileId)), 'PROFILE_ALREADY_ACTIVE');
  const startedAt = Date.now();
  const session = await provider.start(profileId);
  started = true;
  stages.push('API_START_OK');
  const endpoint = await prepareEndpoint(session.cdpEndpoint);
  browser = await chromium.connectOverCDP(endpoint, { timeout: 45000 });
  report.browserVersion = browser.version();
  report.connectSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
  stages.push('CDP_CONNECTED');
  const context = browser.contexts()[0];
  requireCondition(context, 'NO_PROFILE_CONTEXT');
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  if (process.env.PROBE_VERIFY_IP === '1') {
    const assignment = await provider.proxyAssignment(profileId);
    requireCondition(isIP(assignment.host) !== 0, 'PROXY_EXPECTED_IP_REQUIRED');
    const response = await page.goto('https://api.ipify.org?format=json', { timeout: 45000 });
    const publicIp = (await response?.json())?.ip;
    requireCondition(typeof publicIp === 'string' && isIP(publicIp) !== 0, 'IP_CHECK_FAILED');
    report.proxy = {
      type: assignment.type,
      publicIp,
      matchesAssignedProxy: publicIp === assignment.host,
    };
    requireCondition(publicIp === assignment.host, 'PROXY_MISMATCH');
    stages.push('BROWSER_PROXY_IP_VERIFIED');
  }
  const username = process.env.PROBE_EXPECTED_USERNAME ?? 'beh4ppy01';
  requireCondition(/^[a-zA-Z0-9_.]{1,30}$/.test(username), 'INVALID_USERNAME');
  await page.goto(`https://www.threads.com/@${username}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  const edit = page
    .getByRole('button', { name: /^(Edit profile|Profil bearbeiten|Редактировать профиль)$/i })
    .filter({ visible: true });
  await edit.waitFor({ state: 'visible' });
  requireCondition((await edit.count()) === 1, 'AMBIGUOUS_ACCOUNT_UI');
  requireCondition(
    new URL(page.url()).pathname.replace(/\/$/, '') === `/@${username}`,
    'WRONG_ACCOUNT',
  );
  requireCondition(
    ['www.threads.com', 'threads.com'].includes(new URL(page.url()).hostname),
    'WRONG_ORIGIN',
  );
  report.username = username;
  report.authorized = true;
  stages.push('THREADS_AUTHORIZED');
  const configuredSelectors = JSON.parse(
    await readFile(process.env.THREADS_SELECTORS_PATH ?? 'fixtures/threads-selectors.json', 'utf8'),
  );
  report.productionSelectorCounts = {
    loggedIn: await page.locator(configuredSelectors.loggedIn).filter({ visible: true }).count(),
    identity: await page
      .locator(configuredSelectors.identity.replaceAll('{username}', username))
      .filter({ visible: true })
      .count(),
    create: await page.locator(configuredSelectors.create).filter({ visible: true }).count(),
    ownPost: await page.locator(configuredSelectors.ownPost).filter({ visible: true }).count(),
  };
  const candidates = [
    {
      name: 'create-button',
      locator: page.getByRole('button', {
        name: /^(Create|Erstellen|Neuer Thread|New thread|Создать)$/i,
      }),
    },
    {
      name: 'profile-prompt',
      locator: page.getByText(/^(Was gibt['’]s Neues\?|What's new\?|Что нового\?)$/i, {
        exact: true,
      }),
    },
  ];
  let opened = false;
  for (const candidate of candidates) {
    const locator = candidate.locator.filter({ visible: true });
    if ((await locator.count()) !== 1) continue;
    report.createSelector = candidate.name;
    await locator.click();
    opened = true;
    break;
  }
  requireCondition(opened, 'CREATE_SELECTOR_NOT_UNIQUE');
  const dialog = page.getByRole('dialog').filter({ visible: true });
  await dialog.waitFor({ state: 'visible' });
  requireCondition((await dialog.count()) === 1, 'AMBIGUOUS_DIALOG');
  const editor = dialog
    .locator('[contenteditable="true"][role="textbox"]')
    .filter({ visible: true });
  await editor.waitFor({ state: 'visible' });
  requireCondition((await editor.count()) === 1, 'AMBIGUOUS_EDITOR');
  requireCondition((await editor.innerText()).trim() === '', 'EXISTING_DRAFT_PRESENT');
  const draft = process.env.PROBE_DRAFT_PATH
    ? await readFile(process.env.PROBE_DRAFT_PATH, 'utf8')
    : null;
  if (draft) {
    requireCondition([...draft].length <= 500, 'DRAFT_TOO_LONG');
    ownedDraft = draft;
    await editor.fill(draft);
    requireCondition(
      (await editor.innerText()).replace(/\r\n/g, '\n').trim() === draft.trim(),
      'DRAFT_TEXT_MISMATCH',
    );
    report.draftEntryVerified = true;
    stages.push('DRAFT_ENTRY_VERIFIED_WITHOUT_SUBMIT');
  }
  const submit = dialog
    .getByRole('button', { name: /^(Post|Posten|Опубликовать)$/i })
    .filter({ visible: true });
  requireCondition((await submit.count()) === 1, 'AMBIGUOUS_SUBMIT');
  report.emptyComposer = true;
  if (draft) report.draftSubmitEnabled = await submit.isEnabled();
  else report.emptySubmitDisabled = !(await submit.isEnabled());
  report.submitState = await submit.evaluate((node) => ({
    role: node.getAttribute('role'),
    ariaDisabled: node.getAttribute('aria-disabled'),
    disabledAttribute: node.hasAttribute('disabled'),
    pointerEvents: getComputedStyle(node).pointerEvents,
    opacity: getComputedStyle(node).opacity,
  }));
  report.submissionAttempted = false;
  await dialog.screenshot({ path: resolve(output, 'playwright-composer.png') });
  await chmod(resolve(output, 'playwright-composer.png'), 0o600);
  stages.push('EMPTY_COMPOSER_VERIFIED');
  if (draft) {
    await editor.fill('');
    requireCondition((await editor.innerText()).trim() === '', 'DRAFT_CLEANUP_FAILED');
    ownedDraft = undefined;
    report.draftCleared = true;
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 10000 });
  if (process.env.PROBE_RECORD_STRUCTURE === '1') {
    await page.goto('https://www.threads.com', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const links = page.locator('a[href*="/post/"]').filter({ visible: true });
    await links.first().waitFor({ state: 'visible', timeout: 30000 });
    await save(
      'post-structure.json',
      await links.evaluateAll((nodes) =>
        nodes.slice(0, 4).map((link) => {
          const ancestors: unknown[] = [];
          let node: Element | null = link;
          for (let depth = 0; node && depth < 12; depth++, node = node.parentElement)
            ancestors.push({
              tag: node.tagName,
              role: node.getAttribute('role'),
              pressable: node.getAttribute('data-pressable-container'),
              testid: node.getAttribute('data-testid'),
              className: typeof node.className === 'string' ? node.className : null,
            });
          return { href: link.getAttribute('href'), ancestors };
        }),
      ),
    );
    await save(
      'identity-structure.json',
      await page.locator(`a[href="/@${username}"]`).evaluateAll((nodes) =>
        nodes.map((link) => ({
          tag: link.tagName,
          role: link.getAttribute('role'),
          label: link.getAttribute('aria-label'),
          svg: !!link.querySelector('svg'),
          parents: [
            link.parentElement?.tagName,
            link.parentElement?.getAttribute('role'),
            link.parentElement?.parentElement?.tagName,
            link.parentElement?.parentElement?.getAttribute('role'),
          ],
        })),
      ),
    );
  }
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.errorCode =
    error instanceof AppError ? error.code : error instanceof Error ? error.name : 'UNKNOWN';
  if (page && !page.isClosed()) {
    await save(
      'visible-controls.json',
      await page.locator('button,[role="button"],[role="textbox"]').evaluateAll((nodes) =>
        nodes
          .filter((node) => (node as HTMLElement).getClientRects().length)
          .map((node) => ({
            role: node.getAttribute('role'),
            label: node.getAttribute('aria-label'),
            text: (node.textContent ?? '').trim().slice(0, 80),
          })),
      ),
    ).catch(() => {});
  }
} finally {
  if (ownedDraft && page && !page.isClosed()) {
    const editor = page
      .locator('[role="dialog"] [contenteditable="true"][role="textbox"]')
      .filter({ visible: true });
    if ((await editor.count()) === 1 && (await editor.innerText()).trim() === ownedDraft.trim())
      await editor.fill('').catch(() => {});
  }
  await page?.close().catch(() => {});
  if (started && provider && profileId) {
    try {
      await provider.stop(profileId);
      report.closedNormally = !(await provider.status(profileId));
      if (!report.closedNormally) report.ok = false;
    } catch {
      report.closedNormally = false;
      report.ok = false;
    }
  }
  await browser?.close().catch(() => {});
  if (forwarding) await ssh(['-O', 'cancel', '-L', forwarding]).catch(() => {});
  await save('playwright-result.json', report);
  await lock.close();
  await unlink(lockPath);
}
console.log(JSON.stringify(report));
if (!report.ok) process.exitCode = 1;
