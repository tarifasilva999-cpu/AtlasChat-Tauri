const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function setup(desktop = true) {
  const elements = new Map(), listeners = new Map();
  const get = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { hidden: false, disabled: false, textContent: '',
        classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) },
        setAttribute() {}, removeAttribute() {}, addEventListener() {}, click() { return this.onclick?.(); }
      });
    }
    return elements.get(id);
  };
  const window = { atlasDesktop: desktop, addEventListener: (name, fn) => listeners.set(name, fn) };
  vm.runInNewContext(readFileSync(__dirname + '/atlas-updates.js', 'utf8'), {
    window, document: { getElementById: get }, console: { error() {} }, location: { reload() {} }
  });
  return { window, get, announce: update => listeners.get('atlas:tauri-update-available')({ detail: { update } }) };
}

test('dismissed native update can be reopened without losing the installer', async () => {
  const ui = setup(); let installs = 0;
  ui.announce({ version: '0.1.2', downloadAndInstall: async () => { installs++; } });
  ui.get('updateLater').click();
  assert.equal(ui.get('updateBanner').classList.contains('show'), false);
  await ui.get('settingsCheckUpdates').click();
  assert.equal(ui.get('updateBanner').classList.contains('show'), true);
  await ui.get('updateNow').click();
  assert.equal(installs, 1);
});

test('active work prevents installation and a failed download can be retried', async () => {
  const ui = setup(); let busy = true, calls = 0;
  ui.window.AtlasUpdates.configure({ beforeInstall: () => !busy });
  ui.announce({ version: '0.1.2', downloadAndInstall: async () => { if (++calls === 1) throw Error('offline'); } });
  await ui.get('updateNow').click(); assert.equal(calls, 0);
  busy = false;
  await ui.get('updateNow').click();
  assert.equal(ui.get('updateNow').disabled, false);
  assert.equal(ui.get('updateNow').textContent, 'Try again');
  await ui.get('updateNow').click(); assert.equal(calls, 2);
});

test('download progress is bounded and repeated clicks cannot install twice', async () => {
  const ui = setup(); let finish, calls = 0;
  ui.announce({ version: '0.1.2', downloadAndInstall: async onProgress => {
    calls++; onProgress({ event: 'Started', data: { contentLength: 100 } });
    onProgress({ event: 'Progress', data: { chunkLength: 200 } });
    await new Promise(resolve => { finish = resolve; });
  } });
  const installing = ui.get('updateNow').click();
  await ui.get('updateNow').click();
  assert.equal(calls, 1); assert.equal(ui.get('updateProgress').value, 100);
  finish(); await installing;
});

test('web update activates the waiting service worker and manual native check reports offline', async () => {
  const web = setup(false); let activated = false;
  web.window.AtlasUpdates.showWeb({ waiting: { postMessage: msg => { activated = msg.type === 'SKIP_WAITING'; } } });
  await web.get('updateNow').click(); assert.equal(activated, true);
  const native = setup(); native.window.atlasTauriUpdater = { checkForUpdates: async () => { throw Error('offline'); } };
  await native.get('settingsCheckUpdates').click();
  assert.match(native.get('settingsUpdateStatus').textContent, /Couldn’t check/);
  assert.equal(native.get('settingsCheckUpdates').disabled, false);
});
