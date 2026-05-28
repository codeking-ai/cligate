export function createDesktopWaitForFileToolDefinition({ handlers }) {
  return {
    name: 'desktop_wait_for_file',
    description: [
      'Block until a file (or directory) appears on disk, then return its metadata. Use this for "wait until the download finishes" / "wait until the installer copies its bundle" / "wait until the unpacked output is on disk" scenarios, where firing a follow-up tool immediately would race the filesystem.',
      '',
      'Polling is internal: the tool checks `path` every `pollMs` (default 1500ms) and returns the moment the file exists. If you also pass `minSizeBytes`, the tool keeps waiting until the file is at least that large (useful for downloads, where the file appears at 0 bytes and grows). If you pass `stableForMs`, the tool waits until the file size has not changed for that many ms (useful for "downloaded" detection — file is created, grows, then stops growing).',
      '',
      'Returns `{matched, timedOut, attempts, elapsedMs, details: {path, size, modifiedAt}}`. Timeout returns `matched:false, timedOut:true`; do NOT keep retrying the same wait — instead inspect the screen / browser download UI, or ask the user. Cancellation: if the user cancels the assistant run mid-wait, this tool aborts immediately with code RUN_CANCELLED.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file (or directory) to wait for, e.g. "D:\\\\soft\\\\feishu\\\\Feishu-7.68.6.exe".'
        },
        timeoutMs: {
          type: 'integer',
          minimum: 250,
          maximum: 600000,
          default: 60000,
          description: 'Maximum time to wait. Capped at 10 minutes. For real-world downloads/installs 60-180 seconds is usually enough; if you expect longer (large IDE install, big SDK), set 300000.'
        },
        pollMs: {
          type: 'integer',
          minimum: 250,
          maximum: 10000,
          default: 1500,
          description: 'Polling interval. Smaller = more responsive but more CPU. 1500ms is fine for downloads.'
        },
        minSizeBytes: {
          type: 'integer',
          minimum: 0,
          description: 'Only treat the file as "matched" once its size reaches this many bytes. Use this to discriminate "download started" (0-byte placeholder) from "download has content".'
        },
        stableForMs: {
          type: 'integer',
          minimum: 0,
          description: 'Wait until the file size has been stable for this many ms. Use this for "download finished" detection — paired with timeoutMs:300000 it correctly waits out a 2-minute download then settles when bytes stop arriving.'
        }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopWaitForFile
  };
}

export default createDesktopWaitForFileToolDefinition;
