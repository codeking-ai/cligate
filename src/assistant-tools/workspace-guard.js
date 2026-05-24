import path from 'node:path';

function normalizeForComparison(value) {
  const normalized = path.resolve(String(value || '.'));
  return process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized;
}

export class WorkspaceGuard {
  constructor({ workspaceRoot = process.cwd() } = {}) {
    this.workspaceRoot = path.resolve(String(workspaceRoot || process.cwd()));
  }

  isPathWithinWorkspace(targetPath) {
    const root = normalizeForComparison(this.workspaceRoot);
    const resolved = normalizeForComparison(targetPath);
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  assertWithinWorkspace(targetPath) {
    const resolved = path.resolve(String(targetPath || '.'));
    if (!this.isPathWithinWorkspace(resolved)) {
      throw new Error(`Path is outside the workspace: ${resolved}`);
    }
    return resolved;
  }

  resolvePath(targetPath = '.', { baseDir = this.workspaceRoot } = {}) {
    const raw = String(targetPath || '.').trim() || '.';
    const resolved = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(String(baseDir || this.workspaceRoot), raw);
    return this.assertWithinWorkspace(resolved);
  }

  toWorkspaceRelative(targetPath) {
    const resolved = this.assertWithinWorkspace(targetPath);
    const relative = path.relative(this.workspaceRoot, resolved);
    return relative || '.';
  }
}

export default WorkspaceGuard;
