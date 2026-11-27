import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
const [mode, input, output, keyPath] = process.argv.slice(2);
if (!['encrypt', 'decrypt'].includes(mode) || !input || !output || !keyPath)
  throw new Error('Usage: backup-crypt.mjs encrypt|decrypt INPUT OUTPUT KEY_PATH');
const magic = Buffer.from('CF_BACKUP_V1\0');
let key;
try {
  key = await readFile(keyPath);
} catch (e) {
  if (e.code !== 'ENOENT' || mode !== 'encrypt') throw e;
  key = randomBytes(32);
  await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 });
}
if (key.length !== 32) throw new Error('INVALID_BACKUP_KEY');
const data = await readFile(input);
let result;
if (mode === 'encrypt') {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce),
    body = Buffer.concat([cipher.update(data), cipher.final()]);
  result = Buffer.concat([magic, nonce, cipher.getAuthTag(), body]);
} else {
  if (!data.subarray(0, magic.length).equals(magic)) throw new Error('INVALID_BACKUP_FORMAT');
  const cipher = createDecipheriv(
    'aes-256-gcm',
    key,
    data.subarray(magic.length, magic.length + 12),
  );
  cipher.setAuthTag(data.subarray(magic.length + 12, magic.length + 28));
  result = Buffer.concat([cipher.update(data.subarray(magic.length + 28)), cipher.final()]);
}
await writeFile(output, result, { flag: 'wx', mode: 0o600 });
await chmod(output, 0o600);
console.log(
  JSON.stringify({
    mode,
    bytes: result.length,
    sha256: createHash('sha256').update(result).digest('hex'),
  }),
);
