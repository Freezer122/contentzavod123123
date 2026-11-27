import { describe, it, expect } from 'vitest';
import { fixture, testConfig } from './helpers.js';
import {
  ContentEngine,
  SourceLibrary,
  validateContent,
  canonicalXUrl,
} from '../src/content/service.js';
describe('Контент и бюджет', () => {
  it('канонизирует ссылку X и не принимает произвольные URL', () => {
    expect(canonicalXUrl('https://twitter.com/alice/status/123?s=20')).toBe(
      'https://x.com/alice/status/123',
    );
    expect(canonicalXUrl('https://evil.test/alice/status/123')).toBeNull();
  });
  it('предупреждает о повторном тексте', async () => {
    const { db } = await fixture();
    const lib = new SourceLibrary(db, testConfig());
    await lib.add('Some content');
    await expect(lib.add('Some   content')).rejects.toMatchObject({ code: 'DUPLICATE_SOURCE' });
  });
  it('блокирует изменение цифр и тикеров', async () => {
    const { db } = await fixture();
    const style = (await db.get('style', 'style-1'))!;
    expect(validateContent('$BTC на 50000', 'Buy $BTC at 50000', style)).toEqual([]);
    expect(validateContent('$BTC на 60000', 'Buy $BTC at 50000', style).join()).toContain(
      '50000 → 60000',
    );
  });
  it('отклоняет изменение знака уровня и английский результат', async () => {
    const { db } = await fixture(),
      style = (await db.get('style', 'style-1'))!;
    expect(validateContent('Падение на +10%', 'Down -10%', style).join()).toContain('-10% → +10%');
    expect(validateContent('Risk first.', 'Risk first.', style)).toContain(
      'Нет русскоязычной адаптации',
    );
  });
  it('не повторяет ИИ автоматически для невалидного ответа', async () => {
    const f = await fixture();
    let calls = 0;
    const engine = new ContentEngine(f.db, testConfig(), {
      generate: async () => {
        calls++;
        return { text: '', inputTokens: 10, outputTokens: 10 };
      },
    });
    const g = await engine.generate(f.source.id, f.account.id);
    expect(g.valid).toBe(false);
    expect(calls).toBe(1);
    await engine.generate(f.source.id, f.account.id);
    expect(calls).toBe(1);
    const next = await engine.edit(g.id, 'Держу риск под контролем.', 'test');
    expect(next.valid).toBe(true);
    expect(next.version).toBe(3);
  });
  it('не отправляет запрос при исчерпанном бюджете', async () => {
    const f = await fixture();
    let calls = 0;
    const c = {
      ...testConfig(),
      APP_MODE: 'production' as const,
      AI_DAILY_LIMIT_USD: 0.00001,
      LLM_INPUT_PRICE_PER_MILLION: 20,
    };
    const engine = new ContentEngine(f.db, c, {
      generate: async () => {
        calls++;
        return { text: 'Текст', inputTokens: 1, outputTokens: 1 };
      },
    });
    await expect(engine.generate(f.source.id, f.account.id)).rejects.toMatchObject({
      code: 'AI_BUDGET',
    });
    expect(calls).toBe(0);
  });
  it('сохраняет резерв при неизвестном результате API', async () => {
    const f = await fixture();
    const engine = new ContentEngine(f.db, testConfig(), {
      generate: async () => {
        throw new Error('timeout');
      },
    });
    await expect(engine.generate(f.source.id, f.account.id)).rejects.toThrow('timeout');
    expect((await f.db.list('aiRequest'))[0]!.status).toBe('UNKNOWN');
  });
});
