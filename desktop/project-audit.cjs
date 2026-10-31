'use strict';
const path = require('node:path').posix;
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { fingerprint } = require('./core.cjs');
const bytes = file => Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
const text = file => file.encoding === 'base64' ? '' : file.content;
function resolveReference(from, ref, names) {
  if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(ref)) return { external: true };
  let clean;
  try { clean = decodeURIComponent(ref.split(/[?#]/)[0]); } catch { return { missing: ref }; }
  if (!clean) return { external: true };
  const target = path.normalize(clean.startsWith('/') ? clean.slice(1) : path.join(path.dirname(from), clean));
  const found = [target, ...['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '/index.js', '/index.ts'].map(e => target + e)].find(n => names.has(n));
  return found ? { path: found } : { missing: target };
}
function indexFile(file, names) {
  const source = text(file), refs = [], symbols = [], exports = [];
  const add = (ref, kind, imported = []) => refs.push({ ref, kind, imported, ...resolveReference(file.path, ref, names) });
  if (/\.html?$/i.test(file.path)) {
    for (const m of source.matchAll(/<(script|link|img|source|video|audio)\b[^>]*?\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) add(m[2], 'asset');
  }
  if (/\.(?:[cm]?js|jsx|tsx?|css|html?)$/i.test(file.path)) {
    for (const m of source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) if (!m[1].includes('${')) add(m[1], 'asset');
  }
  if (/\.(?:[cm]?js|jsx|tsx?)$/i.test(file.path)) {
    for (const m of source.matchAll(/\b(?:import|export)\s+([^;\n]*?)\s+from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)) {
      const ref = m[2] || m[3] || m[4];
      const imported = m[1]?.match(/\{([^}]+)\}/)?.[1]?.split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean) || [];
      if(m[0].startsWith('import')&&m[1]&&/^\s*[A-Za-z_$][\w$]*(?:\s*,|\s*$)/.test(m[1]))imported.push('default');
      if (ref.startsWith('.') || ref.startsWith('/')) add(ref, 'import', imported);
      else if (!/^(?:https?:|node:)/.test(ref)) refs.push({ ref, kind: 'package', package: ref.startsWith('@') ? ref.split('/').slice(0, 2).join('/') : ref.split('/')[0] });
    }
    for (const m of source.matchAll(/\b(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) symbols.push(m[1]);
    for (const m of source.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) exports.push(m[1]);
    if (/\bexport\s+default\b/.test(source)) exports.push('default');
    for (const m of source.matchAll(/\bexport\s*\{([^}]+)\}/g)) for (const name of m[1].split(',')) exports.push(name.trim().split(/\s+as\s+/).at(-1));
  } else for (const m of source.matchAll(/\b(?:def|class|func)\s+(\w+)/g)) symbols.push(m[1]);
  return { hash: fingerprint(file), bytes: bytes(file).length, symbols: [...new Set(symbols)].slice(0, 200), exports: [...new Set(exports)], refs };
}
function syntaxError(source, filename, module = false) {
  if (!module) {
    try { new vm.Script(source, { filename }); return null; } catch (e) { return String(e.message); }
  }
  // Parser only: stdin is checked, never executed. Works in Node and Electron.
  const result = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: source, encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 5000, maxBuffer: 8192 });
  return result.status === 0 ? null : (result.error?.message || result.stderr || 'Module parser unavailable').slice(0, 1000);
}
function audit(source, manifest, index) {
  const errors = [], names = new Set(source.map(f => f.path));
  const add = (file, code, message) => errors.push({ file, code, message: message.slice(0, 1000) });
  if (!names.has(manifest.entrypoint)) add(manifest.entrypoint, 'ENTRY_MISSING', 'Entrypoint does not exist.');
  let packages = {};
  for (const file of source) {
    if (/\.json$/i.test(file.path)) try {
      const value = JSON.parse(text(file));
      if (file.path === 'package.json') packages = { ...value.dependencies, ...value.devDependencies };
    } catch (e) { add(file.path, 'CONFIG_INVALID', e.message); }
  }
  for (const file of source) {
    const content = text(file), data = bytes(file), info = index[file.path];
    for (const ref of info.refs) {
      if (ref.missing) add(file.path, 'REFERENCE_MISSING', 'Missing ' + ref.kind + ': ' + ref.missing);
      if (ref.kind === 'package' && !packages[ref.package] && !require('node:module').builtinModules.includes(ref.package)) add(file.path, 'DEPENDENCY_MISSING', 'Undeclared package: ' + ref.package);
      if (ref.path && ref.kind === 'import' && /\.[cm]?js$/.test(ref.path)) {
        const target = source.find(f => f.path === ref.path);
        if (!/\bmodule\.exports\b|\bexports\./.test(text(target)) && !/export\s*\*/.test(text(target))) for (const name of ref.imported) {
          if (!index[ref.path]?.exports.includes(name)) add(file.path, 'EXPORT_MISSING', ref.path + ' does not export ' + name);
        }
      }
    }
    let valid = true;
    if (/\.png$/i.test(file.path)) valid = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.length >= 33 && data.toString('ascii', 12, 16) === 'IHDR';
    if (/\.jpe?g$/i.test(file.path)) valid = data.length > 4 && data[0] === 255 && data[1] === 216 && data.at(-2) === 255 && data.at(-1) === 217;
    if (/\.gif$/i.test(file.path)) valid = /^GIF8[79]a/.test(data.toString('ascii', 0, 6));
    if (/\.webp$/i.test(file.path)) valid = data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
    if (/\.svg$/i.test(file.path)) valid = /<svg\b[^>]*>/i.test(data.toString('utf8'));
    if (!valid) add(file.path, 'ASSET_INVALID', 'File bytes do not match the declared image format.');
    if (/\.[cm]?js$/i.test(file.path)) {
      const module = /\.mjs$/.test(file.path) || /^\s*(?:import\s|export\s)/m.test(content);
      if(!info.syntaxChecked){info.syntaxError=syntaxError(content,file.path,module);info.syntaxChecked=true;}
      const error = info.syntaxError;
      if (error) add(file.path, 'SYNTAX_INVALID', error);
    }
    if (/\.html?$/i.test(file.path)) for (const match of content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const scriptType=match[1].match(/\btype\s*=\s*["']([^"']+)/i)?.[1];
      if (/\bsrc\s*=/.test(match[1]) || scriptType&&!/^(?:module|text\/javascript|application\/javascript)$/i.test(scriptType)) continue;
      const error = syntaxError(match[2], file.path + ':inline', /type\s*=\s*["']module/i.test(match[1]));
      if (error) add(file.path, 'SYNTAX_INVALID', error);
    }
    // Dynamic asset layouts cannot be resolved statically: force real runtime coverage.
    if (/url\([^)]*\$\{/.test(content) && /cards\//.test(content) && !source.some(f => f.path.startsWith('cards/'))) add(file.path, 'ASSET_LAYOUT_MISSING', 'Dynamic cards/ asset layout has no matching files.');
  }
  return { passed: errors.length === 0, errors, totalErrors: errors.length, sourceHash: fingerprint(source), coverage: 'Paths, literal imports/exports, JSON, JS syntax, image headers; runtime and behavior require execution.' };
}
module.exports = { bytes, text, indexFile, resolveReference, syntaxError, audit };
