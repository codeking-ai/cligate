import assistantDesktopClient from '../desktop/client.js';

// Map raw desktop-agent failures into actionable, recovery-oriented messages
// so the supervisor LLM gets concrete next steps instead of a bare Python
// stringification. ReAct already feeds error structures back through
// stringifyAssistantToolResult, so the model sees this enriched text and can
// chain another tool call (pip install via run_shell_command, list windows,
// capture screen) on the next iteration.
function enrichDesktopError(rawError) {
  const message = String(rawError?.message || rawError || 'desktop tool failed').trim();
  const code = String(rawError?.code || rawError?.payload?.type || '').trim();

  const moduleMatch = /No module named ['"]?([\w.]+)['"]?/i.exec(message);
  if (moduleMatch) {
    const moduleName = moduleMatch[1];
    return [
      message,
      `error_kind: ModuleNotFoundError`,
      `recovery: The desktop-agent Python runtime is missing the "${moduleName}" package.`,
      `next_step: Call run_shell_command with command="pip install ${moduleName}" (user will be asked to approve once unless yolo is on). Then retry the desktop tool. If the user has not enabled yolo, surface this and ask them to run pip install ${moduleName} manually.`
    ].join('\n');
  }

  if (/control not found/i.test(message)) {
    return [
      message,
      `error_kind: ControlNotFound`,
      `recovery: The window exists but no control matched your selector.`,
      `next_step: Before retrying, (a) call desktop_capture_window to see the actual UI, OR (b) call desktop_find_control with broader criteria (omit name, drop class_name, try a different control_type like Pane/Document/Text), OR (c) call desktop_focus_window first to make sure the window is in front.`
    ].join('\n');
  }

  if (/no window matches/i.test(message) || /window not found/i.test(message)) {
    return [
      message,
      `error_kind: WindowNotFound`,
      `next_step: Call desktop_list_windows (no arguments) first to see the exact title strings currently open. Then retry with one of those titles (or the hwnd integer) and match="contains".`
    ].join('\n');
  }

  if (code === 'LEASE_CONFLICT' || /lease busy/i.test(message)) {
    return [
      message,
      `error_kind: LeaseConflict`,
      `next_step: Another desktop action is still running. Wait a moment and retry with the SAME leaseId you used before — different leaseIds will keep colliding.`
    ].join('\n');
  }

  if (code === 'AUTH_REQUIRED' || /authentication required/i.test(message)) {
    return [
      message,
      `error_kind: AuthRequired`,
      `next_step: The desktop-agent token mismatches. Ask the user to stop and start the desktop agent from Dashboard → Settings → Desktop Agent so the token is refreshed.`
    ].join('\n');
  }

  if (/desktop agent is disabled/i.test(message) || code === 'DESKTOP_AGENT_DISABLED') {
    return [
      message,
      `error_kind: DesktopAgentDisabled`,
      `next_step: The user has disabled the desktop agent. Ask them to toggle it on in Dashboard → Settings → Desktop Agent. Do not retry until they confirm.`
    ].join('\n');
  }

  if (/ECONNREFUSED|fetch failed|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return [
      message,
      `error_kind: AgentUnreachable`,
      `next_step: The desktop-agent server is not running. Call desktop_health to confirm. If it stays unreachable, ask the user to start it from Dashboard → Settings → Desktop Agent and check the recentStderr field of /api/desktop-agent/status for the underlying Python error.`
    ].join('\n');
  }

  if (/startfile failed/i.test(message)) {
    return [
      message,
      `error_kind: LaunchFailed`,
      `next_step: The exact path could not be opened by the OS. (a) If you used --path, double-check it exists and is reachable; ask the user for the correct .lnk / .exe path. (b) As a fallback, try desktop_launch_app with query="<app name>" to use Windows Start-menu search.`
    ].join('\n');
  }

  if (/focus failed|SetForegroundWindow/i.test(message)) {
    return [
      message,
      `error_kind: FocusFailed`,
      `next_step: The window could not be brought to the foreground (often due to focus-stealing prevention). Try desktop_list_windows again to make sure the hwnd is still valid, then retry desktop_focus_window. As a last resort, ask the user to click on the target window manually.`
    ].join('\n');
  }

  // Generic unknown error — still hint the model at the diagnostic path.
  return [
    message,
    code ? `error_kind: ${code}` : '',
    `next_step: If the same call fails again, call desktop_health to check the agent is alive, then desktop_list_windows to inspect current state, and finally desktop_capture_window to see the screen before deciding the next semantic action.`
  ].filter(Boolean).join('\n');
}

function wrapHandler(invoke) {
  return async (...args) => {
    try {
      return await invoke(...args);
    } catch (error) {
      const wrapped = new Error(enrichDesktopError(error));
      wrapped.code = error?.code || error?.payload?.type || '';
      wrapped.cause = error;
      wrapped.payload = error?.payload || null;
      throw wrapped;
    }
  };
}

export function createDesktopToolHandlers({
  desktopClient = assistantDesktopClient
} = {}) {
  return {
    desktopHealth: wrapHandler(async () => desktopClient.health()),

    desktopListWindows: wrapHandler(async ({ input = {} } = {}) => desktopClient.listWindows(input)),

    desktopFocusWindow: wrapHandler(async ({ input = {} } = {}) => desktopClient.focusWindow(input)),

    desktopLaunchApp: wrapHandler(async ({ input = {} } = {}) => desktopClient.launchApp(input)),

    desktopCaptureWindow: wrapHandler(async ({ input = {} } = {}) => {
      // Force inline so we always have base64 to feed to the LLM, but keep the
      // user-passed inlineTarget (default 'preview' = downscaled, much smaller
      // than the full screen). Without this the LLM gets a JSON dump containing
      // a giant base64 string in `inline_b64` that it cannot actually parse as
      // an image — emitting a real `image` content block lets it SEE the screen
      // through the same multimodal pipeline that view_image uses.
      const result = await desktopClient.captureWindow({
        ...input,
        inline: true,
        inlineTarget: input?.inlineTarget || 'preview'
      });
      const base64 = String(result?.inline_b64 || '');
      if (base64) {
        // Hide the raw base64 from the JSON shape so the transcript does not
        // double up (giant text blob + image block). Replace with a small flag.
        const { inline_b64: _omit, ...rest } = result;
        return {
          ...rest,
          inline_b64_omitted: true,
          // Anthropic-canonical image block — same shape view_image returns —
          // so the cross-provider translator (multimodal.js) reshapes it for
          // OpenAI Responses while preserving anthropic-native callers.
          content: [{
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: base64
            }
          }]
        };
      }
      return result;
    }),

    desktopFindControl: wrapHandler(async ({ input = {} } = {}) => desktopClient.findControl(input)),

    desktopFindAllControls: wrapHandler(async ({ input = {} } = {}) => desktopClient.findAllControls(input)),

    desktopClickControl: wrapHandler(async ({ input = {} } = {}) => desktopClient.actOnControl({
      ...input,
      act: 'click'
    })),

    desktopSetControlValue: wrapHandler(async ({ input = {} } = {}) => desktopClient.actOnControl({
      ...input,
      act: 'set_value'
    })),

    desktopSendControlKeys: wrapHandler(async ({ input = {} } = {}) => desktopClient.actOnControl({
      ...input,
      act: 'send_keys'
    })),

    desktopGetControlText: wrapHandler(async ({ input = {} } = {}) => desktopClient.actOnControl({
      ...input,
      act: 'get_text'
    })),

    desktopWaitForControl: wrapHandler(async ({ input = {} } = {}) => desktopClient.waitForControl(input)),

    desktopPressKey: wrapHandler(async ({ input = {} } = {}) => desktopClient.pressKey(input)),

    desktopHotkey: wrapHandler(async ({ input = {} } = {}) => desktopClient.hotkey(input)),

    desktopTypeText: wrapHandler(async ({ input = {} } = {}) => desktopClient.typeText(input)),

    desktopClickAt: wrapHandler(async ({ input = {} } = {}) => desktopClient.clickAt(input)),

    desktopMoveMouse: wrapHandler(async ({ input = {} } = {}) => desktopClient.moveMouse(input)),

    desktopScroll: wrapHandler(async ({ input = {} } = {}) => desktopClient.scroll(input)),

    desktopWaitChange: wrapHandler(async ({ input = {} } = {}) => desktopClient.waitChange(input)),

    desktopFindText: wrapHandler(async ({ input = {} } = {}) => desktopClient.findText(input)),

    desktopCursorInfo: wrapHandler(async () => desktopClient.cursorInfo())
  };
}

export { enrichDesktopError };
export default createDesktopToolHandlers;
