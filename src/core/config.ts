import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  APP_MODE: z.enum(['demo', 'production']).default('demo'),
  PROCESS_ROLE: z.enum(['all', 'api', 'worker', 'bot']).default('all'),
  TRUST_PROXY: z.string().default(''),
  TIMEZONE: z.string().default('Europe/Moscow'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().default('postgresql://factory:change-me@127.0.0.1:5432/content_factory'),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
  PUBLISH_QUEUE_NAME: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('publishing'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_ALLOWED_IDS: z.string().default(''),
  TELEGRAM_CHANNEL_ID: z.string().default(''),
  INTERNAL_API_TOKEN: z.string().default('demo-local-token'),
  TRACKING_HASH_SECRET: z.string().default('demo-local-hash-secret'),
  PUBLIC_BASE_URL: z.string().url().default('https://factory.example.com'),
  TELEGRAM_TARGET: z.string().url().default('https://t.me/your_channel'),
  BROWSER_EXECUTION_MODE: z.enum(['DRY_RUN', 'LIVE']).default('DRY_RUN'),
  BROWSER_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
  ADSPOWER_BASE_URL: z.string().url().default('http://127.0.0.1:50325'),
  ADSPOWER_API_KEY: z.string().default(''),
  ADSPOWER_ALLOWED_PROFILE_IDS: z.string().default(''),
  ADSPOWER_HEADLESS: z.enum(['0', '1']).default('0'),
  PROFILE_CHANGES_ALLOWED: z.enum(['0', '1']).default('0'),
  ENGAGEMENT_EXECUTION_MODE: z.enum(['DRY_RUN', 'LIVE']).default('DRY_RUN'),
  MANUAL_LIVE_ALLOWED: z.enum(['0', '1']).default('0'),
  TELEGRAM_OWNER_ID: z.string().default(''),
  ONE_SHOT_REPLY_JOB_ID: z.string().default(''),
  ONE_SHOT_REPLY_USER_ID: z.string().default(''),
  ONE_SHOT_REPLY_EXPIRES_AT: z.string().default(''),
  DOLPHIN_BASE_URL: z.string().url().default('http://127.0.0.1:3001'),
  DOLPHIN_API_TOKEN: z.string().default(''),
  LLM_PROVIDER: z.enum(['compatible', 'openai']).default('compatible'),
  OPENAI_API_KEY: z.string().default(''),
  POST_MODEL: z.string().default('gpt-6.2-sol'),
  REPLY_MODEL: z.string().default('gpt-6.1-terra'),
  BIO_MODEL: z.string().default('gpt-6.1-terra'),
  AI_TOTAL_LIMIT_USD: z.coerce.number().positive().default(5),
  AI_WARNING_USD: z.coerce.number().positive().default(3),
  LLM_BASE_URL: z.string().url().default('https://api.example.com/v1'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default(''),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.6),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(1000),
  LLM_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().default(0),
  LLM_OUTPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().default(0),
  AI_DAILY_LIMIT_USD: z.coerce.number().positive().default(5),
  AI_MONTHLY_LIMIT_USD: z.coerce.number().positive().default(50),
  THREADS_SELECTORS_PATH: z.string().default('fixtures/threads-selectors.json'),
  MEDIA_DIR: z.string().default('/var/lib/content-factory/media'),
  ARTIFACTS_DIR: z.string().default('artifacts'),
  DEMO_STATE_PATH: z.string().default('.local/demo-state.json'),
  INSIGHTS_ACCESS_TOKEN: z.string().default(''),
  INSIGHTS_BASE_URL: z.string().url().default('https://graph.threads.net/v1.0'),
  X_BEARER_TOKEN: z.string().default(''),
});
export type Config = z.infer<typeof schema> & { allowedIds: number[] };
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  new Intl.DateTimeFormat('ru-RU', { timeZone: c.TIMEZONE });
  if (
    c.TRUST_PROXY.split(',')
      .filter(Boolean)
      .some((x) => !['127.0.0.1', '::1'].includes(x.trim()))
  )
    throw new Error('TRUST_PROXY допускает только loopback адреса');
  const allowedIds = c.TELEGRAM_ALLOWED_IDS.split(',')
    .filter(Boolean)
    .map((x) => Number(x.trim()));
  if (allowedIds.some((x) => !Number.isSafeInteger(x) || x <= 0))
    throw new Error('Некорректный Telegram user ID');
  for (const url of [c.ADSPOWER_BASE_URL, c.DOLPHIN_BASE_URL]) {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('Browser Local API должен использовать loopback адрес');
  }
  if (c.APP_MODE === 'production') {
    if (c.INTERNAL_API_TOKEN.length < 32 || c.TRACKING_HASH_SECRET.length < 32)
      throw new Error('Задайте секреты длиной минимум 32 символа');
    if (!c.PUBLIC_BASE_URL.startsWith('https://'))
      throw new Error('Для redirect endpoint требуется HTTPS');
    if (c.PROCESS_ROLE !== 'worker' && !allowedIds.length)
      throw new Error('TELEGRAM_ALLOWED_IDS обязателен');
    if (c.PROCESS_ROLE !== 'worker' && !c.TELEGRAM_BOT_TOKEN)
      throw new Error('Задайте TELEGRAM_BOT_TOKEN');
    if (!c.LLM_INPUT_PRICE_PER_MILLION || !c.LLM_OUTPUT_PRICE_PER_MILLION) {
      if (c.LLM_PROVIDER === 'compatible' && c.LLM_API_KEY)
        throw new Error('Для контроля бюджета задайте цены LLM');
    }
  }
  if (c.LLM_PROVIDER === 'openai' && c.AI_WARNING_USD >= c.AI_TOTAL_LIMIT_USD)
    throw new Error('Порог предупреждения должен быть ниже лимита');
  return { ...c, allowedIds };
}
