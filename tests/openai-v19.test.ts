import { it, expect } from 'vitest';
import { OpenAiResponses, llmSpec } from '../src/content/openai.js';
import { ContentEngine } from '../src/content/service.js';
import { fixture, testConfig, fastClock } from './helpers.js';
import { CtaService } from '../src/cta/service.js';
import { PublishingWorker } from '../src/scheduler/worker.js';
import { base, MemoryDatabase } from '../src/db/database.js';
import { createApplication } from '../src/app.js';
const config = () => ({
  ...testConfig(),
  APP_MODE: 'production' as const,
  LLM_PROVIDER: 'openai' as const,
  OPENAI_API_KEY: 'fake-key',
  LLM_MAX_TOKENS: 2048,
});
const usage = {
  input_tokens: 100,
  input_tokens_details: {
    cached_tokens: 20,
    cache_write_tokens: 30,
    cache_write_tokens_details: { ttl_30m_tokens: 10, ttl_12h_tokens: 20 },
  },
  output_tokens: 50,
  output_tokens_details: { reasoning_tokens: 10 },
  total_tokens: 150,
};
function response(model: string, status = 'completed') {
  return new Response(
    JSON.stringify({
      id: 'resp_fixture',
      model,
      status,
      service_tier: 'default',
      usage,
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'сначала стоит проверить риск' }],
        },
      ],
    }),
  );
}
it('Responses: нужные модели/effort, без temperature/tools/retry, реальные usage и стоимость', async () => {
  const calls: any[] = [];
  const llm = new OpenAiResponses(config(), async (url, options) => {
    calls.push({ url, body: JSON.parse(String(options?.body)) });
    return response(calls.at(-1).body.model);
  });
  const post = await llm.generate('system', 'source', { maxTokens: 100, purpose: 'POST' }),
    reply = await llm.generate('system', 'source', { maxTokens: 100, purpose: 'REPLY' });
  expect(calls.map((c) => [c.body.model, c.body.reasoning.effort])).toEqual([
    ['gpt-6.2-sol', 'low'],
    ['gpt-6.1-terra', 'none'],
  ]);
  expect(
    calls.every(
      (c) =>
        c.url === 'https://api.openai.com/v1/responses' &&
        c.body.store === false &&
        c.body.temperature === undefined &&
        c.body.tools.length === 0,
    ),
  ).toBe(true);
  expect(post.inputTokens).toBe(100);
  expect(post.outputTokens).toBe(50);
  expect(post.costUsd).toBeCloseTo((50 * 2 + 20 * 0.1 + 10 * 2.5 + 20 * 5 + 50 * 10) / 1e6, 10);
  expect(reply.costUsd).toBeCloseTo(post.costUsd! / 2, 10);
  expect(post.reasoningTokens).toBe(10);
  expect(llmSpec(config(), 'BIO').model).toBe('gpt-6.1-terra');
});
it('ошибка API не повторяется и не выдаёт ключ в сообщении', async () => {
  let calls = 0;
  const llm = new OpenAiResponses(config(), async () => {
    calls++;
    return new Response('sensitive provider text', { status: 429 });
  });
  await expect(llm.generate('s', 'u')).rejects.toThrow('HTTP 429');
  expect(calls).toBe(1);
});
it('стоимость неполного ответа записывается; автоматического повтора нет', async () => {
  const f = await fixture();
  let calls = 0;
  const engine = new ContentEngine(
    f.db,
    config(),
    new OpenAiResponses(config(), async () => {
      calls++;
      return response('gpt-6.2-sol', 'incomplete');
    }),
  );
  await expect(engine.generate(f.source.id, f.account.id)).rejects.toMatchObject({
    code: 'LLM_INCOMPLETE',
  });
  const row = (await f.db.list('aiRequest'))[0]!;
  expect(row.status).toBe('INCOMPLETE');
  expect(row.outputTokens).toBe(50);
  expect(row.costUsd).toBeGreaterThan(0);
  expect(calls).toBe(1);
});
it('неизвестное списание блокирует новые запросы; резерв сохраняется', async () => {
  const f = await fixture();
  let calls = 0;
  const engine = new ContentEngine(
    f.db,
    config(),
    new OpenAiResponses(config(), async () => {
      calls++;
      throw new Error('network');
    }),
  );
  await expect(engine.generate(f.source.id, f.account.id)).rejects.toMatchObject({
    code: 'OPENAI_NETWORK',
  });
  await expect(engine.generate(f.source.id, f.account.id)).rejects.toMatchObject({
    code: 'AI_UNCERTAIN',
  });
  expect((await f.db.list('aiRequest'))[0]!.reservedUsd).toBeGreaterThan(0);
  expect(calls).toBe(1);
});
it('накопительный лимит $5 и предупреждение $3 учитываются независимо от даты', async () => {
  const f = await fixture();
  await f.db.insert('aiRequest', {
    ...base(),
    createdAt: new Date('2025-01-01Z'),
    accountId: f.account.id,
    model: 'fixture',
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 2.99999,
    status: 'COMPLETED',
    reservedUsd: 0,
  });
  let calls = 0;
  const notices: string[] = [];
  const engine = new ContentEngine(
    f.db,
    config(),
    new OpenAiResponses(config(), async () => {
      calls++;
      return response('gpt-6.1-terra');
    }),
    async (m) => {
      notices.push(m);
    },
  );
  await engine.auxiliary(f.account.id, 'REPLY', 'разумно проверить риск', 'ответ');
  expect(notices).toHaveLength(1);
  const cached = await engine.auxiliary(f.account.id, 'REPLY', 'разумно проверить риск', 'ответ');
  expect(cached.text).toContain('риск');
  expect(calls).toBe(1);
  await f.db.insert('aiRequest', {
    ...base(),
    accountId: f.account.id,
    model: 'fixture',
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 2,
    status: 'COMPLETED',
    reservedUsd: 0,
  });
  await expect(
    engine.auxiliary(f.account.id, 'BIO', 'другой исходник', 'био'),
  ).rejects.toMatchObject({ code: 'AI_BUDGET' });
  expect(calls).toBe(1);
});
it('CTA без URL проходит UI, API, очередь и не восстанавливает обязательную ссылку', async () => {
  const app = await createApplication(testConfig(), new MemoryDatabase());
  try {
    const a = (await app.db.list('account'))[0]!;
    const send = async (payload: object) =>
      (
        await app.server!.inject({
          method: 'POST',
          url: '/api/demo/telegram',
          headers: { authorization: 'Bearer demo-local-token' },
          payload,
        })
      ).json();
    await send({ callback: `cta_edit:${a.id}` });
    await send({ text: 'больше разборов в шапке профиля' });
    await send({ callback: 'cta_no_link' });
    await send({ callback: 'cta_save' });
    expect((await app.services.ctas.ensure(a.id)).url).toBe('');
    const response = await app.server!.inject({
      method: 'PUT',
      url: `/api/accounts/${a.id}/cta`,
      headers: { authorization: 'Bearer demo-local-token' },
      payload: { text: 'ещё один CTA без ссылки' },
    });
    expect(response.statusCode).toBe(200);
    expect((await app.services.ctas.ensure(a.id)).url).toBe('');
  } finally {
    await app.close();
  }
});
it('очередь и worker исполняют CTA без ссылки один раз на mock-публикаторе', async () => {
  const f = await fixture();
  await new CtaService(f.db).update(f.account.id, 'больше разборов в шапке профиля', '', 'test');
  const [job] = await f.scheduler.createBatch([f.generated.id], 'test');
  const worker = new PublishingWorker(f.db, f.providers, f.publisher, undefined, 1, fastClock());
  await worker.execute(job!.id);
  await worker.execute(job!.id);
  expect(await f.db.get('publishJob', job!.id)).toMatchObject({
    status: 'COMPLETED',
    postStatus: 'PUBLISHED',
    commentStatus: 'PUBLISHED',
    ctaUrl: '',
  });
  expect(await f.db.list('post')).toHaveLength(1);
  expect(await f.db.list('comment')).toHaveLength(1);
  expect(f.provider.sessions.size).toBe(0);
  expect(await f.db.list('aiRequest')).toHaveLength(0);
});
it('Telegram-фото возвращается настоящим предпросмотром до сохранения CTA', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path'),
    { vi } = await import('vitest');
  const media = await mkdtemp(join(tmpdir(), 'cf-v19-photo-'));
  const app = await createApplication({ ...testConfig(), MEDIA_DIR: media }, new MemoryDatabase());
  const requests: any[] = [];
  app.bot!.api.config.use(async (previous, method, payload, signal) => {
    requests.push({ method, payload });
    if (method === 'getFile')
      return {
        ok: true,
        result: { file_id: 'photo', file_unique_id: 'unique', file_path: 'photos/fixture.png' },
      } as any;
    return previous(method, payload, signal);
  });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=',
    'base64',
  );
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(png));
  try {
    const a = (await app.db.list('account'))[0]!;
    await app.server!.inject({
      method: 'POST',
      url: '/api/demo/telegram',
      headers: { authorization: 'Bearer demo-local-token' },
      payload: { callback: `v18m:${a.id}` },
    });
    await app.bot!.handleUpdate({
      update_id: 19191,
      message: {
        message_id: 19191,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 1, type: 'private', first_name: 'Owner' },
        from: { id: 1, is_bot: false, first_name: 'Owner' },
        photo: [
          {
            file_id: 'photo',
            file_unique_id: 'unique',
            width: 1,
            height: 1,
            file_size: png.length,
          },
        ],
      },
    });
    expect(
      requests.some((r) => r.method === 'sendPhoto' && r.payload.caption.includes('предпросмотр')),
    ).toBe(true);
    expect((await app.services.ctas.ensure(a.id)).mediaPath ?? null).toBeNull();
    await app.server!.inject({
      method: 'POST',
      url: '/api/demo/telegram',
      headers: { authorization: 'Bearer demo-local-token' },
      payload: { callback: 'v18msave' },
    });
    const cta = await app.services.ctas.ensure(a.id);
    expect(cta.mediaPath).toContain(media);
    expect(cta.mediaSha256).toHaveLength(64);
    expect(await app.db.list('aiRequest')).toHaveLength(0);
  } finally {
    fetchMock.mockRestore();
    await app.close();
    await rm(media, { recursive: true, force: true });
  }
});
