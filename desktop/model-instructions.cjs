'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const PROFILE_ROOT = path.resolve(__dirname, '..', 'model-instructions');
const PROFILES = Object.freeze({
  'apex-ultra': Object.freeze({ id: 'atlas-7.5', file: 'atlas-7.5.md' }),
  'ultra-code': Object.freeze({ id: 'atlas-7.5-code', file: 'atlas-7.5-code.md' }),
  forge: Object.freeze({ id: 'atlas-7.5-mini', file: 'atlas-7.5-mini.md' }),
  firefly: Object.freeze({ id: 'atlas-7.5-mini', file: 'atlas-7.5-mini.md' })
});

function profileForChoice(choice) {
  const profile = PROFILES[choice];
  if (!profile) throw new Error(`No persistent model instructions are configured for “${choice}”.`);
  return profile;
}

function markerForChoice(choice) {
  return `ATLAS_MODEL_PROFILE:${profileForChoice(choice).id}:v1`;
}

async function loadModelInstructions(choice, { root = PROFILE_ROOT } = {}) {
  const profile = profileForChoice(choice);
  const file = path.resolve(root, profile.file);
  if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid model instruction profile path.');
  let content;
  try { content = await fs.readFile(file, 'utf8'); }
  catch (error) { throw new Error(`Atlas could not load the ${profile.id} instruction profile: ${error.message}`); }
  content = content.trim();
  if (!content || Buffer.byteLength(content) > 24000) throw new Error(`The ${profile.id} instruction profile is empty or too large.`);
  const marker = markerForChoice(choice);
  return { id: profile.id, marker, content, prompt: `${marker}\n\n${content}` };
}

function withModelInstructions(messages, choice, profile) {
  const marker = profile?.marker || markerForChoice(choice);
  const systems = messages.filter(message => message.role === 'system').map(message => message.content);
  if (!systems.some(content => content.includes(marker))) systems.unshift(profile?.prompt || marker);
  return [{ role: 'system', content: systems.join('\n\n') }, ...messages.filter(message => message.role !== 'system')];
}

module.exports = { PROFILES, PROFILE_ROOT, profileForChoice, markerForChoice, loadModelInstructions, withModelInstructions };
