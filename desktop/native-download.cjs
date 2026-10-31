'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

async function digest(file, signal) {
  const hash = crypto.createHash('sha256');
  const stream = createReadStream(file, { signal });
  try { for await (const chunk of stream) hash.update(chunk); }
  finally {
    // On Windows an 'end' event can precede handle closure. Renaming the verified
    // download must wait for 'close', including when hashing is interrupted.
    if (!stream.closed) await new Promise(resolve => { stream.once('close', resolve); stream.destroy(); });
  }
  return hash.digest('hex');
}
const sizeOf = file => fs.stat(file).then(s => s.size).catch(() => 0);
async function downloadVerified({ url, destination, size, sha256, signal, progress = () => {}, fetchImpl = fetch }) {
  signal.throwIfAborted();
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const receipt = destination + '.verified.json';
  const saved = await fs.readFile(receipt, 'utf8').then(JSON.parse).catch(() => null);
  const stat = await fs.stat(destination).catch(() => null);
  if (stat?.size === size && saved?.sha256 === sha256 && saved?.mtimeMs === stat.mtimeMs) {
    progress(size, size); return destination;
  }
  if (stat?.size === size && await digest(destination, signal) === sha256) {
    await fs.writeFile(receipt, JSON.stringify({ sha256, mtimeMs: stat.mtimeMs }));
    progress(size, size); return destination;
  }
  if (stat) await fs.rm(destination, { force: true });
  const partial = destination + '.part';
  let offset = await sizeOf(partial);
  if (offset > size) { await fs.unlink(partial); offset = 0; }
  let controller, timer;
  const idle = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('The download stopped responding. Check your connection and try again; saved progress will resume.')), 90000); };
  try {
    if (offset < size) {
      controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal]);
      idle();
      const response = await fetchImpl(url, { signal: combined, headers: offset ? { Range: `bytes=${offset}-` } : {} });
      if (!response.ok || !response.body) throw new Error(`The model download could not start (HTTP ${response.status}).`);
      if (offset && response.status === 206) {
        if (!String(response.headers.get('content-range') || '').startsWith(`bytes ${offset}-`)) throw new Error('The download server returned an invalid resume range.');
      } else if (response.status === 200) offset = 0;
      else if (response.status !== 206 || offset) throw new Error('The download server returned an unexpected response.');
      const handle = await fs.open(partial, offset ? 'a' : 'w');
      progress(offset, size);
      try {
        for await (const chunk of response.body) {
          combined.throwIfAborted(); idle();
          if (offset + chunk.byteLength > size) throw new Error('The download exceeded its expected size.');
          const buffer = Buffer.from(chunk);
          let written = 0;
          while (written < buffer.length) written += (await handle.write(buffer, written, buffer.length - written)).bytesWritten;
          offset += written; progress(offset, size);
        }
      } finally { await handle.close(); }
    }
    clearTimeout(timer); signal.throwIfAborted();
    if (offset !== size) throw new Error('The download was incomplete. Sending again will resume it.');
    progress(size, size, 'verifying');
    if (await digest(partial, signal) !== sha256) {
      await fs.unlink(partial);
      throw new Error('The downloaded file failed its integrity check. Try again to download a fresh copy.');
    }
    signal.throwIfAborted();
    // Never replace a usable model with an incomplete download.
    await fs.rm(destination, { force: true });
    await fs.rename(partial, destination);
    const finished = await fs.stat(destination);
    await fs.writeFile(receipt, JSON.stringify({ sha256, mtimeMs: finished.mtimeMs }));
    return destination;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (controller?.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally { clearTimeout(timer); controller?.abort(); }
}
function archivePath(root, name) {
  if (!name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || /^[a-z]:/i.test(name) || name.split('/').includes('..')) throw new Error('The runtime archive contains an unsafe path.');
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('The runtime archive escaped its download folder.');
  return target;
}
async function unpackRuntime(archive, directory) {
  const root = path.resolve(directory);
  await fs.mkdir(root, { recursive: true });
  let entries = [];
  if (archive.endsWith('.zip')) {
    const { unzipSync } = require('fflate');
    let declared = 0;
    const unpacked = unzipSync(await fs.readFile(archive), { filter: entry => {
      archivePath(root, entry.name);
      declared += entry.originalSize;
      if (declared > 256 * 1024 ** 2) throw new Error('The runtime archive is too large.');
      return true;
    } });
    entries = Object.entries(unpacked).map(([name, bytes]) => ({ name, bytes, type: name.endsWith('/') ? '5' : '0' }));
  } else {
    const tar = zlib.gunzipSync(await fs.readFile(archive), { maxOutputLength: 256 * 1024 ** 2 });
    let longName = '', pax = {};
    const str = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
    for (let cursor = 0; cursor + 512 <= tar.length;) {
      const header = tar.subarray(cursor, cursor + 512);
      if (header.every(value => value === 0)) break;
      const count = parseInt(str(header.subarray(124, 136)).trim() || '0', 8);
      if (!Number.isSafeInteger(count) || count < 0 || cursor + 512 + count > tar.length) throw new Error('The runtime archive is incomplete.');
      const bytes = tar.subarray(cursor + 512, cursor + 512 + count);
      const type = String.fromCharCode(header[156] || 48);
      const prefix = str(header.subarray(345, 500));
      let name = (prefix ? prefix + '/' : '') + str(header.subarray(0, 100));
      cursor += 512 + Math.ceil(count / 512) * 512;
      if (type === 'L') { longName = str(bytes); continue; }
      if (type === 'x' || type === 'g') {
        for (const line of bytes.toString().split('\n')) {
          const match = line.match(/^\d+ ([^=]+)=(.*)$/);
          if (match) pax[match[1]] = match[2];
        }
        continue;
      }
      name = pax.path || longName || name;
      entries.push({ name, bytes, type, link: pax.linkpath || str(header.subarray(157, 257)) });
      longName = ''; pax = {};
    }
  }
  for (const entry of entries) {
    const destination = archivePath(root, entry.name);
    if (entry.type === '5') { await fs.mkdir(destination, { recursive: true }); continue; }
    if (!['0', '2', '1'].includes(entry.type)) throw new Error('The runtime archive contains an unsupported entry.');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (entry.type === '0') await fs.writeFile(destination, entry.bytes, { mode: 0o755 });
    else {
      const linkTarget = entry.type === '1' ? archivePath(root, entry.link) : path.resolve(path.dirname(destination), entry.link);
      if (!linkTarget.startsWith(root + path.sep)) throw new Error('A runtime library link escaped its download folder.');
      await fs.symlink(path.relative(path.dirname(destination), linkTarget), destination);
    }
  }
  const server = entries.find(entry => ['0'].includes(entry.type) && /^llama-server(?:\.exe)?$/.test(path.basename(entry.name)));
  if (!server) throw new Error('The native download did not contain the Atlas model runner.');
  return archivePath(root, server.name);
}
module.exports = { downloadVerified, archivePath, unpackRuntime };
