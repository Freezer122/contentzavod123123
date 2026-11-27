import { PrismaDatabase } from '../src/db/database.js';
const db = PrismaDatabase.connect(process.env.DATABASE_URL!);
try {
  await db.transaction(async (tx) => {
    await tx.update('setting', 'factoryPaused', { value: 'true' });
    const account = await tx.get('account', 'threads02');
    if (account?.status === 'ACTIVE') await tx.update('account', account.id, { status: 'PAUSED' });
  });
} finally {
  await db.close();
}
