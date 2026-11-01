'use strict';

// Pin llama.cpp binaries and model revisions and
// SHA-256 digests so an upstream update cannot silently change an installation.
const RELEASE = 'b11429';
const RUNTIMES = {
  'win32-x64-vulkan': ['win-vulkan-x64.zip', 33337769, '1bfe78ad9168b79fa02bf67f6af9f5e17a966d824d77238517f7bef12ac73b36'],
  'win32-x64-cpu': ['win-cpu-x64.zip', 19398918, '1283323272b04cd07905816a597a0da810918102de958f4ff6f7bbaa70ed2efe'],
  'win32-arm64-vulkan': ['win-vulkan-arm64.zip', 25880280, '739747b9912d19525977b0346a02087037eec487fea7b58c2826324407e588ce'],
  'win32-arm64-cpu': ['win-cpu-arm64.zip', 12229035, 'ee0f631a9e58b146ff50714099d9cb498906af3143a773b580093a9214a8d1e5'],
  'darwin-arm64-metal': ['macos-arm64.tar.gz', 11971406, '740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459'],
  'darwin-x64-metal': ['macos-x64.tar.gz', 11487431, '29ac3ea02be6bd143e824973f2cc5fa74bc4094393a9eaab0ff6814f19dd8522'],
  'linux-x64-vulkan': ['ubuntu-vulkan-x64.tar.gz', 31636673, '632c4e98feba2b94407a2130e3133e0c3aefb0ea1ab41337e926d8bfafdd0b74'],
  'linux-x64-cpu': ['ubuntu-x64.tar.gz', 17693462, 'f6d25dde8f51133143d1453da4fd5f73b145127177612a283bf7995957af3392'],
  'linux-arm64-vulkan': ['ubuntu-vulkan-arm64.tar.gz', 24845090, '702d99c4219b4314cc6d3b10fb41ae96cbfc68226305c2681269dfb51487af34'],
  'linux-arm64-cpu': ['ubuntu-arm64.tar.gz', 13682895, 'ed44c0f79c3d02424f62bdc87e106318b0b89f49050e2e80c5f352723d14e00b']
};
const file = (name, size, sha256) => ({ name, size, sha256 });
const MODELS = {
  'apex-ultra': {
    label: 'Atlas 7.5', tier: 'apex', minimumGB: 8,
    repo: 'unsloth/Qwen3.5-4B-GGUF', revision: 'e87f176479d0855a907a41277aca2f8ee7a09523',
    files: [file('Qwen3.5-4B-Q4_K_M.gguf', 2740937888, '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4')]
  },
  'ultra-code': {
    label: 'Atlas 7.5 Code', tier: 'ultra-code', minimumGB: 12,
    repo: 'yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF', revision: '190a31365a6b80a692349be34ccdac730cad4fe4',
    files: [file('gemma4-v2-Q4_K_M.gguf', 7381381664, '0b9506cab36f7f818e34f9c0f5a3d6568d0b37100f3a3e1092e2eec3c4c96791')]
  },
  forge: {
    label: 'Atlas 7.5 Mini', tier: 'mobile', minimumGB: 4,
    repo: 'openbmb/MiniCPM5-2B-GGUF', revision: '2079a22f3beaa4e306449978533478fe0522f4b3',
    files: [file('MiniCPM5-2B-Q4_K_M.gguf', 1561318368, 'ec2d5801640099e97d8d7e8003ad4d81f336e757811f03a26173dddf386602fd')]
  }
};
function runtimeFor(platform, arch, cpu = false) {
  const backend = platform === 'darwin' ? 'metal' : cpu ? 'cpu' : 'vulkan';
  const key = `${platform}-${arch}-${backend}`, record = RUNTIMES[key];
  if (!record) throw new Error('Native Atlas is not available for this operating system and processor yet.');
  const [suffix, size, sha256] = record;
  const name = `llama-${RELEASE}-bin-${suffix}`;
  return { key, backend: cpu ? 'cpu' : backend, name, size, sha256,
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE}/${name}` };
}
function modelFor(choice) {
  if (choice === 'firefly') choice = 'forge'; // Older saved preferences and CLI invocations.
  if (!Object.hasOwn(MODELS, choice)) throw new Error('Select an available Atlas model.');
  const model = MODELS[choice];
  if (!model) throw new Error('Select an available Atlas model.');
  return model;
}
function contextFor(requested, totalBytes) {
  const gb = totalBytes / 1024 ** 3;
  const ceiling = gb >= 24 ? 32768 : gb >= 12 ? 16384 : 8192;
  return Math.max(4096, Math.min(ceiling, Math.floor(Number(requested) || 8192), 32768));
}
module.exports = { RELEASE, MODELS, runtimeFor, modelFor, contextFor };
