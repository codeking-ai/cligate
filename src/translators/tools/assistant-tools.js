import { sanitizeToolSchema } from '../normalizers/schemas.js';
import { convertAnthropicToolsToOpenAIResponses } from '../normalizers/tools.js';

function normalizeList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function shouldIncludeByVisibility(tool, visibilities) {
  if (visibilities.length === 0) {
    return true;
  }
  return visibilities.includes(String(tool?.visibility || '').trim());
}

function shouldIncludeBySource(tool, sources) {
  if (sources.length === 0) {
    return true;
  }
  return sources.includes(String(tool?.source || '').trim());
}

function shouldIncludeByApproval(tool, includeApprovalRequired) {
  if (includeApprovalRequired) {
    return true;
  }
  return tool?.requiresApproval !== true;
}

export function listAssistantToolDefinitions(toolRegistry, options = {}) {
  const visibilities = normalizeList(options.visibilities);
  const sources = normalizeList(options.sources);
  const names = new Set(normalizeList(options.names));
  return toolRegistry.list().filter((tool) => {
    if (names.size > 0 && !names.has(tool.name)) {
      return false;
    }
    if (!shouldIncludeByVisibility(tool, visibilities)) {
      return false;
    }
    if (!shouldIncludeBySource(tool, sources)) {
      return false;
    }
    if (!shouldIncludeByApproval(tool, options.includeApprovalRequired === true)) {
      return false;
    }
    return true;
  });
}

export function buildAssistantAnthropicToolDefinitions(toolRegistry, options = {}) {
  return listAssistantToolDefinitions(toolRegistry, options).map((tool) => ({
    name: tool.name,
    description: tool.description || tool.name,
    input_schema: sanitizeToolSchema(tool.inputSchema || { type: 'object', properties: {} })
  }));
}

export function buildAssistantOpenAIResponsesToolDefinitions(toolRegistry, options = {}) {
  const anthropicTools = buildAssistantAnthropicToolDefinitions(toolRegistry, options);
  return convertAnthropicToolsToOpenAIResponses(anthropicTools, {
    unsupportedHostedToolsAction: 'omit'
  }).tools;
}

export function buildAssistantOpenAIChatToolDefinitions(toolRegistry, options = {}) {
  return buildAssistantOpenAIResponsesToolDefinitions(toolRegistry, options).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} }
    }
  }));
}

export function buildAssistantGeminiToolDefinitions(toolRegistry, options = {}) {
  const anthropicTools = buildAssistantAnthropicToolDefinitions(toolRegistry, options);
  if (anthropicTools.length === 0) {
    return [];
  }
  return [{
    functionDeclarations: anthropicTools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      parameters: sanitizeToolSchema(tool.input_schema || { type: 'object', properties: {} })
    }))
  }];
}

export default {
  listAssistantToolDefinitions,
  buildAssistantAnthropicToolDefinitions,
  buildAssistantOpenAIResponsesToolDefinitions,
  buildAssistantOpenAIChatToolDefinitions,
  buildAssistantGeminiToolDefinitions
};
