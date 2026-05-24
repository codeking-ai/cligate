import {
  buildNamespacedMcpToolName,
  parseNamespacedMcpToolName
} from '../mcp-service.js';

export function createMcpToolHandlers({ mcpService = null }) {
  const requireService = () => {
    if (!mcpService) {
      throw new Error('MCP service is not configured');
    }
    return mcpService;
  };

  return {
    async listMcpServers() {
      return {
        servers: requireService().listServers()
      };
    },

    async listMcpTools({ input = {} } = {}) {
      return {
        tools: requireService().listTools({
          serverName: input.serverName
        })
      };
    },

    async listMcpResources({ input = {} } = {}) {
      return requireService().listResources({
        serverName: input.serverName,
        cursor: input.cursor
      });
    },

    async readMcpResource({ input = {} } = {}) {
      return {
        serverName: input.serverName,
        uri: input.uri,
        resource: requireService().readResource({
          serverName: input.serverName,
          uri: input.uri
        })
      };
    },

    async callMcpTool({ input = {} } = {}) {
      let serverName = String(input.serverName || '').trim();
      let toolName = String(input.toolName || '').trim();
      if (!serverName || !toolName) {
        const parsed = parseNamespacedMcpToolName(input.namespacedToolName);
        if (!parsed) {
          throw new Error('call_mcp_tool requires serverName/toolName or namespacedToolName');
        }
        serverName = parsed.serverName;
        toolName = parsed.toolName;
      }
      const result = await requireService().callTool({
        serverName,
        toolName,
        arguments: input.arguments || {},
        metadata: input.metadata || {}
      });
      return {
        serverName,
        toolName,
        namespacedToolName: buildNamespacedMcpToolName(serverName, toolName),
        result
      };
    }
  };
}

export default createMcpToolHandlers;
