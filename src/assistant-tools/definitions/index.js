import createListDirectoryToolDefinition from './list-directory.js';
import createReadFileToolDefinition from './read-file.js';
import createStatPathToolDefinition from './stat-path.js';
import createGlobSearchToolDefinition from './glob-search.js';
import createGrepSearchToolDefinition from './grep-search.js';
import createWriteFileToolDefinition from './write-file.js';
import createReplaceInFileToolDefinition from './replace-in-file.js';
import createRunShellCommandToolDefinition from './run-shell-command.js';
import createViewImageToolDefinition from './view-image.js';
import createDesktopHealthToolDefinition from './desktop-health.js';
import createDesktopListWindowsToolDefinition from './desktop-list-windows.js';
import createDesktopLaunchAppToolDefinition from './desktop-launch-app.js';
import createDesktopFocusWindowToolDefinition from './desktop-focus-window.js';
import createDesktopFindControlToolDefinition from './desktop-find-control.js';
import createDesktopFindAllControlsToolDefinition from './desktop-find-all-controls.js';
import createDesktopInspectWindowToolDefinition from './desktop-inspect-window.js';
import createDesktopClickControlToolDefinition from './desktop-click-control.js';
import createDesktopClickTextToolDefinition from './desktop-click-text.js';
import createDesktopFillTextFieldToolDefinition from './desktop-fill-text-field.js';
import createDesktopSetControlValueToolDefinition from './desktop-set-control-value.js';
import createDesktopSendControlKeysToolDefinition from './desktop-send-control-keys.js';
import createDesktopGetControlTextToolDefinition from './desktop-get-control-text.js';
import createDesktopWaitForControlToolDefinition from './desktop-wait-for-control.js';
import createDesktopCaptureWindowToolDefinition from './desktop-capture-window.js';
import createDesktopPressKeyToolDefinition from './desktop-press-key.js';
import createDesktopHotkeyToolDefinition from './desktop-hotkey.js';
import createDesktopTypeTextToolDefinition from './desktop-type-text.js';
import createDesktopClickAtToolDefinition from './desktop-click-at.js';
import createDesktopMoveMouseToolDefinition from './desktop-move-mouse.js';
import createDesktopScrollToolDefinition from './desktop-scroll.js';
import createDesktopWaitChangeToolDefinition from './desktop-wait-change.js';
import createDesktopFindTextToolDefinition from './desktop-find-text.js';
import createDesktopCursorInfoToolDefinition from './desktop-cursor-info.js';
import createCancelAssistantRunToolDefinition from './cancel-assistant-run.js';
import createSendMessageToChannelToolDefinition from './send-message-to-channel.js';
import createDesktopWaitForFileToolDefinition from './desktop-wait-for-file.js';
import createDesktopWaitForProcessToolDefinition from './desktop-wait-for-process.js';
import createDesktopWaitForWindowToolDefinition from './desktop-wait-for-window.js';
import createListMcpServersToolDefinition from './list-mcp-servers.js';
import createListMcpToolsToolDefinition from './list-mcp-tools.js';
import createListMcpResourcesToolDefinition from './list-mcp-resources.js';
import createReadMcpResourceToolDefinition from './read-mcp-resource.js';
import createCallMcpToolDefinition from './call-mcp-tool.js';
import createFileToolHandlers from '../handlers/files.js';
import createSearchToolHandlers from '../handlers/search.js';
import createMutationToolHandlers from '../handlers/mutations.js';
import createShellToolHandlers from '../handlers/shell.js';
import createImageToolHandlers from '../handlers/images.js';
import createMcpToolHandlers from '../handlers/mcp.js';
import createDesktopToolHandlers from '../handlers/desktop.js';
import createAssistantRunToolHandlers from '../handlers/assistant-runs.js';
import createMessagingToolHandlers from '../handlers/messaging.js';
import createDesktopWaitToolHandlers from '../handlers/desktop-wait.js';
import { buildNamespacedMcpToolName } from '../mcp-service.js';

