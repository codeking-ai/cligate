const TOOL_SCHEMAS = Object.freeze({
  get_workspace_context: {
    type: 'object',
    properties: {
      runtimeLimit: { type: 'integer', minimum: 1, maximum: 20 },
      conversationLimit: { type: 'integer', minimum: 1, maximum: 20 }
    }
  },
  list_runtime_sessions: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      status: { type: 'string' }
    }
  },
  get_runtime_session: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      eventLimit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    required: ['sessionId']
  },
  list_conversations: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      mode: { type: 'string' }
    }
  },
  get_conversation_context: {
    type: 'object',
    properties: {
      conversationId: { type: 'string' },
      deliveryLimit: { type: 'integer', minimum: 1, maximum: 50 }
    },
    required: ['conversationId']
  },
  list_tasks: {
    type: 'object',
    properties: {
      conversationId: { type: 'string' },
      state: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20 }
    }
  },
  get_task: {
    type: 'object',
    properties: {
      taskId: { type: 'string' }
    },
    required: ['taskId']
  },
  search_task_and_conversation_memory: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20 }
    },
    required: ['query']
  },
  search_project_memory: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20 }
    },
    required: ['query']
  },
  delegate_to_codex: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' }
    },
    required: ['task']
  },
  delegate_to_claude_code: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' }
    },
    required: ['task']
  },
  delegate_to_runtime: {
    type: 'object',
    properties: {
      provider: { type: 'string', enum: ['codex', 'claude-code'] },
      task: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' }
    },
    required: ['provider', 'task']
  },
  reuse_or_delegate: {
    type: 'object',
    properties: {
      provider: { type: 'string', enum: ['codex', 'claude-code'] },
      sessionId: { type: 'string' },
      task: { type: 'string' },
      message: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' }
    }
  },
  send_runtime_input: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      message: { type: 'string' }
    },
    required: ['sessionId', 'message']
  },
  cancel_runtime_session: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' }
    },
    required: ['sessionId']
  },
  reset_conversation_binding: {
    type: 'object',
    properties: {
      conversationId: { type: 'string' }
    },
    required: ['conversationId']
  },
  resolve_runtime_approval: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      approvalId: { type: 'string' },
      decision: { type: 'string', enum: ['approve', 'deny'] }
    },
    required: ['sessionId', 'approvalId', 'decision']
  },
  answer_runtime_question: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      questionId: { type: 'string' },
      answer: { type: 'string' }
    },
    required: ['sessionId', 'questionId', 'answer']
  },
  summarize_runtime_result: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      eventLimit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    required: ['sessionId']
  }
});

export function buildAnthropicToolDefinitions(toolRegistry) {
  return toolRegistry.list().map((tool) => ({
    name: tool.name,
    description: tool.description || tool.name,
    input_schema: TOOL_SCHEMAS[tool.name] || {
      type: 'object',
      properties: {}
    }
  }));
}

export default {
  buildAnthropicToolDefinitions
};
