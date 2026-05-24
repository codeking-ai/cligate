import createListDirectoryToolDefinition from './list-directory.js';
import createReadFileToolDefinition from './read-file.js';
import createStatPathToolDefinition from './stat-path.js';
import createGlobSearchToolDefinition from './glob-search.js';
import createGrepSearchToolDefinition from './grep-search.js';
import createWriteFileToolDefinition from './write-file.js';
import createReplaceInFileToolDefinition from './replace-in-file.js';
import createRunShellCommandToolDefinition from './run-shell-command.js';
import createViewImageToolDefinition from './view-image.js';
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

export function createBuiltinAssistantToolDefinitions({ workspaceGuard, mcpService = null }) {
  const handlers = {
    ...createFileToolHandlers({ workspaceGuard }),
    ...createSearchToolHandlers({ workspaceGuard }),
    ...createMutationToolHandlers({ workspaceGuard }),
    ...createShellToolHandlers({ workspaceGuard }),
    ...createImageToolHandlers({ workspaceGuard }),
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
    createListMcpServersToolDefinition({ handlers }),
    createListMcpToolsToolDefinition({ handlers }),
    createListMcpResourcesToolDefinition({ handlers }),
    createReadMcpResourceToolDefinition({ handlers }),
    createCallMcpToolDefinition({ handlers })
  ];
}

export default createBuiltinAssistantToolDefinitions;
