/**
 * Electron Main Process
 * Launches the Express server and opens a BrowserWindow.
 *
 * This file is CommonJS (.cjs) because Electron's main process does not
 * support ESM "type": "module" packages out of the box. It dynamically
 * imports the ESM server module via import().
 */

// Save Node.js native fetch BEFORE Electron overrides it with net.fetch.
// Electron's main process replaces globalThis.fetch with Chromium-based net.fetch,
// which can break streaming (response.body.getReader()) used by our proxy code.
const _nativeFetch = globalThis.fetch;
const _nativeHeaders = globalThis.Headers;
const _nativeRequest = globalThis.Request;
const _nativeResponse = globalThis.Response;

const { app, BrowserWindow, Tray, Menu, shell, dialog } = require('electron');
const path = require('path');
const net = require('net');

const DEFAULT_PORT = 8081;

// Keep references so they aren't garbage-collected
let mainWindow = null;
let tray = null;
let serverInstance = null;
let actualPort = DEFAULT_PORT;

// ─── Port helpers ───────────────────────────────────────────────────────────

function isPortAvailable(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => { srv.close(); resolve(true); });
        srv.listen(port, '127.0.0.1');
    });
}

async function findAvailablePort(start, attempts = 20) {
    for (let i = 0; i < attempts; i++) {
        if (await isPortAvailable(start + i)) return start + i;
    }
    throw new Error(`No available port found (tried ${start}–${start + attempts - 1})`);
}

// ─── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 900,
        minHeight: 600,
        title: 'CliGate',
        icon: getIconPath(),
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    mainWindow.loadURL(`http://127.0.0.1:${actualPort}`);

    // Open external links in system browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('close', (e) => {
        // Minimise to tray instead of quitting
        if (tray && !app.isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Tray ───────────────────────────────────────────────────────────────────

function createTray() {
    const iconPath = getIconPath();
    if (!iconPath) return;

    try {
        tray = new Tray(iconPath);
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Open CliGate', click: () => { if (mainWindow) mainWindow.show(); } },
            { type: 'separator' },
            { label: `Port: ${actualPort}`, enabled: false },
            { type: 'separator' },
            {
                label: 'Quit', click: () => {
                    app.isQuitting = true;
                    app.quit();
                }
            },
        ]);
        tray.setToolTip('CliGate');
        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
    } catch {
        // Tray icon is optional — silently ignore if it fails
    }
}

function getIconPath() {
    // Try common icon locations
    const candidates = [
        path.join(__dirname, 'build', 'icon.ico'),
        path.join(__dirname, 'build', 'icon.png'),
        path.join(__dirname, 'public', 'favicon.ico'),
        path.join(__dirname, 'images', 'icon.png'),
    ];
    const fs = require('fs');
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    try {
        // Find an available port
        const preferred = Number(process.env.PORT) || DEFAULT_PORT;
        actualPort = await findAvailablePort(preferred);

        // Restore Node.js native fetch — Electron's net.fetch can break
        // ReadableStream/getReader() used by our streaming proxy code.
        if (_nativeFetch) {
            globalThis.fetch = _nativeFetch;
            globalThis.Headers = _nativeHeaders;
            globalThis.Request = _nativeRequest;
            globalThis.Response = _nativeResponse;
        }

        // Dynamically import the ESM server module
        const { createServer } = await import('./src/server.js');
        const expressApp = createServer({ port: actualPort });

        serverInstance = expressApp.listen(actualPort, '127.0.0.1', () => {
            console.log(`CliGate running on http://127.0.0.1:${actualPort}`);
            console.log(`fetch implementation: ${globalThis.fetch?.name || 'unknown'}`);
        });

        createWindow();
        createTray();
    } catch (err) {
        dialog.showErrorBox('Startup Error', `Failed to start CliGate:\n\n${err.message}`);
        app.quit();
    }
});

// macOS: re-create window when dock icon is clicked
app.on('activate', () => {
    if (mainWindow === null) createWindow();
    else mainWindow.show();
});

app.on('before-quit', () => {
    app.isQuitting = true;
    if (serverInstance) {
        try { serverInstance.close(); } catch { /* ignore */ }
    }
});

// Quit when all windows are closed (except macOS)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.isQuitting = true;
        app.quit();
    }
});
