import { InlineKeyboard as GrammyInlineKeyboard } from 'grammy';
/** All menus use real Bot API styles. Local grammY exposes the typed .style() API. */
export class InlineKeyboard extends GrammyInlineKeyboard {
  override text(text: string, callback_data?: string) {
    super.text(text, callback_data);
    const label = text.replace(/^[^\p{L}]+/u, '').trim();
    if (
      /^(?:назад|к аккаунту|вернуться к аккаунту|аккаунт|главное меню|меню|отмена)(?:\s|$)/iu.test(
        label,
      )
    )
      super.style('danger');
    else if (/^(?:запустить|включить автопилот|подтвердить запуск)/iu.test(label))
      super.style('success');
    else if (/настрой|расписание|источники|стиль|статистика|очередь/iu.test(label))
      super.style('primary');
    return this;
  }
}
