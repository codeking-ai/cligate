import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

function clampInteger(value, { fallback, min, max }) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function escapeRegex(value) {
  return String(value || '').replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function normalizePathForMatch(value) {
  return String(value || '').replace(/\\/g, '/');
}

function globToRegExp(pattern) {
  const normalized = normalizePathForMatch(pattern);
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*') {
      if (next === '*') {
        const afterNext = normalized[index + 2];
        if (afterNext === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegex(char);
  }
  source += '$';
  return new RegExp(source);
}

function buildSearchRegExp({ pattern, caseSensitive = false, isRegex = false }) {
  return isRegex
    ? new RegExp(pattern, caseSensitive ? 'g' : 'gi')
    : new RegExp(escapeRegex(pattern), caseSensitive ? 'g' : 'gi');
}

async function walkFiles(resolvedPath, { includeDirectories = false, entries = [] } = {}) {
  const resolvedStat = await stat(resolvedPath);
  if (!resolvedStat.isDirectory()) {
    entries.push(resolvedPath);
    return entries;
  }

  const items = await readdir(resolvedPath, { withFileTypes: true });
  for (const item of items) {
    const absolutePath = path.join(resolvedPath, item.name);
    if (item.isDirectory()) {
      if (includeDirectories) {
        entries.push(absolutePath);
      }
      await walkFiles(absolutePath, { includeDirectories, entries });
    } else if (item.isFile()) {
      entries.push(absolutePath);
    }
  }
  return entries;
}

export function createSearchToolHandlers({ workspaceGuard }) {
  return {
    async globSearch({ input = {}, context = {} } = {}) {
      const rootPath = workspaceGuard.resolvePath(input.cwd || '.', {
        baseDir: context.cwd || workspaceGuard.workspaceRoot
      });
      const pattern = String(input.pattern || '').trim();
      if (!pattern) {
        throw new Error('glob_search requires pattern');
      }
      const limit = clampInteger(input.limit, { fallback: 200, min: 1, max: 2000 });
      const matcher = globToRegExp(pattern);
      const files = await walkFiles(rootPath);
      const matches = [];
      for (const filePath of files) {
        const relativePath = normalizePathForMatch(workspaceGuard.toWorkspaceRelative(filePath));
        if (matcher.test(relativePath)) {
          matches.push(relativePath);
          if (matches.length >= limit) break;
        }
      }
      return {
        pattern,
        cwd: workspaceGuard.toWorkspaceRelative(rootPath),
        matches,
        truncated: matches.length >= limit
      };
    },

    async grepSearch({ input = {}, context = {} } = {}) {
      const rootPath = workspaceGuard.resolvePath(input.path || '.', {
        baseDir: context.cwd || workspaceGuard.workspaceRoot
      });
      const pattern = String(input.pattern || '');
      if (!pattern.trim()) {
        throw new Error('grep_search requires pattern');
      }
      const limit = clampInteger(input.limit, { fallback: 100, min: 1, max: 1000 });
      const before = clampInteger(input.before, { fallback: 0, min: 0, max: 20 });
      const after = clampInteger(input.after, { fallback: 0, min: 0, max: 20 });
      const matcher = buildSearchRegExp({
        pattern,
        caseSensitive: input.caseSensitive === true,
        isRegex: input.isRegex === true
      });
      const files = await walkFiles(rootPath);
      const matches = [];
      for (const filePath of files) {
        const content = await readFile(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          matcher.lastIndex = 0;
          if (!matcher.test(lines[index])) {
            continue;
          }
          const start = Math.max(0, index - before);
          const end = Math.min(lines.length, index + after + 1);
          matches.push({
            path: workspaceGuard.toWorkspaceRelative(filePath),
            line: index + 1,
            text: lines[index],
            context: lines.slice(start, end)
          });
          if (matches.length >= limit) {
            return {
              pattern,
              path: workspaceGuard.toWorkspaceRelative(rootPath),
              matches,
              truncated: true
            };
          }
        }
      }
      return {
        pattern,
        path: workspaceGuard.toWorkspaceRelative(rootPath),
        matches,
        truncated: false
      };
    }
  };
}

export default createSearchToolHandlers;
