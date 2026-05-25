import path from 'node:path';

function normalizeForComparison(value) {
  const normalized = path.resolve(String(value || '.'));
  return process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized;
}

function isPathWithinRoot(targetPath, rootPath) {
  if (!rootPath) return false;
  const root = normalizeForComparison(rootPath);
  const resolved = normalizeForComparison(targetPath);
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeExtraReadRoots(roots = []) {
  const list = Array.isArray(roots) ? roots : [];
  const dedup = new Set();
  for (const entry of list) {
    const raw = String(entry || '').trim();
    if (!raw) continue;
    dedup.add(path.resolve(raw));
  }
  return [...dedup];
}

export class WorkspaceGuard {
  constructor({ workspaceRoot = process.cwd(), extraReadRoots = [] } = {}) {
    this.workspaceRoot = path.resolve(String(workspaceRoot || process.cwd()));
    this.extraReadRoots = normalizeExtraReadRoots(extraReadRoots);
  }

  isPathWithinWorkspace(targetPath) {
    return isPathWithinRoot(targetPath, this.workspaceRoot);
  }

  isPathWithinReadRoot(targetPath, { extraReadRoots = [] } = {}) {
    const combined = [...this.extraReadRoots, ...normalizeExtraReadRoots(extraReadRoots)];
    return combined.some((root) => isPathWithinRoot(targetPath, root));
  }

  assertWithinWorkspace(targetPath) {
    const resolved = path.resolve(String(targetPath || '.'));
    if (!this.isPathWithinWorkspace(resolved)) {
      throw new Error(`Path is outside the workspace: ${resolved}`);
    }
    return resolved;
  }

  assertReadable(targetPath, { extraReadRoots = [] } = {}) {
    const resolved = path.resolve(String(targetPath || '.'));
    if (this.isPathWithinWorkspace(resolved)) return resolved;
    if (this.isPathWithinReadRoot(resolved, { extraReadRoots })) return resolved;
    throw new Error(`Path is outside the workspace: ${resolved}`);
  }

  resolvePath(targetPath = '.', { baseDir = this.workspaceRoot, extraReadRoots = [], readOnly = false } = {}) {
    const raw = String(targetPath || '.').trim() || '.';
    const resolved = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(String(baseDir || this.workspaceRoot), raw);
    return readOnly
      ? this.assertReadable(resolved, { extraReadRoots })
      : this.assertWithinWorkspace(resolved);
  }

  toWorkspaceRelative(targetPath) {
    const resolved = path.resolve(String(targetPath || '.'));
    if (this.isPathWithinWorkspace(resolved)) {
      const relative = path.relative(this.workspaceRoot, resolved);
      return relative || '.';
    }
    // For files outside the workspace (whitelisted read roots), keep the absolute
    // path so the LLM sees an unambiguous reference instead of a misleading
    // workspace-relative string.
    return resolved;
  }
}

export default WorkspaceGuard;
