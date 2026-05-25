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
import createDesktopClickControlToolDefinition from './desktop-click-control.js';
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

export function createBuiltinAssistantToolDefinitions({ workspaceGuard, mcpService = null }) {
  const handlers = {
    ...createFileToolHandlers({ workspaceGuard }),
    ...createSearchToolHandlers({ workspaceGuard }),
    ...createMutationToolHandlers({ workspaceGuard }),
    ...createShellToolHandlers({ workspaceGuard }),
    ...createImageToolHandlers({ workspaceGuard }),
    ...createDesktopToolHandlers(),
    ...createMcpToolHandlers({ mcpService })
  };
  return [
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
    createDesktopClickControlToolDefinition({ handlers }),
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
    createListMcpServersToolDefinition({ handlers }),
    createListMcpToolsToolDefinition({ handlers }),
    createListMcpResourcesToolDefinition({ handlers }),
    createReadMcpResourceToolDefinition({ handlers }),
    createCallMcpToolDefinition({ handlers })
  ];
}

export default createBuiltinAssistantToolDefinitions;
