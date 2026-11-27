import type { Database } from './database.js';
import { base } from './database.js';
import type { Style } from '../core/domain.js';
export async function seedStyles(db: Database) {
  const names = [
    'Живой трейдерский язык',
    'Разговорный, дерзкий',
    'Спокойный эксперт',
    'Короткие мысли',
  ];
  for (let i = 0; i < names.length; i++)
    if (!(await db.get('style', `style-${i + 1}`)))
      await db.insert('style', {
        ...base(`style-${i + 1}`),
        name: names[i]!,
        instruction: [
          'Пиши живо, как практикующий трейдер. Без обещаний доходности.',
          'Короткие энергичные фразы, разговорный тон.',
          'Спокойно объясняй факты без категоричных прогнозов.',
          'Одна короткая мысль, без введения и вывода.',
        ][i]!,
        maxLength: i === 3 ? 200 : 500,
        maxParagraphs: i === 3 ? 1 : 4,
        punctuation: 'Естественная пунктуация. Без длинных цепочек восклицательных знаков.',
        emoji: false,
        slang: i < 2,
        profanity: false,
        forbidden: ['таким образом', 'в заключение', 'погрузимся'],
        opening: 'Без приветствий',
        ending: 'Без искусственного вывода',
        extra: '',
      } satisfies Style);
}
export async function seedDemo(db: Database) {
  await seedStyles(db);
  if (await db.get('setting', 'demoSeeded')) return;
  await db.transaction(async (tx) => {
    const cta = await tx.insert('cta', {
      ...base('demo-cta'),
      name: 'Тестовый CTA',
      text: 'ТЕСТ: больше разборов в Telegram. Ссылка в профиле.',
      enabled: true,
    });
    for (let i = 1; i <= 10; i++) {
      const profile = await tx.insert('browserProfile', {
        ...base(`demo-profile-${i}`),
        provider: 'MOCK',
        externalId: `demo-${i}`,
        name: `Тестовый профиль ${i}`,
      });
      await tx.insert('account', {
        ...base(`demo-account-${i}`),
        username: `demo_trader_${i}`,
        profileUrl: `https://www.threads.com/@demo_trader_${i}`,
        name: `Тестовый аккаунт ${i}`,
        profileId: profile.id,
        styleId: `style-${((i - 1) % 4) + 1}`,
        status: 'ACTIVE',
        autoApprove: false,
        followers: 1000 + i * 170,
        lastPublishedAt: null,
        ctaId: cta.id,
        insightsUserId: null,
      });
      for (let day = 0; day < 15; day++)
        await tx.insert('accountMetric', {
          ...base(),
          accountId: `demo-account-${i}`,
          measuredAt: new Date(Date.now() - day * 86400000),
          followers: 1000 + i * 170 - day * 7,
          source: 'DEMO_SYNTHETIC',
        });
    }
    for (let d = 1; d <= 14; d++) {
      const date = new Date(Date.now() - d * 86400000 - 3600000),
        source = await tx.insert('source', {
          ...base(),
          url: null,
          fingerprint: `demo-source-${d}`,
          text: `DEMO: Patience and risk management. Day ${d}.`,
          author: 'Демонстрация',
          rights: 'OWN',
        });
      const batch = await tx.insert('batch', {
        ...base(),
        name: `ТЕСТ партия ${d}`,
        approval: 'MANUAL_APPROVAL',
      });
      for (let i = 1; i <= 10; i++) {
        const g = await tx.insert('generated', {
          ...base(),
          sourceId: source.id,
          accountId: `demo-account-${i}`,
          styleId: `style-${((i - 1) % 4) + 1}`,
          text: `ТЕСТОВЫЕ ДАННЫЕ: терпение и управление риском. День ${d}.`,
          version: 1,
          valid: true,
          approved: true,
        });
        const job = await tx.insert('publishJob', {
          ...base(),
          batchId: batch.id,
          accountId: g.accountId,
          generatedId: g.id,
          scheduledAt: date,
          status: 'COMPLETED',
          postStatus: 'PUBLISHED',
          commentStatus: 'DISABLED',
          ctaText: null,
          attempts: 1,
          lastError: null,
          startedAt: date,
          updatedAt: date,
          revision: 0,
        });
        if (d === 1) await tx.update('account', g.accountId, { lastPublishedAt: date });
        const post = await tx.insert('post', {
          ...base(),
          jobId: job.id,
          accountId: g.accountId,
          generatedId: g.id,
          url: `https://www.threads.com/@demo_trader_${i}/post/demo-${d}`,
          externalId: null,
          publishedAt: date,
        });
        for (const h of [1, 24, 48, 72, 168])
          if (date.getTime() + h * 3600000 <= Date.now())
            await tx.insert('postMetric', {
              ...base(),
              postId: post.id,
              targetHours: h,
              measuredAt: new Date(date.getTime() + h * 3600000),
              views: i * d * 100 + Math.floor(h * 15),
              likes: i * d,
              replies: d,
              reposts: i,
              quotes: 0,
              source: 'DEMO_SYNTHETIC',
              status: 'TEST_DATA',
            });
      }
    }
    await tx.insert('setting', { ...base('demoSeeded'), value: 'true' });
  });
}
