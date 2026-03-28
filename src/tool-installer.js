/**
 * Tool Installer
 * Detects and installs CLI tools (Node.js, Claude Code, Codex CLI, Gemini CLI, OpenClaw).
 * Strategy: always install Node.js first, then use npm for all CLI tools.
 */

import { execSync, spawn } from 'child_process';
import { platform } from 'os';
import { existsSync } from 'fs';

// Version cache: { [toolId]: { latestVersion: string, checkedAt: number } }
const versionCache = {};
const VERSION_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const TOOLS = {
    node: {
        name: 'Node.js',
        command: 'node',
        versionFlag: '--version',
        npmPackage: null, // installed separately
        description: 'JavaScript runtime (required for all CLI tools)',
        color: 'green'
    },
    claude: {
        name: 'Claude Code',
        command: 'claude',
        versionFlag: '--version',
        npmPackage: '@anthropic-ai/claude-code',
        description: 'Anthropic\'s CLI for Claude',
        color: 'purple'
    },
    codex: {
        name: 'Codex CLI',
        command: 'codex',
        versionFlag: '--version',
        npmPackage: '@openai/codex',
        description: 'OpenAI\'s CLI coding agent',
        color: 'green'
    },
    gemini: {
        name: 'Gemini CLI',
        command: 'gemini',
        versionFlag: '--version',
        npmPackage: '@google/gemini-cli',
        description: 'Google\'s CLI for Gemini',
        color: 'blue'
    },
    openclaw: {
        name: 'OpenClaw',
        command: 'openclaw',
        versionFlag: '--version',
        npmPackage: 'openclaw',
        description: 'Open-source multi-provider coding agent',
        color: 'orange'
    }
};

function getOS() {
    const p = platform();
    if (p === 'win32') return 'windows';
    if (p === 'darwin') return 'macos';
    return 'linux';
}

function runCommand(cmd) {
    try {
        return execSync(cmd, {
            encoding: 'utf8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true
        }).trim();
    } catch {
        return null;
    }
}

/**
 * Extract a clean version number from raw --version output.
 * Handles formats like:
 *   "2.1.86 (Claude Code)"  → "2.1.86"
 *   "codex-cli 0.117.0"     → "0.117.0"
 *   "OpenClaw 2026.3.24 (cff6dc9)" → "2026.3.24"
 *   "v24.14.0"              → "24.14.0"
 *   "0.34.0"                → "0.34.0"
 */
function extractVersion(raw) {
    if (!raw) return null;
    const firstLine = raw.split('\n')[0].trim();
    // Match the first semver-like pattern: digits.digits[.digits...]
    const match = firstLine.match(/(\d+\.\d+(?:\.\d+)*)/);
    return match ? match[1] : firstLine.replace(/^v/, '').trim();
}

function detectTool(toolId) {
    const tool = TOOLS[toolId];
    if (!tool) return { installed: false, error: 'Unknown tool' };

    const version = runCommand(`${tool.command} ${tool.versionFlag}`);
    if (version) {
        const cleanVersion = extractVersion(version);
        return { installed: true, version: cleanVersion };
    }
    return { installed: false };
}

export function detectAllTools() {
    const os = getOS();
    const results = {};

    for (const [id, tool] of Object.entries(TOOLS)) {
        const status = detectTool(id);
        results[id] = {
            ...tool,
            id,
            ...status
        };
    }

    // Check npm availability separately
    const npmVersion = runCommand('npm --version');
    results.node.npmInstalled = !!npmVersion;
    results.node.npmVersion = npmVersion || null;

    // Attach cached latest version info if available
    for (const [id, tool] of Object.entries(results)) {
        const cached = versionCache[id];
        if (cached && (Date.now() - cached.checkedAt) < VERSION_CACHE_TTL) {
            tool.latestVersion = cached.latestVersion;
            tool.updateAvailable = tool.installed && cached.latestVersion
                ? compareVersions(tool.version, cached.latestVersion) < 0
                : false;
        } else {
            tool.latestVersion = null;
            tool.updateAvailable = false;
        }
    }

    return { os, tools: results };
}

export function getNodeInstallInfo() {
    const os = getOS();

    switch (os) {
        case 'windows':
            return {
                os,
                method: 'installer',
                downloadUrl: 'https://nodejs.org/en/download/',
                instructions: [
                    'Download the Windows Installer (.msi) from nodejs.org',
                    'Run the installer and follow the prompts',
                    'Restart your terminal after installation',
                    'Verify with: node --version'
                ],
                autoInstallSupported: true,
                autoCommand: 'winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements'
            };
        case 'macos':
            return {
                os,
                method: 'installer',
                downloadUrl: 'https://nodejs.org/en/download/',
                instructions: [
                    'Download the macOS Installer (.pkg) from nodejs.org',
                    'Or install via Homebrew: brew install node',
                    'Verify with: node --version'
                ],
                autoInstallSupported: true,
                autoCommand: 'brew install node || (curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs)'
            };
        case 'linux':
            return {
                os,
                method: 'package-manager',
                downloadUrl: 'https://nodejs.org/en/download/',
                instructions: [
                    'Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs',
                    'Fedora/RHEL: sudo dnf install nodejs',
                    'Or use nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash',
                    'Verify with: node --version'
                ],
                autoInstallSupported: true,
                autoCommand: 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs'
            };
        default:
            return { os, method: 'manual', downloadUrl: 'https://nodejs.org/en/download/', instructions: ['Download from nodejs.org'], autoInstallSupported: false };
    }
}

