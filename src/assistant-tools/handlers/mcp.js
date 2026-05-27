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
  const resolveToolIdentity = (service, serverName, toolName, { fromNamespaced = false } = {}) => {
    const fallbackNamespacedToolName = buildNamespacedMcpToolName(serverName, toolName);
    const tools = service.listTools?.({ serverName }) || [];
    const tool = fromNamespaced
      ? tools.find((entry) => entry?.namespacedToolName === fallbackNamespacedToolName)
      : tools.find((entry) => entry?.toolName === toolName);
    return {
      toolName: tool?.toolName || toolName,
      namespacedToolName: tool?.namespacedToolName || fallbackNamespacedToolName
    };
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
      let fromNamespaced = false;
      if (!serverName || !toolName) {
        const parsed = parseNamespacedMcpToolName(input.namespacedToolName);
        if (!parsed) {
          throw new Error('call_mcp_tool requires serverName/toolName or namespacedToolName');
        }
        serverName = parsed.serverName;
        toolName = parsed.toolName;
        fromNamespaced = true;
      }
      const service = requireService();
      const identity = resolveToolIdentity(service, serverName, toolName, { fromNamespaced });
      toolName = identity.toolName;
      const result = await service.callTool({
        serverName,
        toolName,
        arguments: input.arguments || {},
        metadata: input.metadata || {}
      });
      return {
        serverName,
        toolName,
        namespacedToolName: identity.namespacedToolName,
        result
      };
    },

    async callDirectMcpTool({ input = {}, tool = {} } = {}) {
      const serverName = String(tool?.metadata?.mcp?.serverName || '').trim();
      const toolName = String(tool?.metadata?.mcp?.toolName || '').trim();
      if (!serverName || !toolName) {
        throw new Error('direct MCP tool is missing raw server/tool metadata');
      }
      const result = await requireService().callTool({
        serverName,
        toolName,
        arguments: input || {},
        metadata: {}
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
