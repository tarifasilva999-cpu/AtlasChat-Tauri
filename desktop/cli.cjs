#!/usr/bin/env node
'use strict';

const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { randomUUID } = require('node:crypto');
const { version } = require('../package.json');
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

const stdoutTTY = Boolean(process.stdout.isTTY);
const stderrTTY = Boolean(process.stderr.isTTY);
const colorAllowed = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
const color = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  blue: '\x1b[94m',
  green: '\x1b[32m',
  gray: '\x1b[90m'
};

function paint(style, value, stream = 'stdout') {
  const text = String(value);
  const enabled = colorAllowed && (stream === 'stderr' ? stderrTTY : stdoutTTY);
  return enabled ? `${color[style] || ''}${text}${color.reset}` : text;
}

function terminalSafe(value) {
  return String(value ?? '')
    .replace(/\x1b/g, '\\x1b')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, character => character === '\t' ? '  ' : '');
}

function modelChoice(value) {
  const choice = MODEL_ALIASES[String(value || '').trim().toLowerCase()];
  if (!choice || !MODELS[choice]) throw new Error(`Unknown model “${value}”. Run atlas --help to see choices.`);
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
    } else throw new Error(`Unknown option “${arg}”. Run atlas --help for usage.`);
  }
  return options;
}

function dataDirectory() {
  const override = process.env.ATLAS_USER_DATA_DIR;
  if (override?.trim()) return path.resolve(override.trim());

  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ai.atlas.chat.tauri');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'ai.atlas.chat.tauri');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'ai.atlas.chat.tauri');
}

