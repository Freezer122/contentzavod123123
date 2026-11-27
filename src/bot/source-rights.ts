import { InlineKeyboard } from './keyboard.js';

import type { Database } from '../db/database.js';
import { sourceRights } from '../content/rights.js';
export const rightsKeyboard = (id: string) =>
  new InlineKeyboard()
    .text('Мой авторский текст', `v113right:OWN:${id}`)
    .row()
    .text('Есть разрешение использовать', `v113right:PERMITTED:${id}`)
    .row()
    .text('Чужой материал без прав', `v113right:THIRD_PARTY:${id}`);
export async function rightsLabel(db: Database, id: string) {
  const r = await sourceRights(db, id);
  return r.rightsStatus === 'UNCONFIRMED'
    ? 'происхождение не подтверждено; выберите вариант до публикации'
    : r.sourceType === 'OWN'
      ? 'мой авторский текст, подтверждение сохранено'
      : 'разрешение на использование сохранено';
}
