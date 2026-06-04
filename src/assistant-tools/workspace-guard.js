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

function normalizeRoots(roots = []) {
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
  constructor({ workspaceRoot = process.cwd(), extraReadRoots = [], extraWriteRoots = [] } = {}) {
    this.workspaceRoot = path.resolve(String(workspaceRoot || process.cwd()));
    this.extraReadRoots = normalizeRoots(extraReadRoots);
    // Always read+write trees OUTSIDE the workspace that need no per-call
    // approval — e.g. the CliGate config dir (~/.cligate), which is the
    // software's own home (skills, stores). Treated as fully writable so the
    // assistant can load skill files and manage its own data regardless of cwd.
    this.extraWriteRoots = normalizeRoots(extraWriteRoots);
  }

  isPathWithinWorkspace(targetPath) {
    return isPathWithinRoot(targetPath, this.workspaceRoot);
  }

  // True only for the always-writable EXTRA roots (.cligate), excluding the
  // workspace. Used by the policy to decide which mutating calls may skip the
  // per-call confirmation gate.
  isPathWithinExtraWriteRoot(targetPath, { extraWriteRoots = [] } = {}) {
    const combined = [...this.extraWriteRoots, ...normalizeRoots(extraWriteRoots)];
    return combined.some((root) => isPathWithinRoot(targetPath, root));
  }

  // Writable === workspace root OR any always-writable extra root (.cligate).
  isPathWritable(targetPath, { extraWriteRoots = [] } = {}) {
    return this.isPathWithinWorkspace(targetPath)
      || this.isPathWithinExtraWriteRoot(targetPath, { extraWriteRoots });
  }

  isPathWithinReadRoot(targetPath, { extraReadRoots = [] } = {}) {
    const combined = [...this.extraReadRoots, ...normalizeRoots(extraReadRoots)];
    return combined.some((root) => isPathWithinRoot(targetPath, root));
  }

  // Anything writable is also readable; plus the whitelisted read-only roots
  // (active-skill dirs, prompt-granted roots passed via extraReadRoots).
  isPathReadable(targetPath, { extraReadRoots = [] } = {}) {
    return this.isPathWritable(targetPath)
      || this.isPathWithinReadRoot(targetPath, { extraReadRoots });
  }

  // Back-compat: strict workspace-only assertion. Kept for callers that need
  // the original "inside the workspace tree" semantics; writes now go through
  // assertWritable so the .cligate write root is honored.
  assertWithinWorkspace(targetPath) {
    const resolved = path.resolve(String(targetPath || '.'));
    if (!this.isPathWithinWorkspace(resolved)) {
      throw new Error(`Path is outside the workspace: ${resolved}`);
    }
    return resolved;
  }

  assertWritable(targetPath) {
    const resolved = path.resolve(String(targetPath || '.'));
    if (!this.isPathWritable(resolved)) {
      throw new Error(`Path is outside the workspace: ${resolved}`);
    }
    return resolved;
  }

  assertReadable(targetPath, { extraReadRoots = [] } = {}) {
    const resolved = path.resolve(String(targetPath || '.'));
    if (this.isPathReadable(resolved, { extraReadRoots })) return resolved;
    throw new Error(`Path is outside the workspace: ${resolved}`);
  }

  resolvePath(targetPath = '.', { baseDir = this.workspaceRoot, extraReadRoots = [], readOnly = false } = {}) {
    const raw = String(targetPath || '.').trim() || '.';
    const resolved = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(String(baseDir || this.workspaceRoot), raw);
    return readOnly
      ? this.assertReadable(resolved, { extraReadRoots })
      : this.assertWritable(resolved);
  }

  toWorkspaceRelative(targetPath) {
    const resolved = path.resolve(String(targetPath || '.'));
    if (this.isPathWithinWorkspace(resolved)) {
      const relative = path.relative(this.workspaceRoot, resolved);
      return relative || '.';
    }
    // For files outside the workspace (whitelisted read/write roots), keep the
    // absolute path so the LLM sees an unambiguous reference instead of a
    // misleading workspace-relative string.
    return resolved;
  }
}

export default WorkspaceGuard;
