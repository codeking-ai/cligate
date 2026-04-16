import { spawn } from 'child_process';
import readline from 'readline';

import { AGENT_EVENT_TYPE } from '../models.js';
import { buildCliNotFoundError, buildSpawnCommand } from '../cli-resolver.js';

function toTomlString(value) {
  return JSON.stringify(String(value));
}

function mapCodexEvent(session, event) {
  const events = [];

  if (event?.type === 'thread.started') {
    events.push({
      type: AGENT_EVENT_TYPE.PROGRESS,
      payload: {
        phase: 'thread_started',
        providerSessionId: event.thread_id
      }
    });
  } else if (event?.type === 'turn.started') {
    events.push({
      type: AGENT_EVENT_TYPE.PROGRESS,
      payload: {
        phase: 'turn_started',
        turn: session.turnCount
      }
    });
  } else if (event?.type === 'item.started' || event?.type === 'item.updated' || event?.type === 'item.completed') {
    const item = event.item || {};
    if (item.type === 'agent_message') {
      if (event.type === 'item.completed') {
        events.push({
          type: AGENT_EVENT_TYPE.MESSAGE,
          payload: {
            text: item.text || '',
            itemType: item.type
          }
        });
      }
    } else if (item.type === 'command_execution') {
      events.push({
        type: AGENT_EVENT_TYPE.COMMAND,
        payload: {
          id: item.id,
          command: item.command,
          output: item.aggregated_output || '',
          exitCode: item.exit_code,
          status: item.status || 'in_progress'
        }
      });
    } else if (item.type === 'file_change') {
      events.push({
        type: AGENT_EVENT_TYPE.FILE_CHANGE,
        payload: {
          id: item.id,
          status: item.status,
          changes: Array.isArray(item.changes) ? item.changes : []
        }
      });
    } else if (item.type === 'todo_list') {
      events.push({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: 'todo_list',
          items: Array.isArray(item.items) ? item.items : []
        }
      });
    } else if (item.type === 'reasoning') {
      events.push({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: 'reasoning',
          text: item.text || ''
        }
      });
    } else if (item.type === 'error') {
      events.push({
        type: AGENT_EVENT_TYPE.FAILED,
        payload: {
          message: item.message || 'Codex reported an error item'
        }
      });
    }
  } else if (event?.type === 'turn.completed') {
    events.push({
      type: AGENT_EVENT_TYPE.COMPLETED,
      payload: {
        usage: event.usage || null
      }
    });
  } else if (event?.type === 'turn.failed') {
    events.push({
      type: AGENT_EVENT_TYPE.FAILED,
      payload: {
        message: event.error?.message || 'Codex turn failed'
      }
    });
  } else if (event?.type === 'error') {
    events.push({
      type: AGENT_EVENT_TYPE.FAILED,
      payload: {
        message: event.message || 'Codex stream error'
      }
    });
  }

  return events;
}

export class CodexProvider {
  constructor() {
    this.id = 'codex';
    this.capabilities = {
      supportsResume: true,
      supportsStreamingEvents: true,
      supportsApprovalRequests: false,
      supportsInputInjection: true,
      supportsInterrupt: true
    };
  }

  async startTurn({ session, input, onProviderEvent, onSessionPatch, onTurnFinished, onTurnFailed }) {
    const args = ['exec', '--experimental-json'];

    if (session.model) {
      args.push('--model', session.model);
    }

    if (session.cwd) {
      args.push('--cd', session.cwd);
    }

    args.push('--skip-git-repo-check');
    args.push('--config', `approval_policy=${toTomlString(process.env.CLIGATE_CODEX_APPROVAL_POLICY || 'never')}`);

    if (session.providerSessionId) {
      args.push('resume', session.providerSessionId);
    }

    const spawnSpec = buildSpawnCommand('codex', args);

    let child;
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: session.cwd,
        env: { ...process.env }
      });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw buildCliNotFoundError('codex', error);
      }
      throw error;
    }

    if (!child.stdout) {
      child.kill();
      throw new Error('Codex child process has no stdout');
    }

    let terminalState = null;
    const stderrChunks = [];
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });

    const pushMappedEvents = (parsed) => {
      if (parsed?.type === 'thread.started' && parsed.thread_id) {
        onSessionPatch({ providerSessionId: parsed.thread_id });
      }

      const mappedEvents = mapCodexEvent(session, parsed);
      for (const event of mappedEvents) {
        onProviderEvent(event);
        if (event.type === AGENT_EVENT_TYPE.COMPLETED) {
          terminalState = { status: 'ready', summary: buildCompletionSummary(session, event.payload) };
        } else if (event.type === AGENT_EVENT_TYPE.FAILED) {
          terminalState = { status: 'failed', error: event.payload?.message || 'Codex turn failed' };
        }
      }
    };

    child.once('error', (error) => {
      rl.close();
      if (error?.code === 'ENOENT') {
        onTurnFailed(buildCliNotFoundError('codex', error));
        return;
      }
      onTurnFailed(error);
    });

    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });

    (async () => {
      try {
        for await (const line of rl) {
          const trimmed = String(line || '').trim();
          if (!trimmed) continue;

          let parsed;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            onProviderEvent({
              type: AGENT_EVENT_TYPE.PROGRESS,
              payload: {
                phase: 'stdout',
                text: trimmed
              }
            });
            continue;
          }

          pushMappedEvents(parsed);
        }
      } catch (error) {
        onTurnFailed(error);
      }
    })();

    child.once('exit', (code, signal) => {
      rl.close();
      if (terminalState?.status === 'ready') {
        onTurnFinished(terminalState);
        return;
      }
      if (terminalState?.status === 'failed') {
        onTurnFailed(new Error(terminalState.error));
        return;
      }

      if (code === 0 && !signal) {
        onTurnFinished({
          status: 'ready',
          summary: buildCompletionSummary(session, null)
        });
        return;
      }

      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      onTurnFailed(new Error(stderrText || `Codex exited with ${detail}`));
    });

    if (!child.stdin) {
      child.kill();
      throw new Error('Codex child process has no stdin');
    }

    child.stdin.write(String(input || ''));
    child.stdin.end();

    return {
      pid: child.pid || null,
      cancel() {
        if (!child.killed) {
          child.kill();
        }
      }
    };
  }
}

function buildCompletionSummary(session, payload) {
  const usage = payload?.usage;
  if (usage) {
    return `Codex turn ${session.turnCount} completed (${usage.input_tokens || 0}/${usage.output_tokens || 0} tokens).`;
  }
  return `Codex turn ${session.turnCount} completed.`;
}

export default CodexProvider;
