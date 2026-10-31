'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
async function walk(dir, prefix = '', hash = false) {
  let out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const relative = prefix + entry.name, target = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(target, relative + '/', hash));
    else { const stat = await fs.stat(target); out.push({ path: relative, size: stat.size, mtimeMs: stat.mtimeMs,
      ...(hash ? { sha256: crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex') } : {}) }); }
  }
  return out.sort((a,b) => a.path.localeCompare(b.path));
}
async function main() {
  const original = path.resolve(root, '../Atlas'), legacy = path.join(process.env.APPDATA, 'atlas-desktop');
  const value = { original, legacy, source: await walk(original, '', true), profile: await walk(legacy), at: new Date().toISOString() };
  const output = path.join(root, 'migration-data'); await fs.mkdir(output, { recursive: true });
  if (process.argv.includes('--verify')) {
    const before = JSON.parse(await fs.readFile(path.join(output, 'original-inventory.json')));
    const same = name => JSON.stringify(before[name]) === JSON.stringify(value[name]);
    if (!same('source') || !same('profile')) throw new Error('Original source/profile inventory changed. Investigate before proceeding.');
    console.log('Original source hashes and profile sizes/modification times unchanged.');
  } else await fs.writeFile(path.join(output, 'original-inventory.json'), JSON.stringify(value, null, 2), { flag: 'wx' });
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
