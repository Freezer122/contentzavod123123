export type Strictness = 'STRICT' | 'NORMAL' | 'BROAD';
export const tradingQueries = ['торговая стратегия', 'трейдинг стоп лосс', 'котировки акций'];
// Rotate a small bounded set so configured topics are actually searched across sessions.
export function tradingSearchQueries(
  keywords: string[],
  turn = Math.floor(Date.now() / (8 * 3600000)),
) {
  const pool = [
    ...new Set([
      ...tradingQueries,
      ...keywords.map((k) =>
        /^(рынок|риск|деньги|доходность|инвесторы)$/iu.test(k) ? `трейдинг ${k}` : k,
      ),
    ]),
  ];
  return Array.from(
    { length: Math.min(3, pool.length) },
    (_, i) => pool[(turn * 3 + i) % pool.length]!,
  );
}
const high = [
  /трейд[а-я]*/giu,
  /\b(?:btc|bitcoin|eth|ethereum|forex|scalping|vwap|fvg)\b/giu,
  /биткоин|фьючерс[а-я]*|форекс|скальпинг|опцион[а-я]*/giu,
  /стоп[ -]?лосс|техническ[а-я]* анализ|торгов[а-я]* стратег[а-я]*|уров(?:ень|ни|ня|ней|не) поддержк[а-я]*|order block|поддержк[а-я]* и сопротивлен[а-я]*/giu,
];
const medium = [
  /бирж[а-я]*|котиров[а-я]*|брокер[а-я]*|ценн[а-я]* бумаг[а-я]*/giu,
  /акци[а-я]*(?=\s+(?:компани|строител|на бирже|покуп|прод|раст|пад))|(?:покуп|прод|котиров)[а-я]*\s+акци[а-я]*/giu,
  /движени[а-я]* цен[а-я]*|торгов[а-я]* объ[её]м/giu,
];
const negative = [
  /продаж[а-я]* квартир|прода[юё][а-я]* квартир|аренд[а-я]* квартир|недвижим[а-я]*/giu,
  /водител[а-я]*|дорожн[а-я]* движен[а-я]*|пдд|автомобил[а-я]*/giu,
  /скидк[а-я]*|доставка|купить одежду|бытов[а-я]* конфликт/giu,
];
export function tradingRelevance(
  text: string,
  strictness: Strictness = 'STRICT',
  exclusions: string[] = [],
  keywords: string[] = [],
) {
  const t = text.toLowerCase(),
    reasons: string[] = [],
    rejected: string[] = [];
  const hits = (patterns: RegExp[]) => patterns.flatMap((p) => [...t.matchAll(p)].map((m) => m[0]));
  const specific = [...new Set(hits(high))],
    contextual = [...new Set(hits(medium))],
    neg = hits(negative);
  // Ambiguous jargon counts only with an independent market context.
  if ((specific.length || contextual.length) && /лонг|шорт|плечо|ликвидност|\bema\b/iu.test(t))
    specific.push('торговый контекст');
  let score = specific.length * 4 + contextual.length * 2;
  const custom = keywords.filter(
    (k) =>
      !/^(рынок|риск|деньги|доход|инвестиции|заработок)$/iu.test(k.trim()) &&
      t.includes(k.toLowerCase()),
  );
  if (specific.length || contextual.length) score += Math.min(2, custom.length);
  if (specific.length) reasons.push('Торговые признаки: ' + specific.join(', '));
  if (contextual.length) reasons.push('Финансовый контекст: ' + contextual.join(', '));
  if (neg.length && !specific.length && contextual.length < 2) {
    score = Math.max(0, score - 5);
    rejected.push('Преобладает неторговая тема: ' + [...new Set(neg)].join(', '));
  }
  const exclusionsFound = exclusions.filter((k) => t.includes(k.toLowerCase()));
  if (exclusionsFound.length) rejected.push('Исключения: ' + exclusionsFound.join(', '));
  const threshold = { STRICT: 4, NORMAL: 3, BROAD: 2 }[strictness];
  if (!specific.length && !contextual.length)
    rejected.push('Нет конкретного контекста финансовой торговли; общих слов недостаточно');
  if (score < threshold) rejected.push(`Оценка ${score} ниже порога ${threshold}`);
  return {
    tradingRelevanceScore: score,
    accepted: !rejected.length,
    acceptedReasons: reasons,
    rejectionReasons: rejected,
    threshold,
  };
}
