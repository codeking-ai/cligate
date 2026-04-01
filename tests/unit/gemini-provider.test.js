import test from 'node:test';
import assert from 'node:assert/strict';

import { GeminiProvider } from '../../src/providers/gemini.js';
import { logger } from '../../src/utils/logger.js';

test('GeminiProvider.sendAnthropicRequest downgrades tool_result image content to user multimodal parts', async () => {
  const provider = new GeminiProvider({
    id: 'gemini_vision_1',
    name: 'gemini-test',
    apiKey: 'test-key'
  });

  const originalFetch = global.fetch;
  const originalLoggerInfo = logger.info;
  let capturedUrl = null;
  let capturedBody = null;
  const logged = [];

  logger.info = (...args) => {
    logged.push(args.join(' '));
  };

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: 'The image contains UI text.' }] }
      }],
      usageMetadata: {
        promptTokenCount: 6,
        candidatesTokenCount: 4
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendAnthropicRequest({
      model: 'claude-opus-4-6',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_read_img_1',
              name: 'Read',
              input: { file_path: 'D:\\tmp\\demo.png' }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_read_img_1',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'iVBORw0KGgoAAAANSUhEUgAAAAUA'
                  }
                }
              ]
            }
          ]
        }
      ]
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=test-key');
    assert.equal(capturedBody.contents[0].role, 'model');
    assert.equal(capturedBody.contents[0].parts[0].functionCall.name, 'Read');
    assert.equal(capturedBody.contents[1].role, 'user');
    assert.deepEqual(capturedBody.contents[1].parts[0], {
      inlineData: {
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAUA'
      }
    });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /Downgrading multimodal tool_result to user parts/);
  } finally {
    global.fetch = originalFetch;
    logger.info = originalLoggerInfo;
  }
});
