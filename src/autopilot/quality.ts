import { compareFacts } from '../content/validation.js';
import { normalizeText, isRussian } from '../content/normalizer.js';
import { protectedTokens } from '../content/service.js';
import { tradingRelevance } from '../engagement/relevance.js';
export const canonicalText = (s: string) =>
  normalizeText(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const stems = (s: string) =>
  new Set(
    canonicalText(s)
      .split(' ')
      .filter((w) => w.length >= 4)
      .map((w) => w.slice(0, 5)),
  );
export function similarity(a: string, b: string) {
  const aa = stems(a),
    bb = stems(b);
  return [...aa].filter((w) => bb.has(w)).length / Math.max(1, Math.min(aa.size, bb.size));
}
// Context comes from concrete shared concepts, not merely the generic word «рынок».
const contextFacets: RegExp[][] = [
  [
    /стоп|тейк/iu,
    /позици|поз[уы]/iu,
    /сценар|план|стратег/iu,
    /вход|выход|выхо|закры/iu,
    /убыт|риск/iu,
    /таймфрейм|недельк/iu,
  ],
  [
    /фонд|управляющ|управлят/iu,
    /fomo|страх.*пропуст|эйфор/iu,
    /персональн|одиноч|личн/iu,
    /вместе.*всем|одн.*лодк|коллектив|толп/iu,
    /клиент|карьер|спросят|увол/iu,
    /ошиб|проигра|правым/iu,
  ],
  [/опцион|экспирац/iu, /дельт|тета|волатиль/iu, /стоимост|цен[аеыу]/iu, /контракт|исполнен/iu],
];
function contextSimilarity(a: string, b: string) {
  const generic = new Set([
    'трейд',
    'рынок',
    'рынке',
    'рынки',
    'торго',
    'сейча',
    'можно',
    'нужно',
    'вообщ',
    'такое',
    'страт',
    'влияет',
    'учиты',
    'заран',
  ]);
  const aa = new Set([...stems(a)].filter((w) => !generic.has(w))),
    bb = new Set([...stems(b)].filter((w) => !generic.has(w)));
  return [...aa].filter((w) => bb.has(w)).length / Math.max(1, Math.min(aa.size, bb.size));
}
export function concreteContext(source: string, text: string) {
  const specific = [
    /проскальзыв/iu,
    /экспирац/iu,
    /маржинколл/iu,
    /дивергенц/iu,
    /волатильн/iu,
    /дельт/iu,
    /ликвидн/iu,
    /фандинг/iu,
    /комисси/iu,
    /корреляц/iu,
    /бэктест/iu,
    /усреднен/iu,
    /диверсификац/iu,
    /гэп/iu,
    /спред/iu,
    /эквити/iu,
    /безубыт/iu,
    /переторговк/iu,
    /контртренд/iu,
    /ребалансиров/iu,
    /стоп-?лосс/iu,
    /таймфрейм/iu,
  ];
  if (specific.some((p) => p.test(source) && p.test(text))) return true;
  return contextFacets.some(
    (group) =>
      group.filter((p) => p.test(source)).length >= 2 &&
      group.filter((p) => p.test(text)).length >= 2,
  );
}
export function qualityGate(
  kind: 'POST' | 'REPLY',
  text: string,
  source: string,
  previous: string[] = [],
) {
  const rejected: string[] = [],
    review: string[] = [];
  if (text !== normalizeText(text)) rejected.push('FORMAT');
  if (!isRussian(text) || text.length < 18 || text.length > (kind === 'POST' ? 500 : 350))
    rejected.push('LANGUAGE_OR_LENGTH');
  if (kind === 'REPLY' && text.split(/[!?]|(?<!\d)\.(?!\d)/u).filter((s) => s.trim()).length > 3)
    rejected.push('TOO_MANY_SENTENCES');
  if (/https?:|www\.|t\.me|@[\w.]+/iu.test(text)) review.push('URL_OR_MENTION');
  if (/\$[^\s\p{L}\d]|[\p{L}\d]https?:/u.test(text)) rejected.push('BROKEN_TOKEN');
  const facts = new Set(protectedTokens(source));
  if (protectedTokens(text).some((t) => !facts.has(t))) review.push('UNSUPPORTED_NUMBER_OR_TICKER');
  if (
    compareFacts(source, text).some((i) => i.level === 'BLOCKED' && i.generated !== 'не сохранено')
  )
    review.push('FINANCIAL_FACT_CHANGED');
  if (
    /(?:сегодня|вчера|сейчас)\s+(?:вырос|упал|подорожал|обвалил)|вышл[аи]\s+на\s+IPO|объявил[аи]?\s+(?:выкуп|дивиденд)/iu.test(
      text,
    )
  )
    review.push('UNVERIFIED_CURRENT_FACT');
  if (
    /(?:я|мы)\s+(?:заработ|подня|слил|заш[её]л|откр[ыи]л|купил|продал)|моя\s+(?:сделка|доходност)|мой\s+(?:профит|депозит)|гарантированн.*(?:доход|прибыл)/iu.test(
      text,
    )
  )
    review.push('PERSONAL_TRADE_OR_RETURN');
  if (/(?:убью|убить тебя|зарежу|изнасилую|подожгу тебя|расстрелять)/iu.test(text))
    rejected.push('THREAT');
  if (
    /^(?:согласен|точно|класс|интересно|отличный пост|спасибо)[!?.\s]*$/iu.test(text) ||
    /как (?:ии|языковая модель)|в заключение|важно отметить/iu.test(text) ||
    /^(?:[\p{L}-]+[: ,]*)?(?:это\s+)?(?:интересно|важно|сложно|правильно|согласен|точно)[!?.\s]*$/iu.test(
      text,
    )
  )
    rejected.push('EMPTY_OR_LECTURE');
  if (!tradingRelevance(source, 'STRICT').accepted) rejected.push('SOURCE_NOT_TRADING');
  if (
    (kind === 'REPLY' || !tradingRelevance(text, 'STRICT').accepted) &&
    contextSimilarity(text, source) < 0.15 &&
    !concreteContext(source, text)
  )
    review.push('LOW_CONTEXT_RELEVANCE');
  if (previous.some((t) => canonicalText(t) === canonicalText(text) || similarity(text, t) >= 0.82))
    rejected.push('GLOBAL_TEXT_DUPLICATE');
  if (
    kind === 'POST' &&
    (similarity(text, source) >= 0.65 || canonicalText(source).includes(canonicalText(text)))
  )
    review.push('COSMETIC_REWRITE_OR_QUOTE');
  if (
    kind === 'POST' &&
    /(?:я|мы)\s+(?:родил|устроил|работал|встречал)|у меня\s+(?:был|есть)|мой личный опыт/iu.test(
      text,
    )
  )
    review.push('INVENTED_STORY');
  return {
    status: rejected.length
      ? ('REJECTED' as const)
      : review.length
        ? ('NEEDS_REVIEW' as const)
        : ('PASS' as const),
    reasons: [...rejected, ...review],
    version: 'autopilot-quality-v116.1',
  };
}

/** Operational classification retains hard fact/rights gates; cosmetic context warnings need not block a normal text. */
export function operationalQuality(
  kind: 'POST' | 'REPLY',
  text: string,
  source: string,
  previous: string[] = [],
) {
  const q = qualityGate(kind, text, source, previous);
  const cosmetic = q.reasons.every((r) => r === 'LOW_CONTEXT_RELEVANCE');
  const contextual =
    kind === 'POST'
      ? tradingRelevance(text, 'STRICT').accepted
      : contextSimilarity(text, source) > 0 || concreteContext(source, text);
  return {
    ...q,
    decision:
      q.status === 'PASS'
        ? ('PASS' as const)
        : q.status === 'NEEDS_REVIEW' && cosmetic && contextual
          ? ('WARNING' as const)
          : ('BLOCKED' as const),
  };
}
