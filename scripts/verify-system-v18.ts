import { PrismaDatabase, base } from '../src/db/database.js';
import { writeFile } from 'node:fs/promises';
const db = PrismaDatabase.connect(process.env.DATABASE_URL!);
try {
  const event = await db.insert('systemEvent', {
    ...base(),
    level: 'INFO',
    code: 'NOTIFICATION',
    message:
      'Проверка переноса: бот работает на новом VPS. Фабрика приостановлена, публикации DRY_RUN.',
  });
  let notificationDelivered = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    const state = await db.get('setting', 'telegram-notification-cursor-7842338078');
    const cursor = state ? JSON.parse(state.value) : {};
    if (cursor.ids?.includes(event.id) || cursor.id === event.id) {
      notificationDelivered = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const health = await fetch('http://127.0.0.1:3000/health', {
    headers: { Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` },
  });
  const system = (await health.json()) as { database: string; redis: string };
  const snapshot = {
    notificationDelivered,
    health: health.status,
    database: system.database,
    redis: system.redis,
    factoryPaused: (await db.get('setting', 'factoryPaused'))?.value,
    accounts: (await db.list('account')).map((a) => ({ id: a.id, status: a.status })),
    links: (await db.list('trackingLink')).map((l) => ({
      id: l.id,
      accountId: l.accountId,
      postId: l.postId,
      permanent: l.permanent,
    })),
    posts: (await db.list('post')).length,
    comments: (await db.list('comment')).length,
    llmRequests: (await db.list('aiRequest')).length,
  };
  if (!notificationDelivered || health.status !== 200 || snapshot.factoryPaused !== 'true')
    throw new Error('SYSTEM_VERIFY_FAILED');
  await writeFile(
    '/var/lib/content-factory/reports/KEEP-v18-system.json',
    JSON.stringify(snapshot, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(snapshot));
} finally {
  await db.close();
}