function formatSize(bytes) {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function modelRows() {
  return Object.entries(MODELS).map(([key, model]) => {
    const aliases = key === 'apex-ultra' ? 'atlas' : key === 'ultra-code' ? 'code' : 'mini';
    const size = model.files.reduce((total, file) => total + file.size, 0);
    return `  ${aliases.padEnd(8)} ${model.label.padEnd(22)} ${formatSize(size)}`;
  }).join('\n');
}

function printHelp() {
  process.stdout.write(`AtlasChat CLI  v${version}\n\n` +
    `Usage: atlas [options]\n\n` +
    `Options:\n` +
    `  -m, --model <name>  Start with a local model (default: mini)\n` +
    `  -y, --yes           Skip the model preparation confirmation\n` +
    `  -h, --help          Show this help\n\n` +
    `Models:\n${modelRows()}\n\n` +
    `Chat commands: /model [name], /clear, /help, /exit\n` +
    `Set ATLAS_USER_DATA_DIR to choose the local data directory.\n`);
}

function crop(value, max) {
  const text = String(value);
  if (text.length <= max) return text;
  return max <= 1 ? '…' : `…${text.slice(-(max - 1))}`;
}

function printWelcome(choice) {
  const columns = stdoutTTY ? (process.stdout.columns || 96) : 84;
  const inner = Math.max(28, Math.min(68, columns - 8));
  const model = MODELS[choice];
  const size = formatSize(model.files.reduce((total, file) => total + file.size, 0));
  const cwd = crop(process.cwd(), inner - 4);
  const line = `╭${'─'.repeat(inner + 2)}╮`;
  const row = (left, right = '', style = 'gray') => {
    const leftText = crop(left, inner - right.length - 1);
    const gap = inner - leftText.length - right.length;
    process.stdout.write(`│ ${paint(style, leftText)}${' '.repeat(gap)}${right ? paint('gray', right) : ''} │\n`);
  };
  process.stdout.write(`${paint('gray', line)}\n`);
  row('AtlasChat  ·  local CLI', `v${version}`, 'bold');
  row(model.label, `local  ·  ${size}`, 'cyan');
  row(`cwd  ${cwd}`);
  process.stdout.write(`${paint('gray', `╰${'─'.repeat(inner + 2)}╯`)}\n`);
  process.stdout.write(`\n${paint('dim', 'Local chat · paste context whenever you want Atlas to see it.')}`);
  process.stdout.write(`\n${paint('dim', 'Type a message or /help for commands.')}\n`);
}

function writeAssistantText(value, lineState) {
  const text = terminalSafe(value);
  let output = '';
  for (const character of text) {
    if (lineState.start) {
      output += '  ';
      lineState.start = false;
    }
    output += character;
    if (character === '\n') lineState.start = true;
  }
  if (output) process.stdout.write(output);
}

async function main() {
  if (typeof fetch !== 'function') throw new Error('AtlasChat CLI needs Node.js 20 or newer.');
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  if (!process.stdin.isTTY) throw new Error('Run Atlas in an interactive terminal.');

  let choice = options.choice;
  let activeId = null;
  let activeKind = null;
  let closed = false;
  let lastProgress = '';
  let progressOnLine = false;
  const history = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const inference = new NativeInference({
    directory: path.join(dataDirectory(), 'native-ai'),
    emit(event) {
      if (event.type === 'phase') {
        const message = terminalSafe(event.detail || 'Preparing the local model…');
        const percent = event.total > 0 && event.loaded >= 0
          ? Math.max(0, Math.min(100, Math.floor(event.loaded / event.total * 100)))
          : null;
        const stage = event.phase || message;
        const step = percent === null ? '' : Math.floor(percent / 10) * 10;
        const key = `${stage}:${step}`;
        if (key === lastProgress) return;
        lastProgress = key;
        if (stderrTTY) {
          const bar = percent === null ? '' : ` ${paint('gray', `[${'━'.repeat(Math.floor(percent / 10))}${'─'.repeat(10 - Math.floor(percent / 10))}] ${percent}%`, 'stderr')}`;
          process.stderr.write(`\r\x1b[2K  ${paint('cyan', '◌', 'stderr')} ${message}${bar}`);
          progressOnLine = true;
        } else {
          process.stderr.write(`  ${message}${percent === null ? '' : ` ${percent}%`}\n`);
        }
      } else if (event.type === 'chunk' && event.id === activeId) {
        const delta = String(event.chunk?.choices?.[0]?.delta?.content || '');
        writeAssistantText(delta, assistantLine);
      } else if (event.type === 'reply-phase' && event.id === activeId && activeKind === 'reply') {
        if (progressOnLine) { process.stderr.write('\r\x1b[2K'); progressOnLine = false; }
        process.stderr.write(`  ${paint('dim', terminalSafe(event.detail || 'Thinking…'), 'stderr')}\n`);
      }
    }
  });

  const confirmPreparation = async model => {
    if (options.yes) return true;
    const size = formatSize(model.files.reduce((total, file) => total + file.size, 0));
    let answer;
    try {
      answer = await rl.question(`\nPrepare ${model.label}? First use may download ${size} of model files plus the local runner. [Y/n] `);
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
    lastProgress = '';
    const id = `cli-load:${randomUUID()}`;
    activeId = id;
    activeKind = 'load';
    try {
      await inference.load({ id, choice, contextWindow: 8192 });
      activeId = null;
      activeKind = null;
      if (progressOnLine) { process.stderr.write('\r\x1b[2K'); progressOnLine = false; }
      process.stderr.write(`  ${paint('green', '✓', 'stderr')} ${model.label} is ready on this computer.\n`);
      return true;
    } catch (error) {
      activeId = null;
      activeKind = null;
      if (progressOnLine) { process.stderr.write('\r\x1b[2K'); progressOnLine = false; }
      if (error?.code === 'STOPPED') {
        process.stderr.write('Model preparation stopped.\n');
        return false;
      }
      throw error;
    }
  };

  let assistantLine = { start: true };
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
    printWelcome(choice);
    if (!await loadModel(choice)) return;

    while (!closed) {
      let input;
      try { input = await rl.question(`\n${paint('cyan', '›')} `); }
      catch { break; }
      const line = input.trim();
      if (!line) continue;

      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        process.stdout.write('\n  /model [name]  switch local models\n  /clear         clear this conversation\n  /exit          close Atlas\n');
        continue;
      }
      if (line === '/clear') {
        history.length = 0;
        process.stdout.write(`\n${paint('dim', 'Conversation cleared.')}`);
        continue;
      }
      if (line === '/model' || line.startsWith('/model ')) {
        const requested = line.slice('/model'.length).trim();
        if (!requested) {
          process.stdout.write(`\nCurrent model: ${MODELS[choice].label}\nAvailable models:\n${modelRows()}\n`);
          continue;
        }
        try {
          const nextChoice = modelChoice(requested);
          if (nextChoice === choice) process.stdout.write(`\n${MODELS[choice].label} is already selected.\n`);
          else if (await loadModel(nextChoice)) process.stdout.write(`Switched to ${MODELS[choice].label}.\n`);
        } catch (error) { process.stderr.write(`${terminalSafe(error.message)}\n`); }
        continue;
      }

      if (!inference.ready && !await loadModel(choice)) continue;
      history.push({ role: 'user', content: line });
      const id = `cli-chat:${randomUUID()}`;
      activeId = id;
      activeKind = 'reply';
      assistantLine = { start: true };
      process.stdout.write(`\n${paint('blue', 'Atlas')}\n`);
      try {
        const result = await inference.complete({ id, lease: inference.ready?.lease, kind: 'chat',
          max_tokens: 1024, temperature: 0.7, messages: history });
        if (result.stopped) {
          history.pop();
          process.stdout.write(`\n${paint('dim', '[stopped]')}\n`);
        } else {
          history.push({ role: 'assistant', content: result.text });
          process.stdout.write('\n');
        }
      } catch (error) {
        history.pop();
        process.stderr.write(`\n${terminalSafe(error.message || error)}\n`);
      } finally {
        activeId = null;
        activeKind = null;
      }
    }
  } finally {
    closed = true;
    rl.close();
    await inference.unload().catch(() => {});
    if (progressOnLine) process.stderr.write('\r\x1b[2K');
    process.stderr.write(`${paint('dim', 'AtlasChat closed.', 'stderr')}\n`);
  }
}

main().catch(error => {
  process.stderr.write(`${paint('blue', 'Atlas', 'stderr')}: ${terminalSafe(error.message || error)}\n`);
  process.exitCode = 1;
});
