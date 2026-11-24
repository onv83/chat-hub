const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hub', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  configPath: () => ipcRenderer.invoke('config:path'),
  reportTelemostConnection: (payload) => ipcRenderer.invoke('diagnostics:telemost-connection', payload),
  getVersion: () => ipcRenderer.invoke('app:version'),
  setThemeSource: (src) => ipcRenderer.invoke('theme:set-source', src),
  isWinFocused: () => ipcRenderer.invoke('win:focused'),
  // санированный снимок памяти сервисов; аргументы не принимаются
  getServiceMemoryMetrics: () => ipcRenderer.invoke('service-memory:metrics'),
  // MCP-экспорт: пути и список чатов не передаются — main собирает manifest сам
  mcpChooseDir: () => ipcRenderer.invoke('mcp:choose-dir'),
  mcpConnectorStatus: (service) => ipcRenderer.invoke('mcp:connector-status', service),
  mcpConnectorInstall: (service) => ipcRenderer.invoke('mcp:connector-install', service),
  mcpConnectorConnect: (service) => ipcRenderer.invoke('mcp:connector-connect', service),
  mcpProbe: (service) => ipcRenderer.invoke('mcp:probe', service),
  mcpExport: () => ipcRenderer.invoke('mcp:export'),
  mcpCancel: () => ipcRenderer.invoke('mcp:cancel'),
  // «Избранное» → Markdown: только локальный список, аргументы не принимаются
  favoritesExport: () => ipcRenderer.invoke('favorites:export'),
  onMcpProgress: (cb) => {
    const handler = (_event, payload) => cb(payload)
    ipcRenderer.on('mcp:progress', handler)
    return () => ipcRenderer.removeListener('mcp:progress', handler)
  }
})
