import type { Config } from '../core/config.js';
import { AppError, assert } from '../core/errors.js';
import type { Llm, LlmResult } from './service.js';
export type Purpose = 'POST' | 'REPLY' | 'BIO';
export function llmSpec(config: Config, purpose: Purpose = 'POST') {
  if (config.LLM_PROVIDER !== 'openai')
    return {
      model: config.LLM_MODEL,
      provider: config.LLM_BASE_URL,
      effort: 'legacy',
      input: config.LLM_INPUT_PRICE_PER_MILLION,
      output: config.LLM_OUTPUT_PRICE_PER_MILLION,
      cached: config.LLM_INPUT_PRICE_PER_MILLION,
      write30: config.LLM_INPUT_PRICE_PER_MILLION,
      write12: config.LLM_INPUT_PRICE_PER_MILLION,
    };
  const model =
    purpose === 'POST'
      ? config.POST_MODEL
      : purpose === 'REPLY'
        ? config.REPLY_MODEL
        : config.BIO_MODEL;
  assert(
    ['gpt-6.2-sol', 'gpt-6.1-terra'].includes(model),
    'UNKNOWN_MODEL_PRICE',
    'Нет проверенного тарифа для выбранной модели',
  );
  const sol = model === 'gpt-6.2-sol';
  return {
    model,
    provider: 'https://api.openai.com/v1/responses',
    effort: purpose === 'POST' || sol ? 'low' : 'none',
    input: sol ? 2 : 1,
    output: sol ? 10 : 5,
    cached: sol ? 0.1 : 0.05,
    write30: sol ? 2.5 : 1.25,
    write12: sol ? 5 : 2.5,
  };
}
function tokens(value: unknown, label: string) {
  assert(
    Number.isSafeInteger(value) && Number(value) >= 0,
    'OPENAI_USAGE_UNKNOWN',
    `Не подтверждён счётчик ${label}`,
  );
  return Number(value);
}
export class OpenAiResponses implements Llm {
  constructor(
    private config: Config,
    private request: typeof fetch = fetch,
  ) {}
  withConfig(config: Config) {
    return new OpenAiResponses(config, this.request);
  }
  async generate(
    system: string,
    user: string,
    options?: {
      maxTokens: number;
      purpose?: Purpose;
      onReceipt?: (receipt: unknown) => Promise<void>;
    },
  ): Promise<LlmResult> {
    assert(
      this.config.LLM_PROVIDER === 'openai',
      'OPENAI_PROVIDER_REQUIRED',
      'Нужен официальный провайдер OpenAI',
    );
    assert(this.config.OPENAI_API_KEY, 'LLM_NOT_CONFIGURED', 'Не настроен OPENAI_API_KEY');
    const spec = llmSpec(this.config, options?.purpose),
      max = options?.maxTokens ?? this.config.LLM_MAX_TOKENS;
    assert(
      Buffer.byteLength(system + user) <= 64000,
      'OPENAI_INPUT_LIMIT',
      'Для этого режима нужен более короткий исходник',
    );
    let response: Response;
    try {
      response = await this.request(spec.provider, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: spec.model,
          instructions: system,
          input: user,
          reasoning: { effort: spec.effort },
          max_output_tokens: max,
          store: false,
          service_tier: 'default',
          tools: [],
        }),
        signal: AbortSignal.timeout(90000),
      });
    } catch {
      throw new AppError(
        'OPENAI_NETWORK',
        'Соединение OpenAI прервалось; повтор автоматически не выполняется',
      );
    }
    if (!response.ok)
      throw new AppError(
        response.status >= 500 || response.status === 408 ? 'OPENAI_NETWORK' : 'OPENAI_REJECTED',
        `OpenAI отклонил запрос: HTTP ${response.status}`,
      );
    const data = (await response.json()) as any,
      usage = data.usage;
    await options?.onReceipt?.({
      responseId: data.id,
      model: data.model,
      status: data.status,
      usage,
      output: data.output,
    });
    const inputTokens = tokens(usage?.input_tokens, 'input'),
      outputTokens = tokens(usage?.output_tokens, 'output'),
      cached = tokens(usage?.input_tokens_details?.cached_tokens, 'cached input'),
      writes = tokens(usage?.input_tokens_details?.cache_write_tokens, 'cache writes'),
      reasoning = tokens(usage?.output_tokens_details?.reasoning_tokens, 'reasoning');
    assert(
      tokens(usage?.total_tokens, 'total') === inputTokens + outputTokens &&
        cached + writes <= inputTokens &&
        reasoning <= outputTokens,
      'OPENAI_USAGE_UNKNOWN',
      'Несогласованные счётчики OpenAI',
    );
    const breakdown = usage.input_tokens_details.cache_write_tokens_details;
    const write12 = breakdown ? tokens(breakdown.ttl_12h_tokens, '12h writes') : 0,
      write30 = breakdown ? tokens(breakdown.ttl_30m_tokens, '30m writes') : writes;
    assert(
      write30 + write12 === writes &&
        inputTokens <= Buffer.byteLength(system + user) + 1000 &&
        outputTokens <= max,
      'OPENAI_USAGE_UNKNOWN',
      'Расход превысил границы запроса',
    );
    assert(
      ['default', 'standard', undefined].includes(data.service_tier),
      'OPENAI_USAGE_UNKNOWN',
      'Не подтверждён стандартный тариф',
    );
    const costUsd =
      ((inputTokens - cached - writes) * spec.input +
        cached * spec.cached +
        write30 * spec.write30 +
        write12 * spec.write12 +
        outputTokens * spec.output) /
      1e6;
    const text = (data.output ?? [])
      .filter((item: any) => item.type === 'message')
      .flatMap((item: any) => item.content ?? [])
      .filter((item: any) => item.type === 'output_text' && typeof item.text === 'string')
      .map((item: any) => item.text)
      .join('\n');
    return {
      text,
      inputTokens,
      outputTokens,
      costUsd,
      model: typeof data.model === 'string' ? data.model : spec.model,
      responseId: data.id,
      cachedInputTokens: cached,
      cacheWriteTokens: writes,
      reasoningTokens: reasoning,
      effort: spec.effort,
      responseStatus: data.status,
      usageJson: JSON.stringify({
        usage,
        serviceTier: data.service_tier,
        requestedModel: spec.model,
        pricesPerMillion: spec,
      }),
    };
  }
}
