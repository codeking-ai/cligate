import { spawn } from 'child_process';
import crypto from 'crypto';
import readline from 'readline';

import { AGENT_EVENT_TYPE } from '../models.js';
import { buildCliNotFoundError, buildSpawnCommand } from '../cli-resolver.js';

export function buildUserMessage(content) {
  return {
    type: 'user',
    content: String(content || ''),
    uuid: '',
    session_id: '',
    message: {
      role: 'user',
      content: String(content || '')
    },
    parent_tool_use_id: null
  };
}

export function buildApprovalResponse(requestId, request, decision) {
  const toolUseId = request?.tool_use_id || request?.toolUseID || request?.toolUseId || '';
  if (decision === 'approve') {
    return {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: 'allow',
          updatedInput: request?.input || {},
          toolUseID: toolUseId,
          decisionClassification: 'user_temporary'
        }
      }
    };
  }

  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        behavior: 'deny',
        message: 'Permission denied by user',
        toolUseID: toolUseId,
        decisionClassification: 'user_reject'
      }
    }
  };
}

export function buildQuestionResponse(requestId, answer) {
  let content;
  if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
    content = answer;
  } else if (answer === null || answer === undefined || answer === '') {
    content = undefined;
  } else {
    content = { answer: String(answer) };
  }

  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        action: 'accept',
        ...(content ? { content } : {})
      }
    }
  };
}

export function writeNdjson(stream, value) {
  if (!stream?.writable) return;
  stream.write(`${JSON.stringify(value)}\n`);
}

export function coerceTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.text) return String(item.text);
        if (item?.type) return String(item.type);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  return '';
}

export function extractAssistantText(message) {
  const direct = coerceTextFromContent(message?.content);
  if (direct) return direct;
  return coerceTextFromContent(message?.message?.content);
}

export function buildApprovalSummary(request) {
  const description = request?.description || request?.title || request?.tool_name || 'Permission request';
  const toolName = request?.tool_name ? `tool=${request.tool_name}` : null;
  return [description, toolName].filter(Boolean).join(' | ');
}

export function createClaudeCodeMessageProcessor({
  onProviderEvent,
  onApprovalRequest,
  onQuestionRequest,
  onSessionPatch,
  closeInput
} = {}) {
  const pendingRequests = new Map();
  let terminalState = null;
  let resultText = '';

  const processMessage = (parsed) => {
    if (parsed?.session_id) {
      onSessionPatch?.({ providerSessionId: parsed.session_id });
    }

    if (parsed?.type === 'assistant') {
      const text = extractAssistantText(parsed);
      if (text) {
        onProviderEvent?.({
          type: AGENT_EVENT_TYPE.MESSAGE,
          payload: {
            text,
            itemType: 'assistant'
          }
        });
      }
      return;
    }

    if (parsed?.type === 'partial_assistant') {
      const text = extractAssistantText(parsed.event) || coerceTextFromContent(parsed?.event?.delta);
      onProviderEvent?.({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: 'partial_assistant',
          text,
          event: parsed.event || null
        }
      });
      return;
    }

    if (parsed?.type === 'system' || parsed?.type === 'status' || parsed?.type === 'tool_progress') {
      onProviderEvent?.({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: parsed.subtype || parsed.type,
          message: parsed.message || null,
          event: parsed
        }
      });
      return;
    }

    if (parsed?.type === 'control_request') {
      const requestId = parsed.request_id || crypto.randomUUID();
      const request = parsed.request || {};
      pendingRequests.set(requestId, request);

      if (request.subtype === 'can_use_tool') {
        onApprovalRequest?.({
          kind: 'tool_permission',
          title: request.title || 'Claude Code permission request',
          summary: buildApprovalSummary(request),
          rawRequest: {
            requestId,
            ...request
          }
        });
        return;
      }

      if (request.subtype === 'elicitation') {
        onQuestionRequest?.({
          questionId: requestId,
          text: request.message || 'Claude Code requires input',
          options: [],
          rawRequest: {
            requestId,
            ...request
          }
        });
        return;
      }

      onProviderEvent?.({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: 'control_request',
          requestId,
          subtype: request.subtype || 'unknown'
        }
      });
      return;
    }

    if (parsed?.type === 'control_response') {
      const requestId = parsed?.response?.request_id;
      if (requestId) {
        pendingRequests.delete(requestId);
      }
      onProviderEvent?.({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: 'control_response',
          response: parsed.response || null
        }
      });
      return;
    }

    if (parsed?.type === 'result') {
      resultText = parsed.result || '';
      closeInput?.();
      if (parsed.is_error) {
        terminalState = {
          status: 'failed',
          error: (Array.isArray(parsed.errors) && parsed.errors[0]) || parsed.result || 'Claude Code execution failed'
        };
        onProviderEvent?.({
          type: AGENT_EVENT_TYPE.FAILED,
          payload: {
            message: terminalState.error
          }
        });
      } else {
        terminalState = {
          status: 'ready',
          summary: resultText ? `Claude Code completed: ${resultText.slice(0, 160)}` : 'Claude Code completed.'
        };
        if (resultText) {
          onProviderEvent?.({
            type: AGENT_EVENT_TYPE.MESSAGE,
            payload: {
              text: resultText,
              itemType: 'result'
            }
          });
        }
        onProviderEvent?.({
          type: AGENT_EVENT_TYPE.COMPLETED,
          payload: {
            result: resultText,
            usage: parsed.usage || null
          }
        });
      }
      return;
    }

    onProviderEvent?.({
      type: AGENT_EVENT_TYPE.PROGRESS,
      payload: {
        phase: parsed?.type || 'unknown',
        event: parsed
      }
    });
  };

  return {
    pendingRequests,
    processMessage,
    getResultText() {
      return resultText;
    },
    getTerminalState() {
      return terminalState;
    }
  };
}

