import { it, expect } from 'vitest';
import { MemoryDatabase, base } from '../src/db/database.js';
import { TelegramNotifications } from '../src/bot/notifications.js';
it('доставляет новым событиям только разрешённым ID, восстанавливает курсор и сохраняет события одной миллисекунды', async () => {
  const db = new MemoryDatabase();
  const sent: { id: number; text: string }[] = [];
  const send = async (id: number, text: string) => {
    sent.push({ id, text });
  };
  const relay = new TelegramNotifications(db, [123], send);
  await relay.start();
  try {
    const createdAt = new Date(Date.now() + 10);
    await db.insert('systemEvent', {
      ...base('z'),
      createdAt,
      level: 'INFO',
      code: 'NOTIFICATION',
      message: 'first',
    });
    await relay.tick();
    await db.insert('systemEvent', {
      ...base('a'),
      createdAt,
      level: 'INFO',
      code: 'NOTIFICATION',
      message: 'second',
    });
    await relay.tick();
    await relay.tick();
    expect(sent).toEqual([
      { id: 123, text: 'first' },
      { id: 123, text: 'second' },
    ]);
    relay.close();
    const restarted = new TelegramNotifications(db, [123], send);
    await restarted.start();
    await restarted.tick();
    restarted.close();
    expect(sent).toHaveLength(2);
  } finally {
    relay.close();
  }
});
it('после ошибки Telegram не продвигает курсор и повторяет только уведомление', async () => {
  const db = new MemoryDatabase();
  let failing = true;
  const sent: string[] = [];
  const relay = new TelegramNotifications(db, [123], async (_id, text) => {
    if (failing) throw new Error('offline');
    sent.push(text);
  });
  await relay.start();
  try {
    await db.insert('systemEvent', {
      ...base(),
      createdAt: new Date(Date.now() + 10),
      level: 'INFO',
      code: 'NOTIFICATION',
      message: 'retry',
    });
    await relay.tick();
    expect(sent).toHaveLength(0);
    failing = false;
    await relay.tick();
    expect(sent).toEqual(['retry']);
  } finally {
    relay.close();
  }
});
