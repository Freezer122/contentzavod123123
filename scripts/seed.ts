import { PrismaDatabase } from '../src/db/database.js';
import { TemplateService } from '../src/content/templates.js';
import { seedStyles } from '../src/db/seed.js';
const db = new PrismaDatabase();
try {
  await seedStyles(db);
  await new TemplateService(db).seed();
  for (const a of await db.list('account')) await new TemplateService(db).ensureOwnStyle(a.id);
  console.log('Базовые стили и восемь шаблонов Threads созданы. Реальные аккаунты не добавлялись.');
} finally {
  await db.close();
}
