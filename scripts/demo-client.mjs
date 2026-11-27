import 'dotenv/config';
const text = process.argv.slice(2).join(' ') || '/start';
const payload = text.startsWith('callback:') ? { callback: text.slice(9) } : { text };
const res = await fetch('http://127.0.0.1:3000/api/demo/telegram', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN || 'demo-local-token'}`,
  },
  body: JSON.stringify(payload),
});
if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
for (const msg of (await res.json()).messages) {
  if (msg.text) console.log(msg.text);
  if (msg.reply_markup)
    for (const row of msg.reply_markup.inline_keyboard)
      console.log(row.map((b) => `${b.text} → callback:${b.callback_data}`).join(' | '));
}
