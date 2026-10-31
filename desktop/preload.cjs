'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (name, value) => ipcRenderer.invoke('atlas:' + name, value);
// No generic IPC, filesystem, process, or shell capability is exposed.
contextBridge.exposeInMainWorld('atlasDesktop', {
  info: () => call('info'), create: value => call('create', value),
  inferenceInfo: () => call('inferenceInfo'),
  inferenceLoad: value => call('inferenceLoad', value),
  inferenceComplete: value => call('inferenceComplete', value),
  inferenceCancel: value => call('inferenceCancel', value),
  inferenceUnload: value => call('inferenceUnload', value),
  onInference: listener => {
    if (typeof listener !== 'function') throw new TypeError('Expected an inference listener.');
    const receive = (_event, value) => listener(value);
    ipcRenderer.on('atlas:inference-event', receive);
    return () => ipcRenderer.removeListener('atlas:inference-event', receive);
  },
  read: id => call('read', id), source: id => call('source', id),
  save: value => call('save', value), event: value => call('event', value),
  model: value => call('model', value), check: id => call('check', id),
  cancel: id => call('cancel', id), finish: value => call('finish', value),
  exportProject: id => call('exportProject', id), preview: id => call('preview', id),
  exportBackup: value => call('exportBackup', value),
  importBackup: () => call('importBackup'), research: value => call('research', value),
  chooseCoder: value => call('chooseCoder', value),
  windowAction: action => call('windowAction', action),
  projects: () => call('projects'), deleteProject: id => call('deleteProject', id), projectCommand: value => call('projectCommand', value),
  importProject: () => call('importProject')
});
