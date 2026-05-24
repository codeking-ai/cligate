import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

function clampInteger(value, { fallback, min, max }) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function escapeRegex(value) {
  return String(value || '').replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function createMutationToolHandlers({ workspaceGuard }) {
  return {
    async writeFile({ input = {}, context = {} } = {}) {
      const resolvedPath = workspaceGuard.resolvePath(input.path, {
        baseDir: context.cwd || workspaceGuard.workspaceRoot
      });
      const mode = String(input.mode || 'overwrite').trim().toLowerCase();
      const content = String(input.content || '');
      await mkdir(path.dirname(resolvedPath), { recursive: true });

      if (mode === 'append') {
        const existing = await readFile(resolvedPath, 'utf8').catch(() => '');
        await writeFile(resolvedPath, `${existing}${content}`, 'utf8');
      } else {
        await writeFile(resolvedPath, content, 'utf8');
      }

      return {
        path: workspaceGuard.toWorkspaceRelative(resolvedPath),
        bytesWritten: Buffer.byteLength(content, 'utf8'),
        mode
      };
    },

    async replaceInFile({ input = {}, context = {} } = {}) {
      const resolvedPath = workspaceGuard.resolvePath(input.path, {
        baseDir: context.cwd || workspaceGuard.workspaceRoot
      });
      const source = await readFile(resolvedPath, 'utf8');
      const replacement = String(input.newText ?? input.replacement ?? '');
      const maxReplacements = clampInteger(input.maxReplacements, { fallback: 0, min: 0, max: 100000 });
      let next = source;
      let replacementCount = 0;

      if (input.isRegex === true) {
        const flags = input.replaceAll === true
          ? (input.caseSensitive === true ? 'g' : 'gi')
          : (input.caseSensitive === true ? '' : 'i');
        const matcher = new RegExp(String(input.pattern || ''), flags);
        next = source.replace(matcher, (...args) => {
          if (maxReplacements > 0 && replacementCount >= maxReplacements) {
            return args[0];
          }
          replacementCount += 1;
          return replacement;
        });
      } else {
        const needle = String(input.oldText ?? input.pattern ?? '');
        if (!needle) {
          throw new Error('replace_in_file requires oldText or pattern');
        }
        if (input.caseSensitive === false) {
          const flags = input.replaceAll === true ? 'gi' : 'i';
          const matcher = new RegExp(escapeRegex(needle), flags);
          next = source.replace(matcher, (...args) => {
            if (maxReplacements > 0 && replacementCount >= maxReplacements) {
              return args[0];
            }
            replacementCount += 1;
            return replacement;
          });
        } else if (input.replaceAll === true) {
          const parts = source.split(needle);
          replacementCount = Math.max(0, parts.length - 1);
          if (maxReplacements > 0 && replacementCount > maxReplacements) {
            let remaining = source;
            let built = '';
            for (let index = 0; index < maxReplacements; index += 1) {
              const hit = remaining.indexOf(needle);
              if (hit < 0) break;
              built += remaining.slice(0, hit) + replacement;
              remaining = remaining.slice(hit + needle.length);
            }
            next = built + remaining;
            replacementCount = maxReplacements;
          } else {
            next = parts.join(replacement);
          }
        } else {
          const hit = source.indexOf(needle);
          if (hit >= 0) {
            replacementCount = 1;
            next = `${source.slice(0, hit)}${replacement}${source.slice(hit + needle.length)}`;
          }
        }
      }

      if (source === next) {
        return {
          path: workspaceGuard.toWorkspaceRelative(resolvedPath),
          replaced: 0
        };
      }

      await writeFile(resolvedPath, next, 'utf8');
      return {
        path: workspaceGuard.toWorkspaceRelative(resolvedPath),
        replaced: replacementCount
      };
    }
  };
}

export default createMutationToolHandlers;
