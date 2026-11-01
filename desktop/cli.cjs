#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { randomUUID } = require('node:crypto');
const { NativeInference } = require('./native-inference.cjs');
const { MODELS } = require('./native-catalog.cjs');

const MODEL_ALIASES = {
  atlas: 'apex-ultra',
  'atlas-7.5': 'apex-ultra',
  apex: 'apex-ultra',
  'apex-ultra': 'apex-ultra',
  code: 'ultra-code',
  ultracode: 'ultra-code',
  'ultra-code': 'ultra-code',
  mini: 'forge',
  'atlas-7.5-mini': 'forge',
  'atlas-7.5-code': 'ultra-code',
  forge: 'forge',
  firefly: 'forge'
};

function modelChoice(value) {
  const choice = MODEL_ALIASES[String(value || '').trim().toLowerCase()];
  if (!choice || !MODELS[choice]) throw new Error(`Unknown model “${value}”. Run npm run chat -- --help to see choices.`);
  return choice;
}

function parseArgs(args) {
  const options = { choice: 'forge', yes: false, help: false };
  const values = [...args];
  if (values[0] === 'chat') values.shift();
  while (values.length) {
    const arg = values.shift();
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--model' || arg === '-m') {
      const value = values.shift();
      if (!value) throw new Error(`Missing model after ${arg}.`);
      options.choice = modelChoice(value);
    } else throw new Error(`Unknown option “${arg}”. Run npm run chat -- --help for usage.`);
  }
  return options;
}

function dataDirectory() {
  const override = process.env.ATLAS_USER_DATA_DIR;
  if (override?.trim()) return path.resolve(override.trim());

  const home = os.homedir();
  let roots;
  if (process.platform === 'win32') roots = [process.env.APPDATA || path.join(home, 'AppData', 'Roaming')];
  else if (process.platform === 'darwin') roots = [path.join(home, 'Library', 'Application Support')];
  else roots = [process.env.XDG_CONFIG_HOME || path.join(home, '.config')];

  // Electron may use the package name during development or the product name
  // after packaging. Reuse whichever Atlas data directory already has models.
  const candidates = roots.flatMap(root => ['Atlas', 'atlas-desktop'].map(name => path.join(root, name)));
  const cached = candidates.find(candidate => fs.existsSync(path.join(candidate, 'native-ai')));
  return cached || candidates[candidates.length - 1];
}

