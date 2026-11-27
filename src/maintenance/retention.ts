import { readdir, stat, readFile, unlink, access, lstat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { Database } from '../db/database.js';
const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
export async function cleanupArtifacts(db: Database, roots: string[], now = Date.now()) {
  const unresolved = new Set(
    (await db.list('publishJob'))
      .filter(
        (j) =>
          j.status === 'NEEDS_REVIEW' ||
          j.postStatus === 'UNCERTAIN' ||
          j.commentStatus === 'UNCERTAIN',
      )
      .map((j) => j.id),
  );
  const removed: string[] = [],
    kept: string[] = [];
  async function visit(root: string, parentKeep = false) {
    const rootInfo = await lstat(root).catch(() => null);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return;
    const keep =
      parentKeep ||
      basename(root).toUpperCase().includes('KEEP') ||
      (await exists(join(root, 'KEEP')));
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    const metadata = new Map<string, any>();
    for (const entry of entries)
      if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          metadata.set(entry.name, JSON.parse(await readFile(join(root, entry.name), 'utf8')));
        } catch {}
      }
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(path, keep);
        continue;
      }
      if (
        !entry.isFile() ||
        (basename(root) !== 'tmp' && !/\.(png|jpe?g|webp|html|json|log)$/i.test(entry.name))
      )
        continue;
      const mark =
        keep || entry.name.toUpperCase().includes('KEEP') || (await exists(path + '.KEEP'));
      const id = entry.name.match(/^([a-f0-9-]{36})-/i)?.[1];
      if (mark || (id && unresolved.has(id))) {
        kept.push(path);
        continue;
      }
      let meta: any = metadata.get(entry.name.replace(/\.[^.]+$/, '.json')) ?? {};
      const sidecar = path.replace(/\.[^.]+$/, '.json');
      try {
        meta = JSON.parse(await readFile(sidecar, 'utf8'));
      } catch {}
      if (meta.keep === true || (meta.jobId && unresolved.has(meta.jobId))) {
        kept.push(path);
        continue;
      }
      const critical =
        meta.critical === true ||
        /UNCERTAIN|AUTH_REQUIRED|CHALLENGE|RESTRICTED|неизвест|авторизац|captcha|ручная проверка/i.test(
          String(meta.errorCode ?? '') + ' ' + String(meta.error ?? ''),
        );
      const days = critical ? 30 : entry.name.includes('debug') ? 3 : 7;
      // Keep a classification sidecar while any sibling image is still retained.
      if (entry.name.endsWith('.json') && critical) {
        const stem = entry.name.slice(0, -5);
        let imageRetained = false;
        for (const sibling of entries.filter(
          (e) => e.isFile() && e.name.startsWith(stem + '.') && /\.(png|jpe?g|webp)$/i.test(e.name),
        ))
          if (now - (await stat(join(root, sibling.name))).mtimeMs <= days * 86400000)
            imageRetained = true;
        if (imageRetained) {
          kept.push(path);
          continue;
        }
      }
      if (now - (await stat(path)).mtimeMs > days * 86400000) {
        await unlink(path);
        removed.push(path);
      }
    }
  }
  for (const root of roots) await visit(root);
  return { removed, kept };
}
