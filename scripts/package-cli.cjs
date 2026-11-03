'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'atlas-cli-win-x64');
const output = path.join(dist, 'atlas-cli-win-x64.zip');
const safeDist = path.join(root, 'dist') + path.sep;
if (!stage.startsWith(safeDist) || !output.startsWith(safeDist)) throw new Error('Unsafe CLI package output path.');

async function main() {
  const node = path.join(root, 'src-tauri', 'resources', 'node', 'node.exe');
  const fflate = path.join(root, 'node_modules', 'fflate');
  await fs.access(node);
  await fs.access(fflate);
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(path.join(stage, 'desktop'), { recursive: true });
  await fs.mkdir(path.join(stage, 'node'), { recursive: true });
  await fs.mkdir(path.join(stage, 'node_modules'), { recursive: true });

  for (const name of ['cli.cjs', 'native-inference.cjs', 'native-download.cjs', 'native-catalog.cjs', 'model-instructions.cjs']) {
    await fs.copyFile(path.join(root, 'desktop', name), path.join(stage, 'desktop', name));
  }
  await fs.cp(path.join(root, 'model-instructions'), path.join(stage, 'model-instructions'), { recursive: true });
  await fs.cp(fflate, path.join(stage, 'node_modules', 'fflate'), { recursive: true });
  await fs.copyFile(node, path.join(stage, 'node', 'node.exe'));
  const nodeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
  if (await fs.stat(nodeLicense).then(value => value.isFile()).catch(() => false)) {
    await fs.copyFile(nodeLicense, path.join(stage, 'node', 'LICENSE'));
  }

  const appVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'atlaschat-cli', version: appVersion, private: true }, null, 2) + '\n');
  await fs.writeFile(path.join(stage, 'version.json'), JSON.stringify({ version: appVersion, platform: 'win32-x64' }, null, 2) + '\n');
  await fs.writeFile(path.join(stage, 'README.txt'), 'AtlasChat CLI for Windows x64\n\nInstall with the PowerShell command in desktop/README.md. Then open any terminal and type atlas.\n');

  await fs.rm(output, { force: true });
  const script = '$source = Join-Path $env:ATLAS_CLI_STAGE "*"; Compress-Archive -Path $source -DestinationPath $env:ATLAS_CLI_OUTPUT -CompressionLevel Optimal -Force';
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit',
    env: { ...process.env, ATLAS_CLI_STAGE: stage, ATLAS_CLI_OUTPUT: output }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not create the Windows CLI archive (PowerShell exit ${result.status}).`);
  process.stdout.write(`Packaged Atlas CLI ${appVersion}: ${path.relative(root, output)}\n`);
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
