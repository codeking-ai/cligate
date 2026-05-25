import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

function clampInteger(value, { fallback, min, max }) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

async function walkDirectory(resolvedPath, { recursive, limit, workspaceGuard, entries }) {
  const items = await readdir(resolvedPath, { withFileTypes: true });
  for (const item of items) {
    if (entries.length >= limit) {
      return;
    }
    const absolutePath = path.join(resolvedPath, item.name);
    const itemStat = await stat(absolutePath);
    entries.push({
      name: item.name,
      path: workspaceGuard.toWorkspaceRelative(absolutePath),
      type: item.isDirectory() ? 'directory' : (item.isFile() ? 'file' : 'other'),
      size: itemStat.size,
      mtime: itemStat.mtime.toISOString()
    });
    if (recursive && item.isDirectory()) {
      await walkDirectory(absolutePath, {
        recursive,
        limit,
        workspaceGuard,
        entries
      });
    }
  }
}

export function createFileToolHandlers({ workspaceGuard }) {
  return {
    async listDirectory({ input = {}, context = {} } = {}) {
      const limit = clampInteger(input.limit, { fallback: 200, min: 1, max: 1000 });
      const recursive = input.recursive === true;
      const resolvedPath = workspaceGuard.resolvePath(input.path || '.', {
        baseDir: context.cwd || workspaceGuard.workspaceRoot,
        extraReadRoots: Array.isArray(context.extraReadRoots) ? context.extraReadRoots : [],
        readOnly: true
      });
      const entries = [];
      await walkDirectory(resolvedPath, {
        recursive,
        limit,
        workspaceGuard,
        entries
      });
      return {
        path: workspaceGuard.toWorkspaceRelative(resolvedPath),
        entries,
        truncated: entries.length >= limit
      };
    },

    async readFile({ input = {}, context = {} } = {}) {
      const maxBytes = clampInteger(input.maxBytes, { fallback: 32768, min: 1, max: 262144 });
      // read_file honors context.extraReadRoots (e.g. dirs of active skills) so
      // the assistant can open SKILL.md siblings like editing.md / pptxgenjs.md
      // even when the workspace cwd lives on a different drive.
      const resolvedPath = workspaceGuard.resolvePath(input.path, {
        baseDir: context.cwd || workspaceGuard.workspaceRoot,
        extraReadRoots: Array.isArray(context.extraReadRoots) ? context.extraReadRoots : [],
        readOnly: true
      });
      const raw = await readFile(resolvedPath, 'utf8');
      const lines = raw.split(/\r?\n/);
      const startLine = clampInteger(input.startLine, { fallback: 1, min: 1, max: Math.max(lines.length, 1) });
      const endLine = clampInteger(input.endLine, { fallback: lines.length, min: startLine, max: lines.length });
      const selected = lines.slice(startLine - 1, endLine).join('\n');
      const text = Buffer.byteLength(selected, 'utf8') > maxBytes
        ? Buffer.from(selected, 'utf8').subarray(0, maxBytes).toString('utf8')
        : selected;
      return {
        path: workspaceGuard.toWorkspaceRelative(resolvedPath),
        startLine,
        endLine,
        text,
        truncated: Buffer.byteLength(selected, 'utf8') > maxBytes
      };
    },

    async statPath({ input = {}, context = {} } = {}) {
      const resolvedPath = workspaceGuard.resolvePath(input.path, {
        baseDir: context.cwd || workspaceGuard.workspaceRoot,
        extraReadRoots: Array.isArray(context.extraReadRoots) ? context.extraReadRoots : [],
        readOnly: true
      });
      const itemStat = await stat(resolvedPath);
      return {
        path: workspaceGuard.toWorkspaceRelative(resolvedPath),
        type: itemStat.isDirectory() ? 'directory' : (itemStat.isFile() ? 'file' : 'other'),
        size: itemStat.size,
        mtime: itemStat.mtime.toISOString()
      };
    }
  };
}

export default createFileToolHandlers;