/**
 * Install a CLI tool via npm.
 * Returns a promise that resolves with { success, output } or { success: false, error }.
 */
export function installTool(toolId) {
    const tool = TOOLS[toolId];
    if (!tool) return Promise.resolve({ success: false, error: 'Unknown tool' });
    if (!tool.npmPackage) return Promise.resolve({ success: false, error: 'This tool cannot be installed via npm' });

    // Check if npm is available
    const npmCheck = runCommand('npm --version');
    if (!npmCheck) {
        return Promise.resolve({ success: false, error: 'npm is not available. Please install Node.js first.' });
    }

    return new Promise((resolve) => {
        const args = ['install', '-g', tool.npmPackage];
        const proc = spawn('npm', args, {
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            if (code === 0) {
                // Re-detect to get version
                const status = detectTool(toolId);
                resolve({
                    success: true,
                    version: status.version || 'installed',
                    output: stdout
                });
            } else {
                resolve({
                    success: false,
                    error: stderr || `npm install exited with code ${code}`,
                    output: stdout
                });
            }
        });

        proc.on('error', (err) => {
            resolve({ success: false, error: err.message });
        });

        // Timeout after 5 minutes
        setTimeout(() => {
            proc.kill();
            resolve({ success: false, error: 'Installation timed out (5 minutes)' });
        }, 300000);
    });
}

/**
 * Install Node.js automatically (platform-dependent).
 */
export function installNode() {
    const info = getNodeInstallInfo();
    if (!info.autoInstallSupported) {
        return Promise.resolve({ success: false, error: 'Automatic installation not supported on this platform' });
    }

    return new Promise((resolve) => {
        const proc = spawn(info.autoCommand, [], {
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            if (code === 0) {
                const status = detectTool('node');
                resolve({
                    success: true,
                    version: status.version || 'installed',
                    output: stdout
                });
            } else {
                resolve({
                    success: false,
                    error: stderr || `Installation exited with code ${code}`,
                    output: stdout,
                    command: info.autoCommand
                });
            }
        });

        proc.on('error', (err) => {
            resolve({ success: false, error: err.message, command: info.autoCommand });
        });

        setTimeout(() => {
            proc.kill();
            resolve({ success: false, error: 'Installation timed out (10 minutes)' });
        }, 600000);
    });
}

/**
 * Compare two semver-like version strings.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareVersions(a, b) {
    if (!a || !b) return 0;
    const pa = a.replace(/^v/, '').split('.').map(Number);
    const pb = b.replace(/^v/, '').split('.').map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na < nb) return -1;
        if (na > nb) return 1;
    }
    return 0;
}

/**
 * Check the latest available npm version for a tool.
 * Uses an in-memory cache with TTL to avoid frequent registry queries.
 */
export function checkLatestVersion(toolId) {
    const tool = TOOLS[toolId];
    if (!tool || !tool.npmPackage) return null;

    // Return cached value if fresh
    const cached = versionCache[toolId];
    if (cached && (Date.now() - cached.checkedAt) < VERSION_CACHE_TTL) {
        return cached.latestVersion;
    }

    const result = runCommand(`npm view ${tool.npmPackage} version`);
    if (result) {
        const latestVersion = result.split('\n')[0].replace(/^v/, '').trim();
        versionCache[toolId] = { latestVersion, checkedAt: Date.now() };
        return latestVersion;
    }
    return null;
}

/**
 * Check latest versions for all npm-based tools.
 * Returns { toolId: latestVersion } map.
 */
export function checkAllLatestVersions() {
    const results = {};
    for (const toolId of Object.keys(TOOLS)) {
        if (TOOLS[toolId].npmPackage) {
            const latest = checkLatestVersion(toolId);
            if (latest) {
                results[toolId] = latest;
            }
        }
    }
    return results;
}

/**
 * Update a CLI tool to the latest version via npm.
 * Returns a promise like installTool.
 */
export function updateTool(toolId) {
    const tool = TOOLS[toolId];
    if (!tool) return Promise.resolve({ success: false, error: 'Unknown tool' });
    if (!tool.npmPackage) return Promise.resolve({ success: false, error: 'This tool cannot be updated via npm' });

    const npmCheck = runCommand('npm --version');
    if (!npmCheck) {
        return Promise.resolve({ success: false, error: 'npm is not available. Please install Node.js first.' });
    }

    return new Promise((resolve) => {
        const args = ['install', '-g', `${tool.npmPackage}@latest`];
        const proc = spawn('npm', args, {
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            // Invalidate cache so next check gets fresh data
            delete versionCache[toolId];

            if (code === 0) {
                const status = detectTool(toolId);
                resolve({
                    success: true,
                    version: status.version || 'updated',
                    output: stdout
                });
            } else {
                resolve({
                    success: false,
                    error: stderr || `npm install exited with code ${code}`,
                    output: stdout
                });
            }
        });

        proc.on('error', (err) => {
            resolve({ success: false, error: err.message });
        });

        setTimeout(() => {
            proc.kill();
            resolve({ success: false, error: 'Update timed out (5 minutes)' });
        }, 300000);
    });
}

export { TOOLS };
