export interface ValidationIssue {
  level: 'WARNING' | 'BLOCKED';
  source: string;
  generated: string;
  reason: string;
}
export interface ValidationResult {
  status: 'PASS' | 'WARNING' | 'BLOCKED';
  issues: ValidationIssue[];
}
const words: Record<string, number> = {};
const forms = [
  'ноль нуля нулю нулём нуле',
  'один одна одно одного одной одному одним одном',
  'два две двух двум двумя',
  'три трёх трех трём трем тремя',
  'четыре четырёх четырех четырём четырем четырьмя',
  'пять пяти пятью',
  'шесть шести шестью',
  'семь семи семью',
  'восемь восьми восемью',
  'девять девяти девятью',
  'десять десяти десятью',
  'одиннадцать одиннадцати',
  'двенадцать двенадцати',
  'тринадцать тринадцати',
  'четырнадцать четырнадцати',
  'пятнадцать пятнадцати',
  'шестнадцать шестнадцати',
  'семнадцать семнадцати',
  'восемнадцать восемнадцати',
  'девятнадцать девятнадцати',
  'двадцать двадцати',
];
forms.forEach((f, n) =>
  f.split(' ').forEach((w) => {
    words[w] = n;
  }),
);
for (const [f, n] of [
  ['тридцать тридцати', 30],
  ['сорок сорока', 40],
  ['пятьдесят пятидесяти', 50],
  ['сто ста', 100],
  ['тысяча тысячи тысяч', 1000],
] as const)
  f.split(' ').forEach((w) => {
    words[w] = n;
  });
export function normalizeNumerals(text: string) {
  let result = text
    .toLowerCase()
    .replace(/[а-яё]+/gu, (w) => (words[w] === undefined ? w : String(words[w])));
  // Compose common cardinal phrases, never concatenate unrelated digits.
  result = result.replace(/\b(20|30|40|50)\s+([1-9])\b/g, (_, a, b) => String(+a + +b));
  return result;
}
function facts(text: string) {
  const normalized = normalizeNumerals(text).replace(/(?<=\d),(?=\d)/g, '.');
  const numbers = [...normalized.matchAll(/(?<![\p{L}\p{N}_])[+-]?\d+(?:\.\d+)*/gu)].map(
    (m) => m[0],
  );
  const financial = [
    ...normalized.matchAll(
      /(?:[$€₽£]\s*\d[\d., ]*(?:[kmb]\b)?|(?<![\p{L}\p{N}_])[+-]?\d+(?:\.\d+)?\s*(?:%|процент[а-я]*|доллар[а-я]*|рубл[а-я]*|евро|usd\b|usdt\b|btc\b|eth\b|[xх]\b)|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b|\b1\s*:\s*\d+)/giu,
    ),
  ].map((m) => m[0].replace(/\s+/g, '').replace(/процент[а-я]*/g, '%'));
  const ids = [
    ...text.matchAll(
      /\$[A-Z][A-Z0-9]*\b|\b(?:BTC|ETH|USDT|AAPL|TSLA|SPX|EURUSD|NASDAQ)\b|\b(?=[A-Za-z0-9_]*[_\d])(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z][A-Za-z0-9_]+\b|https?:\/\/[^\s]+/g,
    ),
  ].map((m) => m[0].replace(/[.!?]+$/, ''));
  return {
    numbers: [...new Set(numbers)].sort(),
    financial: [...new Set(financial)].sort(),
    ids: [...new Set(ids)].sort(),
  };
}
export function compareFacts(source: string, generated: string): ValidationIssue[] {
  const a = facts(source),
    b = facts(generated),
    issues: ValidationIssue[] = [];
  for (const kind of ['financial', 'ids', 'numbers'] as const) {
    if (JSON.stringify(a[kind]) === JSON.stringify(b[kind])) continue;
    if (kind === 'numbers' && issues.length) continue;
    const removed = a[kind].filter((x) => !b[kind].includes(x)),
      added = b[kind].filter((x) => !a[kind].includes(x));
    issues.push({
      level:
        kind === 'numbers' &&
        !/\$|\b(?:BTC|ETH|USD|USDT)\b|цен[аы]|price|риск|risk|плеч|стоп|уров[ен]/iu.test(
          source + ' ' + generated,
        )
          ? 'WARNING'
          : 'BLOCKED',
      source: removed.join(', ') || 'нет',
      generated: added.join(', ') || 'не сохранено',
      reason:
        kind === 'ids'
          ? 'Изменён тикер, ссылка или регистрозависимый идентификатор'
          : kind === 'financial'
            ? 'Обнаружено изменение финансовых данных'
            : /\$|\b(?:BTC|ETH|USD|USDT)\b|цен[аы]|price|риск|risk|плеч|стоп|уров[ен]/iu.test(
                  source + ' ' + generated,
                )
              ? 'Обнаружено изменение финансовых данных'
              : 'Числовое значение требует просмотра',
    });
  }
  return issues;
}
