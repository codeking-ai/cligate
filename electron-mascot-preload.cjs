/**
 * Preload for the desktop-mascot window. Exposes a minimal, safe bridge
 * (contextIsolation:true) so the mascot page can drive the window without
 * Node integration.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cligateMascot', {
  openChat: () => ipcRenderer.send('mascot:open-chat'),
  setMouseIgnore: (ignore) => ipcRenderer.send('mascot:set-ignore-mouse', !!ignore),
  moveBy: (dx, dy) => ipcRenderer.send('mascot:move-by', { dx: Number(dx) || 0, dy: Number(dy) || 0 }),
  hide: () => ipcRenderer.send('mascot:hide'),
  showMenu: () => ipcRenderer.send('mascot:menu')
});
