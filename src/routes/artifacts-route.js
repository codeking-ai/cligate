/**
 * Serves generated/captured artifact files over HTTP so the dashboard chat (and
 * any <img src>) can render an image artifact by id without inlining base64.
 *
 * Security: the :id is an artifact id (not a path); we read the path STORED on
 * the artifact record, then hard-require it to live inside CONFIG_DIR before
 * streaming — defense-in-depth against ever serving a file outside .cligate.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import artifactService from '../assistant-core/artifact-service.js';
import { CONFIG_DIR } from '../account-manager.js';

function isInsideConfigDir(filePath) {
  const root = resolve(CONFIG_DIR);
  const target = resolve(filePath);
  return target === root || target.startsWith(root + sep);
}

export function handleGetArtifact(req, res) {
  const id = String(req.params.id || '').trim();
  const artifact = artifactService.getArtifact?.(id);
  if (!artifact) {
    return res.status(404).json({ success: false, error: 'artifact not found' });
  }

  const filePath = String(artifact.path || '').trim();
  if (filePath) {
    if (!isInsideConfigDir(filePath)) {
      return res.status(403).json({ success: false, error: 'artifact path is outside the config dir' });
    }
    const resolved = resolve(filePath);
    if (existsSync(resolved) && statSync(resolved).isFile()) {
      res.setHeader('Content-Type', artifact.mediaType || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return createReadStream(resolved).pipe(res);
    }
  }

  // Fall back to an embedded data: URL (older artifacts may store bytes inline).
  const dataMatch = String(artifact.imageUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (dataMatch) {
    res.setHeader('Content-Type', dataMatch[1]);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.end(Buffer.from(dataMatch[2], 'base64'));
  }

  return res.status(404).json({ success: false, error: 'artifact has no servable content' });
}

export default { handleGetArtifact };
