'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { dependencyPlan, fingerprint, LIMITS } = require('./core.cjs');
const { bytes, audit } = require('./project-audit.cjs');
const IMAGES = { python: 'python:3.12.9-slim-bookworm', web: 'node:22.14.0-bookworm-slim' };

class Runner {
  constructor(store, approve, publish) {
    this.store = store; this.approve = approve; this.publish = publish;
    this.jobs = new Map(); this.approvals = new Map(); this.counter = 0; this.docker = 'docker'; this.cleanupJobs = new Set();
  }
  async locate() {
    const candidates = process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker/Docker/resources/bin/docker.exe')]
      : ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'];
    for (const candidate of candidates) {
      try { await fs.access(candidate); this.docker = candidate; return; } catch {}
    }
  }
  exec(args, job, timeout = 90000) {
    if (job.cancelled) return Promise.reject(new Error('Run stopped.'));
    return new Promise(resolve => {
      let output = '', timedOut = false, settled = false;
      const child = spawn(this.docker, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      job.child = child;
      const append = data => { output = (output + data.toString()).slice(-LIMITS.output); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      const timer = setTimeout(() => {
        timedOut = true;
        if (job.container) this.removeContainer(job.container);
        child.kill();
      }, timeout);
      const finish = (code, error) => {
        if (settled) return; settled = true; clearTimeout(timer); job.child = null;
        resolve({ exitCode: code ?? -1, output: error ? error.message : output, timedOut, cancelled: job.cancelled });
      };
      child.on('error', e => finish(-1, e)); child.on('close', code => finish(code));
    });
  }
  removeContainer(name) {
    const cleanup = new Promise(resolve => {
      const child = spawn(this.docker, ['rm', '-f', name], { shell: false, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      const done = () => { clearTimeout(timer); resolve(); };
      child.once('error', done); child.once('close', done);
    });
    this.cleanupJobs.add(cleanup); void cleanup.finally(() => this.cleanupJobs.delete(cleanup)); return cleanup;
  }
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    if (job.container) this.removeContainer(job.container);
    job.child?.kill();
  }
  async image(runtime, job) {
    const configFile = path.join(this.store.root, 'images.json');
    let pinned = {};
    try { pinned = JSON.parse(await fs.readFile(configFile, 'utf8')); } catch {}
    if (/^sha256:[a-f0-9]{64}$/.test(pinned[runtime] || '')) {
      const present = await this.exec(['image', 'inspect', pinned[runtime], '--format', '{{.Id}}'], job, 15000);
      if (present.exitCode === 0) return pinned[runtime];
    }
    await this.publish(job.id, 'Setup', 'Coding tools need a one-time download: ' + IMAGES[runtime]);
    if (!await this.approve('Download coding tools', 'Download ' + IMAGES[runtime] + ' for this project? Atlas will pin the downloaded image by its immutable ID.', 'Download')) {
      throw new Error('Coding tools download declined. Files are available without a run.');
    }
    const pull = await this.exec(['pull', IMAGES[runtime]], job, 300000);
    if (pull.exitCode || pull.cancelled) throw new Error('Coding tools could not be downloaded. ' + pull.output);
    const inspected = await this.exec(['image', 'inspect', IMAGES[runtime], '--format', '{{.Id}}'], job, 15000);
    const id = inspected.output.trim();
    if (inspected.exitCode || !/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Could not pin the coding runtime.');
    pinned[runtime] = id; await fs.writeFile(configFile, JSON.stringify(pinned)); return id;
  }
  async command(job, image, work, args, network = false) {
    if (job.cancelled) throw new Error('Run stopped.');
    const name = 'atlas-' + job.id + '-' + (++this.counter);
    job.container = name;
    const uid = typeof process.getuid === 'function' ? process.getuid() || 65534 : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() || 65534 : 1000;
    const result = await this.exec([
      'run', '--rm', '--pull=never', '--name', name, '--network', network ? 'bridge' : 'none',
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=128', '--memory=2g', '--memory-swap=2g', '--cpus=2',
      '--user', uid + ':' + gid, '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
      '--volume', work + ':/workspace:rw',
      '--workdir', '/workspace', '--env', 'HOME=/tmp', '--env', 'CI=true',
      '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'PIP_INDEX_URL=https://pypi.org/simple',
      image, ...args
    ], job, network ? 300000 : 90000);
    job.container = null;
    // Covers CLI crashes and timeouts where --rm did not get a chance to run.
    if (result.timedOut || result.cancelled || result.exitCode === -1) this.removeContainer(name);
    await this.publish(job.id, 'Command', args.join(' ') + '\nExit: ' + result.exitCode +
      (result.timedOut ? ' (time limit)' : '') + '\n' + result.output);
    if (job.cancelled) throw new Error('Run stopped.');
    return { command: args.join(' '), executed: true, ...result };
  }
  async check(id) {
    if (this.jobs.size) throw new Error('Another project check is running.');
    const job = { id, cancelled: false, child: null, container: null };
    this.jobs.set(id, job);
    const result = { passed: false, executed: false, checks: [], reason: '' };
    try {
      const run = await this.store.read(id); const source = await this.store.source(id);
      if (!source.length) throw new Error('There are no completed files to run.');
      result.sourceHash = fingerprint(source);
      const staticResult = audit(source, run, this.store.index(id, source));
      result.audit = staticResult;
      result.checks.push({ command: 'Static audit', executed: true, exitCode: staticResult.passed ? 0 : 1,
        output: JSON.stringify({ errors: staticResult.errors.slice(0, 12), totalErrors: staticResult.totalErrors }) });
      if (!staticResult.passed) { result.executed = true; result.reason = 'Static audit failed.'; return result; }
      if (!IMAGES[run.runtime]) { result.reason = 'No execution adapter for ' + run.runtime + '. Files are preserved.'; return result; }
      if(run.runtime==='web'&&/\.html?$/.test(run.entrypoint)&&!source.some(f=>f.path==='package.json')){
        await this.prepareWork(id,source);result.needsPreview=true;
        result.verifiedCommands=['Static audit'];return result;
      }
      await this.locate();
      const info = await this.exec(['info', '--format', '{{.OSType}}'], job, 15000);
      if (info.exitCode || info.output.trim() !== 'linux') throw new Error('Start Docker with Linux containers to run this project. You can still download its files.');
      const image = await this.image(run.runtime, job);
      if (job.cancelled) throw new Error('Run stopped.');
      const work = await this.prepareWork(id,source);
      const deps = dependencyPlan(source, run.runtime);
      if (deps) {
        if (run.runtime === 'web') {
          // Ignore generated registry overrides and resolved package URLs.
          for (const name of ['.npmrc', 'npm-shrinkwrap.json', 'package-lock.json']) {
            await fs.rm(path.join(work, name), { force: true });
          }
        }
        const key = id + ':' + fingerprint(deps.packages);
        if (!this.approvals.has(key)) {
          await this.publish(id, 'Approval', 'Waiting to download packages: ' + deps.packages.join(', '));
          const accepted = await this.approve('Install project packages', deps.packages.join('\n') +
            '\n\nPackages run inside the project container. Network access is enabled during installation only.', 'Install');
          if (!accepted) throw new Error('Package installation declined. The project has not been run.');
          this.approvals.set(key, true);
        }
        for (const command of deps.commands) {
          const install = await this.command(job, image, work, command, true);
          result.checks.push(install);result.executed=true;
          if (install.exitCode !== 0) { result.reason = 'Package installation failed.'; return result; }
        }
      }
      const python = deps && run.runtime === 'python' ? '.venv/bin/python' : 'python';
      let commands;
      if (run.runtime === 'python') {
        commands = [[python, '-m', 'compileall', '-q', '-x', '(node_modules|\\.venv)', '.'],
          [python, '-m', 'unittest', 'discover', '-s', '.', '-p', 'test*.py']];
        if (source.some(f => f.path === run.entrypoint) && /\.py$/.test(run.entrypoint)) commands.push([python, run.entrypoint]);
      } else {
        commands = source.filter(f => /\.(?:js|mjs|cjs)$/.test(f.path)).map(f => ['node', '--check', f.path]);
        const pkgFile = source.find(f => f.path === 'package.json');
        if (pkgFile) {
          const pkg = JSON.parse(pkgFile.content);
          for (const action of ['typecheck', 'build', 'test']) {
            if (typeof pkg.scripts?.[action] === 'string') commands.push(['npm', 'run', action, '--if-present']);
          }
        }
        if (/\.(mjs|cjs|js)$/.test(run.entrypoint) && source.some(f => f.path === run.entrypoint)) commands.push(['node', run.entrypoint]);
      }
      for (const command of commands) {
        const check = await this.command(job, image, work, command);
        result.checks.push(check); result.executed = true;
        if (check.exitCode !== 0) { result.reason = 'A project check failed.'; return result; }
      }
      for (const argv of Object.values(run.commandOverrides || {})) {
        const args = argv[0] === 'python' ? [python,...argv.slice(1)] : argv;
        const check=await this.command(job,image,work,args);result.checks.push(check);result.executed=true;
        if(check.exitCode!==0){result.reason='A configured project command failed.';return result;}
      }
      result.passed = commands.length > 0 || Object.keys(run.commandOverrides || {}).length > 0;
      result.needsPreview = run.runtime === 'web' && /\.html?$/.test(run.entrypoint);
      if (!result.passed && !result.needsPreview) result.reason = 'No runnable checks were found. Code is unverified.';
      // Compilation or a successful entrypoint alone cannot prove requested behavior.
      if (!result.needsPreview) {
        result.behaviorVerified = result.checks.some(c => c.exitCode === 0 &&
          (/unittest/.test(c.command) ? /Ran [1-9]\d* tests?/.test(c.output) : /npm run test/.test(c.command) && /(?:[1-9]\d*.*(?:pass|tests?)|(?:pass|tests?).*[1-9]\d*)/i.test(c.output)));
        result.passed = result.passed && result.behaviorVerified;
        if (!result.behaviorVerified) result.reason = 'Execution completed, but no passing behavior tests were observed.';
      }
      result.verifiedCommands = result.checks.filter(c => c.exitCode === 0).map(c => c.command);
      return result;
    } catch (error) {
      result.reason = String(error.message); result.cancelled = job.cancelled;
      return result;
    } finally {
      this.jobs.delete(id);
      const run = await this.store.read(id);
      run.lastCheck = result; await this.store.put(run);
    }
  }
  async prepareWork(id,source) {
    const work=path.join(this.store.dir(id),'work');
    await fs.rm(work,{recursive:true,force:true});await fs.mkdir(work,{recursive:true});
    const run=await this.store.read(id);for(const directory of run.directories||[])await fs.mkdir(path.join(work,directory),{recursive:true});
    for(const file of source){const target=path.join(work,file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes(file));}
    return work;
  }
  async cleanupWork(id) {
    const root=path.resolve(this.store.dir(id)),work=path.resolve(root,'work');
    if(path.dirname(work)!==root)throw new Error('Invalid temporary project path.');
    await fs.rm(work,{recursive:true,force:true});
  }
}
module.exports = { Runner, IMAGES };
