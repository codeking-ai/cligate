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

const { app, BrowserWindow, Tray, Menu, shell, dialog, ipcMain, screen } = require('electron');
const path = require('path');
const net = require('net');

const DEFAULT_PORT = 8081;

// Keep references so they aren't garbage-collected
let mainWindow = null;
let tray = null;
let serverInstance = null;
let actualPort = DEFAULT_PORT;

// Desktop mascot (optional, controlled by /api/mascot/config)
let mascotWindow = null;
let mascotConfig = { enabled: true, position: null };
let mascotIpcReady = false;
let mascotPositionTimer = null;

// ─── Version helpers ────────────────────────────────────────────────────────

/**
 * Returns true if `latest` is strictly newer than `current` (semver).
 */
function isNewerVersion(current, latest) {
    const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
    const [cMaj, cMin, cPat] = parse(current);
    const [lMaj, lMin, lPat] = parse(latest);
    if (lMaj !== cMaj) return lMaj > cMaj;
    if (lMin !== cMin) return lMin > cMin;
    return lPat > cPat;
}

/**
 * Check GitHub Releases for a newer version.
 * Shows a blocking dialog if an update is required.
 * Silently returns on network errors (offline-friendly).
 */
async function checkForUpdate() {
    const currentVersion = app.getVersion();

    let data;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await _nativeFetch(
            'https://api.github.com/repos/codeking-ai/cligate/releases/latest',
            {
                headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'CliGate' },
                signal: controller.signal,
            }
        );
        clearTimeout(timeout);
        if (!res.ok) return;
        data = await res.json();
    } catch {
        return; // network error, timeout, offline → skip
    }

    const latestVersion = data.tag_name;
    if (!latestVersion) return;

    if (!isNewerVersion(currentVersion, latestVersion)) return;

    const releaseUrl = data.html_url
        || 'https://github.com/codeking-ai/cligate/releases/latest';

    const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Update Required',
        message: `A new version of CliGate is available (${latestVersion}).`,
        detail: `You are running v${currentVersion}. Please download the latest version to continue.`,
        buttons: ['Download Update', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
    });

    if (response === 0) {
        shell.openExternal(releaseUrl);
    }
    app.quit();
    throw new Error('UPDATE_REQUIRED');
}

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

