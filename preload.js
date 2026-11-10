const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hub', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  configPath: () => ipcRenderer.invoke('config:path'),
  // доверенный ввод в webview мессенджера (нужен webk Telegram)
  trustedClick: (wcId, x, y) => ipcRenderer.invoke('input:click', { wcId, x, y }),
  trustedText: (wcId, text) => ipcRenderer.invoke('input:text', { wcId, text }),
  trustedKey: (wcId, key, keyCode, modifiers) => ipcRenderer.invoke('input:key', { wcId, key, keyCode, modifiers }),
  trustedWheel: (wcId, x, y, deltaY) => ipcRenderer.invoke('input:wheel', { wcId, x, y, deltaY })
})