function formatSize(bytes) {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function modelRows() {
  return Object.entries(MODELS).map(([key, model]) => {
    const aliases = key === 'apex-ultra' ? 'atlas' : key === 'ultra-code' ? 'code' : 'mini';
    const size = model.files.reduce((total, file) => total + file.size, 0);
    return `  ${aliases.padEnd(12)} ${model.label}  (${formatSize(size)})`;
  }).join('\n');
}

function printHelp() {
  process.stdout.write(`AtlasChat CLI\n\n` +
    `Usage:\n` +
    `  npm run chat [-- --model <name>] [--yes]\n` +
    `  node desktop/cli.cjs [--model <name>] [--yes]\n\n` +
    `Options:\n` +
    `  -m, --model <name>  Choose the local model (default: mini)\n` +
    `  -y, --yes           Skip the model preparation confirmation\n` +
    `  -h, --help          Show this help\n\n` +
    `Models:\n${modelRows()}\n\n` +
    `Chat commands: /model [name], /clear, /help, /exit\n` +
    `Set ATLAS_USER_DATA_DIR to use a specific Atlas data directory.\n`);
}

async function main() {
  if (typeof fetch !== 'function') throw new Error('AtlasChat CLI needs Node.js 20 or newer.');
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  if (!process.stdin.isTTY) throw new Error('Run AtlasChat in an interactive terminal. Use --yes to skip the model confirmation.');

  let choice = options.choice;
  let activeId = null;
  let activeKind = null;
  let closed = false;
  let lastStatus = '';
  let progressOnLine = false;
  const history = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const inference = new NativeInference({
    directory: path.join(dataDirectory(), 'native-ai'),
    emit(event) {
      if (event.type === 'phase') {
        let message = event.detail || 'Preparing the local model…';
        if (event.total > 0 && event.loaded >= 0 && event.loaded < event.total) {
          message += ` ${Math.floor(event.loaded / event.total * 100)}%`;
        }
        if (message !== lastStatus || event.total > 0) {
          lastStatus = message;
          progressOnLine = Boolean(process.stderr.isTTY);
          process.stderr.write(process.stderr.isTTY ? `\r\x1b[2K${message}` : `${message}\n`);
        }
      } else if (event.type === 'chunk' && event.id === activeId) {
        const delta = String(event.chunk?.choices?.[0]?.delta?.content || '');
        if (delta) process.stdout.write(delta);
      } else if (event.type === 'reply-phase' && event.id === activeId && activeKind === 'reply') {
        process.stderr.write(`${progressOnLine ? '\n' : ''}${event.detail || 'Generating…'}\n`);
        progressOnLine = false;
      }
    }
  });

  const confirmPreparation = async model => {
    if (options.yes) return true;
    const size = formatSize(model.files.reduce((total, file) => total + file.size, 0));
    let answer;
    try {
      answer = await rl.question(`Prepare ${model.label}? First use may download up to ${size} of model files plus the local runner. [Y/n] `);
    } catch (error) {
      if (closed) return false;
      throw error;
    }
    return !/^n(?:o)?$/i.test(answer.trim());
  };

  const loadModel = async nextChoice => {
    const model = MODELS[nextChoice];
    if (inference.ready?.choice === nextChoice) { choice = nextChoice; return true; }
    if (!await confirmPreparation(model)) return false;
    if (inference.ready || inference.server || inference.loading) await inference.unload();
    choice = nextChoice;
    const id = `cli-load:${randomUUID()}`;
    activeId = id;
    activeKind = 'load';
    try {
      await inference.load({ id, choice, contextWindow: 8192 });
      activeId = null;
      activeKind = null;
      if (progressOnLine) { process.stderr.write('\n'); progressOnLine = false; }
      process.stderr.write(`${model.label} is ready on this computer.\n`);
      return true;
    } catch (error) {
      activeId = null;
      activeKind = null;
      if (error?.code === 'STOPPED') {
        if (progressOnLine) { process.stderr.write('\n'); progressOnLine = false; }
        process.stderr.write('Model preparation stopped.\n');
        return false;
      }
      throw error;
    }
  };

  rl.on('SIGINT', () => {
    if (activeId) {
      process.stderr.write(`\nStopping ${activeKind === 'load' ? 'model preparation' : 'the reply'}…\n`);
      inference.cancel({ id: activeId });
    } else {
      closed = true;
      rl.close();
    }
  });

  try {
    process.stdout.write(`AtlasChat CLI · ${MODELS[choice].label}\nType a message, or /help for commands.\n`);
    if (!await loadModel(choice)) return;

    while (!closed) {
      let input;
      try { input = await rl.question('\nYou › '); }
      catch { break; }
      const line = input.trim();
      if (!line) continue;

      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        process.stdout.write('/model [name]  switch local models\n/clear         clear this conversation\n/exit          close AtlasChat\n');
        continue;
      }
      if (line === '/clear') {
        history.length = 0;
        process.stdout.write('Conversation cleared.\n');
        continue;
      }
      if (line === '/model' || line.startsWith('/model ')) {
        const requested = line.slice('/model'.length).trim();
        if (!requested) {
          process.stdout.write(`Current model: ${MODELS[choice].label}\nAvailable models:\n${modelRows()}\n`);
          continue;
        }
        try {
          const nextChoice = modelChoice(requested);
          if (nextChoice === choice) process.stdout.write(`${MODELS[choice].label} is already selected.\n`);
          else if (await loadModel(nextChoice)) process.stdout.write(`Switched to ${MODELS[choice].label}.\n`);
        } catch (error) { process.stderr.write(`${error.message}\n`); }
        continue;
      }

      if (!inference.ready && !await loadModel(choice)) continue;
      history.push({ role: 'user', content: line });
      const id = `cli-chat:${randomUUID()}`;
      activeId = id;
      activeKind = 'reply';
      process.stdout.write('\nAtlas › ');
      try {
        const result = await inference.complete({ id, lease: inference.ready?.lease, kind: 'chat',
          max_tokens: 1024, temperature: 0.7, messages: history });
        if (result.stopped) {
          history.pop();
          process.stdout.write('\n[stopped]\n');
        } else {
          history.push({ role: 'assistant', content: result.text });
          process.stdout.write('\n');
        }
      } catch (error) {
        history.pop();
        process.stderr.write(`\n${error.message || error}\n`);
      } finally {
        activeId = null;
        activeKind = null;
      }
    }
  } finally {
    closed = true;
    rl.close();
    await inference.unload().catch(() => {});
    process.stderr.write('AtlasChat closed.\n');
  }
}

main().catch(error => {
  process.stderr.write(`AtlasChat: ${error.message || error}\n`);
  process.exitCode = 1;
});
