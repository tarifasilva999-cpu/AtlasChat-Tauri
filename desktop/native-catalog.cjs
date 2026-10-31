'use strict';

// Official llama.cpp binaries and official Qwen weights. Pin both revisions and
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
    label: 'Apex 7.3', tier: 'apex', minimumGB: 8,
    repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF', revision: 'bb5d59e06d9551d752d08b292a50eb208b07ab1f',
    files: [
      file('qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf', 3993201344, 'dfce12e3862a5283ccfb88221b48480e58745165de856439950d0f22590580db'),
      file('qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf', 689872288, '539cf93f78e887edea1c04e2d7d8cdaca9d01dae9c9025bcb8accbe29df3d72a')
    ]
  },
  'ultra-code': {
    label: 'Apex 7.3 UltraCode', tier: 'ultra-code', minimumGB: 8,
    repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', revision: '13fb94bfda8c8cf22497dc57b78f391a9acb426a',
    files: [file('qwen2.5-coder-7b-instruct-q4_k_m.gguf', 4683073536, '509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c')]
  },
  forge: {
    label: 'Forge 2.1', tier: 'mobile', minimumGB: 3,
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', revision: '91cad51170dc346986eccefdc2dd33a9da36ead9',
    files: [file('qwen2.5-1.5b-instruct-q4_k_m.gguf', 1117320736, '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e')]
  },
  firefly: {
    label: 'Firefly 4.5', tier: 'mobile', minimumGB: 2,
    repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', revision: '9217f5db79a29953eb74d5343926648285ec7e67',
    files: [file('qwen2.5-0.5b-instruct-q4_k_m.gguf', 491400032, '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db')]
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
