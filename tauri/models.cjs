'use strict';
const { NativeInference, messagesFor, readSSE } = require('../desktop/native-inference.cjs');
const { RELEASE, runtimeFor } = require('../desktop/native-catalog.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const crypto = require('node:crypto');
const instances = new Set(), checks = new Map();
async function verified(root, relative, size, sha256, signal) {
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(path.resolve(root) + path.sep)) return null;
  let target = root;
  try {
    for (const part of relative.split(path.sep)) { target = path.join(target, part); if ((await fs.lstat(target)).isSymbolicLink()) return null; }
    const stat = await fs.stat(candidate); if (!stat.isFile() || stat.size !== size) return null;
    const key = candidate + ':' + stat.mtimeMs + ':' + sha256;
    if (!checks.has(key)) checks.set(key, (async () => {
      const hash = crypto.createHash('sha256');
      for await (const chunk of createReadStream(candidate, { signal })) hash.update(chunk);
      return hash.digest('hex') === sha256;
    })().catch(e => { checks.delete(key); throw e; }));
    return await checks.get(key) ? candidate : null;
  } catch (e) { if (signal.aborted) throw signal.reason; return null; }
}
class ReusedInference extends NativeInference {
  constructor(options) { super(options); instances.add(this); }
  async modelFiles(choice, model, signal) {
    const legacy = process.env.ATLAS_LEGACY_MODELS;
    if (legacy) {
      this.notify('checking-model', 'Checking your existing local model…');
      const files = [];
      for (const file of model.files) files.push(await verified(legacy, path.join('models', choice, model.revision, file.name), file.size, file.sha256, signal));
      if (files.every(Boolean)) return files[0];
    }
    return super.modelFiles(choice, model, signal);
  }
  async runtime(cpu, signal) {
    // Reuse only a verified original archive. Extract into the NEW runtime cache;
    // a legacy ready.json alone cannot establish executable integrity.
    const legacy = process.env.ATLAS_LEGACY_MODELS, record = runtimeFor(this.platform, this.arch, cpu);
    if (legacy) {
      const archive = await verified(legacy, path.join('downloads', record.name), record.size, record.sha256, signal);
      if (archive) {
        const destination = path.join(this.directory, 'downloads', record.name);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        try { await fs.copyFile(archive, destination, require('node:fs').constants.COPYFILE_EXCL); } catch(e) { if(e.code !== 'EEXIST') throw e; }
      }
    }
    return super.runtime(cpu, signal);
  }
}
module.exports = { NativeInference: ReusedInference, messagesFor, readSSE, verified,
  unloadAll: () => Promise.all([...instances].map(r => r.unload().catch(()=>{}))) };
