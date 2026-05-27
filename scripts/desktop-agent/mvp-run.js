import createBuiltinAssistantToolRegistry, {
  AssistantToolPolicyService,
  AssistantToolsExecutor
} from '../../src/assistant-tools/index.js';

function parseArgs(argv = []) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith('--')) {
      result[key] = next;
      i += 1;
    } else {
      result[key] = 'true';
    }
  }
  return result;
}

async function runTool(executor, toolName, input, context) {
  const result = await executor.executeToolCall({
    toolName,
    input
  }, context);
  if (result.status !== 'completed') {
    const error = new Error(`${toolName} failed: ${result.structured?.error || result.structured?.reason || result.status}`);
    error.result = result;
    throw error;
  }
  return result.structured;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot = process.cwd();
  const leaseId = String(args.lease || 'desktop-mvp').trim();
  const windowTitle = String(args.windowTitle || args.window || '').trim();
  const launchPath = String(args.path || '').trim();
  const launchQuery = String(args.query || '').trim();
  const promptText = String(args.text || '').trim();
  const inputControlName = String(args.inputName || '').trim();
  const outputControlName = String(args.outputName || '').trim();
  const inputControlType = String(args.inputType || 'Edit').trim();
  const outputControlType = String(args.outputType || 'Text').trim();
  const waitMs = Number.parseInt(args.waitMs || '10000', 10);

  if (!windowTitle) {
    throw new Error('--windowTitle is required');
  }
  if (!promptText) {
    throw new Error('--text is required');
  }
  if (!launchPath && !launchQuery) {
    throw new Error('one of --path or --query is required');
  }

  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({ workspaceRoot });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({
      workspaceGuard,
      allowMutatingTools: true
    })
  });
  const context = {
    cwd: workspaceRoot
  };

  const launch = await runTool(executor, 'desktop_launch_app', {
    ...(launchPath ? { path: launchPath } : { query: launchQuery }),
    leaseId,
    actionId: 'launch'
  }, context);

  const focus = await runTool(executor, 'desktop_focus_window', {
    title: windowTitle,
    match: 'contains',
    leaseId,
    actionId: 'focus'
  }, context);

  const windowHwnd = focus?.window?.hwnd || focus?.window?.handle || 0;
  if (!windowHwnd) {
    throw new Error('unable to resolve focused window hwnd');
  }

  const inputControl = await runTool(executor, 'desktop_find_control', {
    windowHwnd,
    controlType: inputControlType,
    ...(inputControlName ? { name: inputControlName } : {}),
    timeoutMs: 15000,
    actionId: 'find-input'
  }, context);

  const setValue = await runTool(executor, 'desktop_set_control_value', {
    windowHwnd,
    controlType: inputControlType,
    ...(inputControlName ? { name: inputControlName } : {}),
    text: promptText,
    leaseId,
    actionId: 'set-value'
  }, context);

  const send = await runTool(executor, 'desktop_send_control_keys', {
    windowHwnd,
    controlType: inputControlType,
    ...(inputControlName ? { name: inputControlName } : {}),
    keys: '{Enter}',
    leaseId,
    actionId: 'send-enter'
  }, context);

  const waited = await runTool(executor, 'desktop_wait_for_control', {
    windowHwnd,
    controlType: outputControlType,
    ...(outputControlName ? { name: outputControlName } : {}),
    timeoutMs: waitMs,
    actionId: 'wait-output'
  }, context);

  const output = await runTool(executor, 'desktop_get_control_text', {
    windowHwnd,
    controlType: outputControlType,
    ...(outputControlName ? { name: outputControlName } : {}),
    timeoutMs: waitMs,
    actionId: 'read-output'
  }, context);

  const capture = await runTool(executor, 'desktop_capture_window', {
    windowHwnd,
    inline: true,
    inlineTarget: 'preview',
    leaseId,
    actionId: 'capture'
  }, context);

  const summary = {
    ok: true,
    leaseId,
    launch,
    focus,
    inputControl,
    setValue,
    send,
    waited,
    output,
    capture: {
      action: capture?.action,
      width: capture?.width,
      height: capture?.height,
      preview: capture?.preview,
      inlineTarget: capture?.inline_target || capture?.inlineTarget || ''
    }
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  const result = error?.result || null;
  console.error(JSON.stringify({
    ok: false,
    error: String(error?.message || error),
    result
  }, null, 2));
  process.exitCode = 1;
});
