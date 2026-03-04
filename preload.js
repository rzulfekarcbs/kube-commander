const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kubeCommander', {
  getCommands: () => ipcRenderer.invoke('get-commands'),
  authenticate: () => ipcRenderer.invoke('authenticate'),
  runCommand: (commandId, dryRun) => ipcRenderer.invoke('run-command', commandId, dryRun),
  onOutput: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('command-output', handler);
    return () => ipcRenderer.removeListener('command-output', handler);
  },
});
