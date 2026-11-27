import { it, expect } from 'vitest';
import { createApplication } from '../src/app.js';
import { MemoryDatabase } from '../src/db/database.js';
import { testConfig } from './helpers.js';
it('отдельная API-роль не создаёт Telegram polling и HTTP остаётся доступным', async () => {
  const app = await createApplication(
    { ...testConfig(), PROCESS_ROLE: 'api' },
    new MemoryDatabase(),
  );
  try {
    expect(app.bot).toBeUndefined();
    expect(app.server).toBeDefined();
    expect((await app.server!.inject({ url: '/live' })).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
