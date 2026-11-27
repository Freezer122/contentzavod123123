export function contentFeatures(
  text: string,
  metadata?: { topic?: string; format?: string; hook?: string },
) {
  const hasQuestion = text.includes('?');
  const topic =
    metadata?.topic && metadata.topic !== 'Не указана'
      ? metadata.topic
      : /(BTC|ETH|крипт|биткоин)/i.test(text)
        ? 'Криптовалюты'
        : /рын|трейд|риск|акци/i.test(text)
          ? 'Рынки и трейдинг'
          : 'Другое';
  const format =
    metadata?.format && metadata.format !== 'Не указан'
      ? metadata.format
      : /^\s*(?:[-•]|\d+[.)])/m.test(text)
        ? 'Список'
        : hasQuestion
          ? 'Вопрос'
          : text.split(/\n\s*\n/).length > 1
            ? 'Разбор'
            : 'Короткая мысль';
  const hook =
    metadata?.hook && metadata.hook !== 'Не указан'
      ? metadata.hook
      : /^[^.!\n]*\?/.test(text)
        ? 'Вопрос'
        : /^\s*[+-]?\d/.test(text)
          ? 'Число'
          : 'Утверждение';
  return { topic, format, hook, textLength: [...text].length, hasQuestion };
}

/** Deterministic topic labels for discovery/provenance; no model or prompt learning. */
export function tradingTopic(text: string) {
  const categories: [RegExp, string][] = [
    [/опцион|экспирац|дельта|тета/iu, 'Опционы'],
    [/стоп|тейк|убыт|риск|плечо|маржин/iu, 'Управление риском'],
    [/fomo|эмоци|эйфор|дисциплин|психолог|толп/iu, 'Психология торговли'],
    [/техническ.*анализ|поддержк|сопротивлен|диверген|индикатор|таймфрейм/iu, 'Технический анализ'],
    [/ликвид|стакан|спред|проскальзыв/iu, 'Ликвидность и исполнение'],
    [/фонд|управляющ|портфел|ребаланс/iu, 'Фонды и портфели'],
    [/btc|eth|биткоин|крипт|фандинг/iu, 'Криптовалюты'],
    [/бэктест|стратег|скальпинг/iu, 'Торговые стратегии'],
  ];
  return categories.find(([pattern]) => pattern.test(text))?.[1] ?? contentFeatures(text).topic;
}