function createDirectMcpToolDefinitions({ mcpService = null, handlers = {} } = {}) {
  if (!mcpService) return [];
  const definitions = [];
  const seen = new Set();
  const servers = mcpService.listServers?.() || [];
  for (const server of servers) {
    const serverName = String(server?.name || '').trim();
    if (!serverName) continue;
    let tools = [];
    try {
      tools = mcpService.listTools({ serverName }) || [];
    } catch {
      continue;
    }
    for (const tool of tools) {
      const toolName = String(tool?.toolName || tool?.name || '').trim();
      if (!toolName) continue;
      const namespacedToolName = tool?.namespacedToolName || buildNamespacedMcpToolName(serverName, toolName);
      if (seen.has(namespacedToolName)) continue;
      seen.add(namespacedToolName);
      definitions.push({
        name: namespacedToolName,
        description: String(tool?.description || `Call MCP tool ${serverName}/${toolName}`).trim(),
        inputSchema: tool?.inputSchema || { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
        visibility: 'direct',
        mutating: true,
        requiresApproval: true,
        parallelSafe: false,
        source: 'mcp',
        metadata: {
          mcp: {
            direct: true,
            serverName,
            toolName,
            namespacedToolName
          }
        },
        execute: handlers.callDirectMcpTool
      });
    }
  }
  return definitions;
}

export function createBuiltinAssistantToolDefinitions({ workspaceGuard, mcpService = null }) {
  const handlers = {
    ...createFileToolHandlers({ workspaceGuard }),
    ...createSearchToolHandlers({ workspaceGuard }),
    ...createMutationToolHandlers({ workspaceGuard }),
    ...createShellToolHandlers({ workspaceGuard }),
    ...createImageToolHandlers({ workspaceGuard }),
    ...createDesktopToolHandlers(),
    ...createDesktopWaitToolHandlers(),
    ...createAssistantRunToolHandlers(),
    ...createMessagingToolHandlers(),
    ...createMcpToolHandlers({ mcpService })
  };
  const definitions = [
    createListDirectoryToolDefinition({ handlers }),
    createReadFileToolDefinition({ handlers }),
    createStatPathToolDefinition({ handlers }),
    createGlobSearchToolDefinition({ handlers }),
    createGrepSearchToolDefinition({ handlers }),
    createWriteFileToolDefinition({ handlers }),
    createReplaceInFileToolDefinition({ handlers }),
    createRunShellCommandToolDefinition({ handlers }),
    createViewImageToolDefinition({ handlers }),
    createDesktopHealthToolDefinition({ handlers }),
    createDesktopListWindowsToolDefinition({ handlers }),
    createDesktopLaunchAppToolDefinition({ handlers }),
    createDesktopFocusWindowToolDefinition({ handlers }),
    createDesktopFindControlToolDefinition({ handlers }),
    createDesktopFindAllControlsToolDefinition({ handlers }),
    createDesktopInspectWindowToolDefinition({ handlers }),
    createDesktopClickControlToolDefinition({ handlers }),
    createDesktopClickTextToolDefinition({ handlers }),
    createDesktopFillTextFieldToolDefinition({ handlers }),
    createDesktopSetControlValueToolDefinition({ handlers }),
    createDesktopSendControlKeysToolDefinition({ handlers }),
    createDesktopGetControlTextToolDefinition({ handlers }),
    createDesktopWaitForControlToolDefinition({ handlers }),
    createDesktopCaptureWindowToolDefinition({ handlers }),
    createDesktopPressKeyToolDefinition({ handlers }),
    createDesktopHotkeyToolDefinition({ handlers }),
    createDesktopTypeTextToolDefinition({ handlers }),
    createDesktopClickAtToolDefinition({ handlers }),
    createDesktopMoveMouseToolDefinition({ handlers }),
    createDesktopScrollToolDefinition({ handlers }),
    createDesktopWaitChangeToolDefinition({ handlers }),
    createDesktopFindTextToolDefinition({ handlers }),
    createDesktopCursorInfoToolDefinition({ handlers }),
    createDesktopWaitForFileToolDefinition({ handlers }),
    createDesktopWaitForProcessToolDefinition({ handlers }),
    createDesktopWaitForWindowToolDefinition({ handlers }),
    createCancelAssistantRunToolDefinition({ handlers }),
    createSendMessageToChannelToolDefinition({ handlers })
  ];
  if (mcpService) {
    definitions.push(
      createListMcpServersToolDefinition({ handlers }),
      createListMcpToolsToolDefinition({ handlers }),
      createListMcpResourcesToolDefinition({ handlers }),
      createReadMcpResourceToolDefinition({ handlers }),
      createCallMcpToolDefinition({ handlers }),
      ...createDirectMcpToolDefinitions({ mcpService, handlers })
    );
  }
  return definitions;
}

export default createBuiltinAssistantToolDefinitions;
