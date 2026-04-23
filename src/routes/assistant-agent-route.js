import assistantLlmClient from '../assistant-agent/llm-client.js';

export async function handleGetAssistantAgentStatus(_req, res) {
  try {
    const status = await assistantLlmClient.inspectStatus();
    return res.json({
      success: true,
      status
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export default {
  handleGetAssistantAgentStatus
};
