/**
 * Tool Installer
 * Detects and installs CLI tools (Node.js, Claude Code, Codex CLI, Gemini CLI, OpenClaw).
 * Strategy: always install Node.js first, then use npm for all CLI tools.
 */

import { execSync, spawn } from 'child_process';
import { platform } from 'os';
import { existsSync } from 'fs';

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

function detectTool(toolId) {
    const tool = TOOLS[toolId];
    if (!tool) return { installed: false, error: 'Unknown tool' };

    const version = runCommand(`${tool.command} ${tool.versionFlag}`);
    if (version) {
        // Clean version string (remove 'v' prefix, extra text)
        const cleanVersion = version.split('\n')[0].replace(/^v/, '').trim();
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

export { TOOLS };
