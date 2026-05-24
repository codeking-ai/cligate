import { readFile, stat } from 'node:fs/promises';

function inferMediaType(filePath) {
  const normalized = String(filePath || '').toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.gif')) return 'image/gif';
  if (normalized.endsWith('.bmp')) return 'image/bmp';
  if (normalized.endsWith('.svg')) return 'image/svg+xml';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function clampInteger(value, { fallback, min, max }) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function createImageToolHandlers({ workspaceGuard }) {
  return {
    async viewImage({ input = {}, context = {} } = {}) {
      const resolvedPath = workspaceGuard.resolvePath(input.path, {
        baseDir: context.cwd || workspaceGuard.workspaceRoot
      });
      const itemStat = await stat(resolvedPath);
      const maxBytes = clampInteger(input.maxBytes, { fallback: 2 * 1024 * 1024, min: 1024, max: 20 * 1024 * 1024 });
      if (itemStat.size > maxBytes) {
        throw new Error(`image exceeds maxBytes (${itemStat.size} > ${maxBytes})`);
      }
      const buffer = await readFile(resolvedPath);
      const mediaType = inferMediaType(resolvedPath);
      const data = buffer.toString('base64');
      // tool_result.content must use Anthropic-canonical blocks so the supervisor
      // request stays in one shape across providers. The anthropic→openai-responses
      // translator (src/translators/normalizers/multimodal.js) rewrites {type:"image",
      // source:{base64...}} into {type:"input_image", image_url:"data:..."} for the
      // OpenAI-Responses bridge automatically; emitting `input_image` here directly
      // would be silently dropped by that translator and break view_image entirely.
      return {
        path: workspaceGuard.toWorkspaceRelative(resolvedPath),
        detail: String(input.detail || 'high').trim() || 'high',
        media_type: mediaType,
        size: itemStat.size,
        imageUrl: `data:${mediaType};base64,${data}`,
        content: [{
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data
          }
        }]
      };
    }
  };
}

export default createImageToolHandlers;
