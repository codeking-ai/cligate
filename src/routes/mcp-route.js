import mcpConnectionManager, { mcpConfigStore } from '../mcp/index.js';

function sendError(res, error, status = 500) {
  return res.status(status).json({
    success: false,
    error: error?.message || String(error || 'request failed')
  });
}

export function handleListMcpServers(_req, res) {
  return res.json({
    success: true,
    servers: mcpConnectionManager.listServers()
  });
}

export async function handleUpsertMcpServer(req, res) {
  try {
    const server = await mcpConnectionManager.upsertServer(req.body || {});
    return res.json({ success: true, server });
  } catch (error) {
    return sendError(res, error, 400);
  }
}

export async function handleDeleteMcpServer(req, res) {
  try {
    const removed = await mcpConnectionManager.removeServer(req.params.name);
    if (!removed) return sendError(res, new Error('MCP server not found'), 404);
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 400);
  }
}

export async function handleSetMcpServerEnabled(req, res) {
  try {
    const server = await mcpConnectionManager.enableServer(req.params.name, req.body?.enabled === true);
    return res.json({ success: true, server });
  } catch (error) {
    return sendError(res, error, 400);
  }
}

export async function handleReloadMcpServer(req, res) {
  try {
    const server = await mcpConnectionManager.reloadServer(req.params.name);
    return res.json({ success: true, server });
  } catch (error) {
    return sendError(res, error, 400);
  }
}

export async function handleReloadMcpServers(_req, res) {
  try {
    await mcpConnectionManager.reloadAll();
    return res.json({
      success: true,
      servers: mcpConnectionManager.listServers()
    });
  } catch (error) {
    return sendError(res, error, 500);
  }
}

export async function handleListMcpServerTools(req, res) {
  try {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (refresh) await mcpConnectionManager.refreshServerTools(req.params.name);
    return res.json({
      success: true,
      tools: mcpConnectionManager.listTools({ serverName: req.params.name })
    });
  } catch (error) {
    return sendError(res, error, 400);
  }
}

export function handleListMcpServerResources(req, res) {
  try {
    return res.json({
      success: true,
      ...mcpConnectionManager.listResources({
        serverName: req.params.name,
        cursor: req.query.cursor
      })
    });
  } catch (error) {
    return sendError(res, error, 400);
  }
}

export async function handleReadMcpServerResource(req, res) {
  try {
    const result = await mcpConnectionManager.readResource({
      serverName: req.params.name,
      uri: req.body?.uri || req.query.uri
    });
    return res.json({ success: true, result });
  } catch (error) {
    return sendError(res, error, 400);
  }
}

export async function handleCallMcpServerTool(req, res) {
  try {
    const result = await mcpConnectionManager.callTool({
      serverName: req.params.name,
      toolName: req.params.toolName,
      arguments: req.body?.arguments || {},
      metadata: req.body?.metadata || {}
    });
    return res.json({ success: true, result });
  } catch (error) {
    return sendError(res, error, 400);
  }
}

export function handleGetMcpConfigFile(_req, res) {
  return res.json({
    success: true,
    file: mcpConfigStore.file
  });
}

