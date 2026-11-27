import { it, expect } from 'vitest';
import { normalizeText } from '../src/content/normalizer.js';
it('нормализует русский Unicode и сохраняет числа, тикеры, URL и tracking', () => {
  const url = 'https://Example.com/AbC123?Code=XyZ&ref=A_B';
  expect(
    normalizeText(
      `\uFEFFПРИВЕТ\u00a0  МИР. 😀\n\nРИСК — 3.5% В BTC И $AAPL.\n${url}\nВ заключение, всё просто.`,
    ),
  ).toBe(`привет мир\n\nриск - 3.5% в BTC и $AAPL\n${url}`);
});
it('идемпотентен, не повреждает десятичные точки и удаляет emoji sequences', () => {
  const s = 'Доход 1.25.\n👨‍👩‍👧‍👦 🇷🇺 1️⃣\n\u200bТекст – ещё.\n\n\n';
  expect(normalizeText(s)).toBe('доход 1.25\n\nтекст - ещё');
  expect(normalizeText(normalizeText(s))).toBe(normalizeText(s));
});
it('удаляет невидимые символы также внутри защищённых URL и фрагментов', () => {
  expect(normalizeText('ТЕКСТ\u202e.\nhttps://Example.com/Ab\u200bC\n`B\u0001TC`')).toBe(
    'текст\nhttps://Example.com/AbC\n`BTC`',
  );
});
