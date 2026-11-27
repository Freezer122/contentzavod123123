import { MemoryDatabase, base } from '../src/db/database.js';
import { seedStyles } from '../src/db/seed.js';
import { loadConfig } from '../src/core/config.js';
import { MockBrowserProvider } from '../src/browser/providers.js';
import { MockPublisher } from '../src/browser/publisher.js';
import { Scheduler } from '../src/scheduler/service.js';
export const testConfig = () =>
  loadConfig({
    APP_MODE: 'demo',
    TELEGRAM_ALLOWED_IDS: '1',
    DEMO_STATE_PATH: '/tmp/cf-test-unused.json',
  });
export async function fixture() {
  const db = new MemoryDatabase();
  await seedStyles(db);
  const profile = await db.insert('browserProfile', {
    ...base(),
    provider: 'MOCK',
    externalId: 'one',
    name: 'Тестовый профиль',
  });
  const account = await db.insert('account', {
    ...base(),
    username: 'test_account',
    profileUrl: 'https://www.threads.com/@test_account',
    name: 'Тест',
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
    fingerprint: 'unique',
    text: 'Risk first.',
    author: null,
    rights: 'OWN',
  });
  const generated = await db.insert('generated', {
    ...base(),
    sourceId: source.id,
    accountId: account.id,
    styleId: account.styleId,
    text: 'Сначала контролирую риск.',
    version: 1,
    valid: true,
    approved: false,
  });
  const provider = new MockBrowserProvider(),
    publisher = new MockPublisher(),
    providers = { MOCK: provider, ADSPOWER: provider, DOLPHIN: provider },
    scheduler = new Scheduler(db, () => 0.5);
  return { db, profile, account, source, generated, provider, publisher, providers, scheduler };
}

export function fastClock() {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    sleep: async (ms: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      offset += ms;
    },
  };
}
