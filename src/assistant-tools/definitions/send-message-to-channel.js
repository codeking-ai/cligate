export function createSendMessageToChannelToolDefinition({ handlers }) {
  return {
    name: 'send_message_to_channel',
    description: 'Deliver a message — text and/or an image — to a chat channel conversation (DingTalk, etc.). By default it sends to the CURRENT conversation (the channel the user is talking to you on), so use this to proactively push a result, a screenshot, or a file back to the user. To send an image, pass imagePath (a local image file path) OR imageArtifactId (preferred for assistant-captured images such as the `imageArtifactId` returned by desktop_capture_window or view_image); use one, not both. This is the EXPLICIT way to send an image to the user — screenshots are never auto-sent, so if the user asks you to "send the screenshot", you must call this tool. Image delivery works on DingTalk, Feishu, and Telegram; on any other channel without image support the text is delivered and the result reports imageDelivered=false.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send. Optional if an image is provided.' },
        imagePath: { type: 'string', description: 'Local file path of an image to send.' },
        imageArtifactId: { type: 'string', description: 'Artifact id of an image to send. Preferred for assistant-captured images such as desktop_capture_window / view_image results. Use either imagePath or imageArtifactId, not both.' },
        targetConversationId: { type: 'string', description: 'Optional. Defaults to the current conversation. Must be an existing conversation id.' }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.sendMessageToChannel
  };
}

export default createSendMessageToChannelToolDefinition;