export class ClaudeCodeProvider {
  constructor() {
    this.id = 'claude-code';
    this.capabilities = {
      supportsResume: true,
      supportsStreamingEvents: true,
      supportsApprovalRequests: true,
      supportsInputInjection: true,
      supportsInterrupt: true
    };
  }

  async startTurn({
    session,
    input,
    onProviderEvent,
    onApprovalRequest,
    onQuestionRequest,
    onSessionPatch,
    onTurnFinished,
    onTurnFailed
  }) {
    const args = [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--permission-prompt-tool',
      'stdio'
    ];

    if (session.model) {
      args.push('--model', session.model);
    }

    if (session.providerSessionId) {
      args.push('--resume', session.providerSessionId);
    }

    const spawnSpec = buildSpawnCommand('claude-code', args);

    let child;
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: session.cwd,
        env: { ...process.env }
      });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw buildCliNotFoundError('claude-code', error);
      }
      throw error;
    }

    if (!child.stdin) {
      child.kill();
      throw new Error('Claude Code child process has no stdin');
    }
    if (!child.stdout) {
      child.kill();
      throw new Error('Claude Code child process has no stdout');
    }

    const stderrChunks = [];
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });

    const closeInputIfOpen = () => {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.end();
      }
    };

    const processor = createClaudeCodeMessageProcessor({
      onProviderEvent,
      onApprovalRequest,
      onQuestionRequest,
      onSessionPatch,
      closeInput: closeInputIfOpen
    });

    child.once('error', (error) => {
      rl.close();
      if (error?.code === 'ENOENT') {
        onTurnFailed(buildCliNotFoundError('claude-code', error));
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
          processor.processMessage(parsed);
        }
      } catch (error) {
        onTurnFailed(error);
      }
    })();

    child.once('exit', (code, signal) => {
      rl.close();
      const terminalState = processor.getTerminalState();
      const resultText = processor.getResultText();
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
          summary: resultText ? `Claude Code completed: ${resultText.slice(0, 160)}` : 'Claude Code completed.'
        });
        return;
      }

      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      onTurnFailed(new Error(stderrText || `Claude Code exited with ${detail}`));
    });

    writeNdjson(child.stdin, buildUserMessage(input));

    return {
      pid: child.pid || null,
      async respondApproval({ approval, decision }) {
        const requestId = approval?.rawRequest?.requestId || approval?.rawRequest?.request_id;
        const request = processor.pendingRequests.get(requestId);
        if (!requestId || !request) {
          throw new Error('Pending approval request not found');
        }
        writeNdjson(child.stdin, buildApprovalResponse(requestId, request, decision));
      },
      async respondQuestion({ question, answer }) {
        const requestId = question?.rawRequest?.requestId || question?.rawRequest?.request_id || question?.questionId;
        const request = processor.pendingRequests.get(requestId);
        if (!requestId || !request) {
          throw new Error('Pending question request not found');
        }
        if (request.subtype === 'elicitation') {
          writeNdjson(child.stdin, buildQuestionResponse(requestId, answer));
          return;
        }
        writeNdjson(child.stdin, buildUserMessage(answer));
      },
      cancel() {
        closeInputIfOpen();
        if (!child.killed) {
          child.kill();
        }
      }
    };
  }
}

export default ClaudeCodeProvider;
