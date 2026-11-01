'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMITS = { files: 32, fileBytes: 65536, totalBytes: 262144, events: 120, output: 16000 };
const ID = /^[a-f0-9-]{36}$/;
function runId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid project ID.');
  return id;
}
function projectPath(value) {
  if (typeof value !== 'string' || value.length > 180 || /[\x00-\x1f\x7f\\:<>?"|*]/.test(value)) throw new Error('Invalid project path.');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) ||
    /^(node_modules|\.venv|\.git)$/i.test(p))) throw new Error('Use a relative source path without reserved folders.');
  return parts.join('/');
}
function files(value, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > LIMITS.files || (!allowEmpty && !value.length)) throw new Error('A project needs 1–32 source files.');
  const names = new Set(); let bytes = 0;
  const result = value.map(file => {
    const name = projectPath(file.path);
    if (names.has(name.toLowerCase())) throw new Error('Duplicate project path: ' + name);
    names.add(name.toLowerCase());
    if (typeof file.content !== 'string') throw new Error('File content must be text.');
    const size = Buffer.byteLength(file.content);
    if (size > LIMITS.fileBytes) throw new Error('A generated file exceeds 64 KB.');
    bytes += size;
    return { path: name, content: file.content };
  });
  if (bytes > LIMITS.totalBytes) throw new Error('Generated source exceeds 256 KB. Split the project.');
  return result;
}
function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function manifest(value) {
  if (!value || !['python', 'web'].includes(value.runtime)) throw new Error('Choose a Python or web project.');
  return {
    title: String(value.title || 'Atlas project').slice(0, 100),
    runtime: value.runtime,
    entrypoint: projectPath(value.entrypoint || (value.runtime === 'python' ? 'main.py' : 'index.html'))
  };
}
function dependencyPlan(source, runtime) {
  if (runtime === 'python') {
    const requirements = source.find(f => f.path === 'requirements.txt');
    if (!requirements?.content.trim()) return null;
    const packages = requirements.content.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
    if (packages.some(x => !/^[a-z0-9][a-z0-9_.-]*(?:\[[a-z0-9_,.-]+\])?(?:\s*(?:==|>=|<=|~=|!=|>|<)\s*[a-z0-9.*+!_-]+(?:\s*,\s*(?:==|>=|<=|~=|!=|>|<)\s*[a-z0-9.*+!_-]+)*)?$/i.test(x))) {
      throw new Error('Dependency requests must use named PyPI packages and version constraints.');
    }
    return { packages, commands: [
      ['python', '-m', 'venv', '.venv'],
      ['.venv/bin/python', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', 'requirements.txt']
    ] };
  }
  const packageFile = source.find(f => f.path === 'package.json');
  if (!packageFile) return null;
  const pkg = JSON.parse(packageFile.content);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const packages = Object.entries(deps).map(([name, version]) => {
    if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) ||
        typeof version !== 'string' || !/^[0-9a-z*~^<>=| .+-]+$/i.test(version) || version.length > 80) {
      throw new Error('Dependency requests must use named npm registry packages.');
    }
    return name + '@' + version;
  });
  if (!packages.length) return null;
  return { packages, commands: [['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--package-lock=false', '--registry=https://registry.npmjs.org']] };
}
class Store {
  constructor(root) { this.root = root; }
  dir(id) { return path.join(this.root, runId(id)); }
  async init() { await fs.mkdir(this.root, { recursive: true }); }
  async create(value) {
    const run = { version: 1, id: crypto.randomUUID(), ...manifest(value), status: 'working',
      actualModel: '', created: Date.now(), files: [], events: [], lastCheck: null };
    await fs.mkdir(this.dir(run.id), { recursive: true });
    await this.put(run); return run;
  }
  async put(run) {
    const target = path.join(this.dir(run.id), 'run.json');
    await fs.writeFile(target + '.tmp', JSON.stringify(run));
    await fs.rename(target + '.tmp', target);
  }
  async read(id) { return JSON.parse(await fs.readFile(path.join(this.dir(id), 'run.json'), 'utf8')); }
  async save(id, value) {
    const run = await this.read(id);
    const source = files(value, true);
    // Authoritative files are stored as data and are never mounted in a container.
    const sourcePath = path.join(this.dir(id), 'source.json');
    await fs.writeFile(sourcePath + '.tmp', JSON.stringify(source));
    await fs.rename(sourcePath + '.tmp', sourcePath);
    run.files = source.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content) }));
    run.sourceHash = fingerprint(source); run.lastCheck = null;
    await this.put(run); return run;
  }
  async source(id) {
    try { return files(JSON.parse(await fs.readFile(path.join(this.dir(id), 'source.json'), 'utf8')), true); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async event(id, event) {
    const run = await this.read(id);
    run.events.push({ at: Date.now(), stage: String(event.stage).slice(0, 40),
      text: String(event.text || '').slice(0, LIMITS.output),
      sources: Array.isArray(event.sources) ? event.sources.slice(0, 5).filter(s => /^https:\/\//.test(s.url)).map(s => ({
        title: String(s.title).slice(0, 180), url: String(s.url).slice(0, 2048)
      })) : [] });
    run.events = run.events.slice(-LIMITS.events);
    await this.put(run); return run;
  }
  async ids() { return (await fs.readdir(this.root)).filter(id => ID.test(id)); }
  async recover() {
    for (const id of await this.ids()) {
      const run = await this.read(id);
      if (run.status === 'working') { run.status = 'interrupted'; await this.put(run); }
    }
  }
}
module.exports = { Store, files, projectPath, runId, manifest, dependencyPlan, fingerprint, LIMITS };