function buildTrayMenu() {
    return Menu.buildFromTemplate([
        { label: 'Open CliGate', click: () => { if (mainWindow) mainWindow.show(); } },
        {
            label: 'Show desktop assistant',
            type: 'checkbox',
            checked: mascotConfig.enabled !== false && !!mascotWindow,
            click: (item) => {
                if (item.checked) {
                    setMascotEnabled(true);
                    createMascotWindow();
                } else {
                    setMascotEnabled(false);
                    if (mascotWindow) mascotWindow.close();
                }
                refreshTrayMenu();
            }
        },
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
}

function refreshTrayMenu() {
    if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
    const iconPath = getIconPath();
    if (!iconPath) return;

    try {
        tray = new Tray(iconPath);
        tray.setToolTip('CliGate');
        tray.setContextMenu(buildTrayMenu());
        tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
    } catch {
        // Tray icon is optional — silently ignore if it fails
    }
}

function getIconPath() {
    // Try common icon locations
    const candidates = [
        path.join(__dirname, 'public', 'icon-dark.ico'),
        path.join(__dirname, 'public', 'icon-dark.png'),
        path.join(__dirname, 'public', 'favicon-dark.ico'),
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

// ─── Desktop Mascot ───────────────────────────────────────────────────────

function openChatInMain() {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents
        .executeJavaScript("window.dispatchEvent(new CustomEvent('cligate-open-chat'))")
        .catch(() => { /* page may not be ready; ignore */ });
}

// Persist the mascot config back to the server (debounced for position drags).
function putMascotConfig(patch) {
    try {
        globalThis.fetch(`http://127.0.0.1:${actualPort}/api/mascot/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        }).catch(() => {});
    } catch { /* fetch unavailable; ignore */ }
}

function setMascotEnabled(enabled) {
    mascotConfig.enabled = enabled;
    putMascotConfig({ enabled });
}

function persistMascotPosition(x, y) {
    mascotConfig.position = { x, y };
    if (mascotPositionTimer) clearTimeout(mascotPositionTimer);
    mascotPositionTimer = setTimeout(() => putMascotConfig({ position: { x, y } }), 800);
}

async function loadMascotConfig() {
    try {
        const res = await globalThis.fetch(`http://127.0.0.1:${actualPort}/api/mascot/config`);
        const data = await res.json();
        if (data && data.config) mascotConfig = { ...mascotConfig, ...data.config };
    } catch {
        // server unreachable; keep defaults (enabled)
    }
}

function registerMascotIpc() {
    if (mascotIpcReady) return;
    mascotIpcReady = true;

    ipcMain.on('mascot:open-chat', () => openChatInMain());
    ipcMain.on('mascot:set-ignore-mouse', (_e, ignore) => {
        if (mascotWindow) mascotWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
    });
    ipcMain.on('mascot:move-by', (_e, payload) => {
        if (!mascotWindow) return;
        const dx = Math.round((payload && payload.dx) || 0);
        const dy = Math.round((payload && payload.dy) || 0);
        const [px, py] = mascotWindow.getPosition();
        const nx = px + dx;
        const ny = py + dy;
        mascotWindow.setPosition(nx, ny);
        persistMascotPosition(nx, ny);
    });
    ipcMain.on('mascot:hide', () => {
        if (mascotWindow) mascotWindow.close();
        setMascotEnabled(false);
        refreshTrayMenu();
    });
    ipcMain.on('mascot:menu', (e) => {
        const menu = Menu.buildFromTemplate([
            { label: 'Open chat', click: () => openChatInMain() },
            { label: 'Open dashboard', click: () => { if (mainWindow) mainWindow.show(); } },
            { type: 'separator' },
            { label: 'Hide mascot', click: () => { if (mascotWindow) mascotWindow.close(); setMascotEnabled(false); refreshTrayMenu(); } },
            { type: 'separator' },
            { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
        ]);
        const win = BrowserWindow.fromWebContents(e.sender);
        menu.popup({ window: win || undefined });
    });
}

function createMascotWindow() {
    if (mascotWindow) { mascotWindow.show(); return; }

    const width = 240;
    const height = 240;
    const primary = screen.getPrimaryDisplay();
    const wa = primary.workArea;
    let x = wa.x + wa.width - width - 24;
    let y = wa.y + wa.height - height - 24;
    if (mascotConfig.position && Number.isFinite(mascotConfig.position.x) && Number.isFinite(mascotConfig.position.y)) {
        x = mascotConfig.position.x;
        y = mascotConfig.position.y;
    }

    mascotWindow = new BrowserWindow({
        width, height, x, y,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        movable: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        fullscreenable: false,
        maximizable: false,
        minimizable: false,
        title: 'CliGate Assistant',
        webPreferences: {
            preload: path.join(__dirname, 'electron-mascot-preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    mascotWindow.setAlwaysOnTop(true, 'screen-saver');
    // Start click-through; the page re-enables interaction while the cursor is
    // over the mascot (hit-test in mascot.js → mascot:set-ignore-mouse).
    mascotWindow.setIgnoreMouseEvents(true, { forward: true });
    mascotWindow.loadURL(`http://127.0.0.1:${actualPort}/mascot/index.html`);
    mascotWindow.on('closed', () => { mascotWindow = null; });
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    try {
        // Find an available port
        const preferred = Number(process.env.PORT) || DEFAULT_PORT;
        actualPort = await findAvailablePort(preferred);

        // Check for mandatory updates before proceeding
        await checkForUpdate();

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
        await loadMascotConfig();
        createTray();
        registerMascotIpc();
        if (mascotConfig.enabled !== false) createMascotWindow();
        refreshTrayMenu();
    } catch (err) {
        if (err.message === 'UPDATE_REQUIRED') return;
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
