/**
 * Server bootstrap
 * Creates the Express app, middleware, and registers API routes.
 */

import express from 'express';
import cors from 'cors';

import { ensureAccountsPersist, startAutoRefresh } from './account-manager.js';
import { ensureAccountsPersist as ensureClaudeAccountsPersist, startAutoRefresh as startClaudeAutoRefresh } from './claude-account-manager.js';
import { ensureAccountsPersist as ensureAntigravityAccountsPersist, startAutoRefresh as startAntigravityAutoRefresh } from './antigravity-account-manager.js';
import { registerApiRoutes } from './routes/api-routes.js';
import { handleResponses } from './routes/responses-route.js';
import { handleChatUpload } from './routes/chat-uploads-route.js';
import { handleTranscribe, handleTranscribeCapabilities } from './routes/chat-transcribe-route.js';
import { setRequestLoggingEnabled } from './request-logger.js';
import { getServerSettings } from './server-settings.js';
import { startModelDiscovery } from './model-discovery.js';
import agentChannelManager from './agent-channels/manager.js';
import chatUiRuntimeObserver from './chat-ui/runtime-observer.js';
import assistantConsolidator from './assistant-core/consolidator.js';
import localScheduler from './assistant-core/local-scheduler.js';
import assistantRunStore from './assistant-core/run-store.js';
import desktopAgentService from './desktop-agent/service.js';
import mcpConnectionManager from './mcp/index.js';

export function createServer({ port }) {
  ensureAccountsPersist();
  startAutoRefresh();

  // Claude accounts
  ensureClaudeAccountsPersist();
  startClaudeAutoRefresh();

  ensureAntigravityAccountsPersist();
  startAntigravityAutoRefresh();

  // Sync request logging state from persisted settings
  const settings = getServerSettings();
  setRequestLoggingEnabled(settings.enableRequestLogging !== false);

  // Start automatic model discovery (initial + periodic refresh)
  startModelDiscovery();

  const app = express();
  app.locals.port = port;
  app.locals.agentChannelManager = agentChannelManager;
  app.disable('x-powered-by');

  // High-level request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const msg = `[${req.method}] ${req.originalUrl} ${res.statusCode} (${duration}ms)`;
      if (res.statusCode >= 400) {
        console.log(`\x1b[31m${msg}\x1b[0m`); // Red for error
      } else if (req.originalUrl !== '/health') { // Skip health check logs to reduce noise
        console.log(`\x1b[36m${msg}\x1b[0m`); // Cyan for success
      }
    });
    next();
  });

  app.use(cors({
    origin: [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      'http://localhost',
      'http://127.0.0.1'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Content-Encoding',
                     'ChatGPT-Account-ID', 'OpenAI-Organization'],
    credentials: false
  }));

  // Register /responses BEFORE express.json() —
  // Codex CLI sends zstd-compressed bodies that express.json() cannot parse.
  // This route reads the raw body and forwards it as-is.
  app.post('/responses', handleResponses);
  app.post('/responses/compact', handleResponses);
  app.post('/v1/responses', handleResponses);
  app.post('/v1/responses/compact', handleResponses);

  // Chat composer file uploads stream raw bytes straight to disk, so they must
  // also bypass express.json() (10mb cap + in-memory buffering). Same precedent
  // as /responses above. Query params (sessionId/name) are still parsed.
  app.post('/api/chat/uploads', handleChatUpload);

  // Speech-to-text: POST streams raw audio bytes (must bypass express.json);
  // the capabilities GET is registered alongside it for cohesion.
  app.post('/api/chat/transcribe', handleTranscribe);
  app.get('/api/chat/transcribe/capabilities', handleTranscribeCapabilities);

  app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      if (buf?.length) {
        req.rawBody = Buffer.from(buf);
      }
    }
  }));

  registerApiRoutes(app, { port });

  agentChannelManager.start().catch((error) => {
    console.error('[AgentChannel] Failed to start channel manager:', error.message);
  });
  chatUiRuntimeObserver.start();
  assistantConsolidator.start();

  // Recover any scheduled task left stuck in 'running' by a previous process
  // (a hung/interrupted fire). Without this it would never fire again, since
  // the scheduler only fires tasks in state 'scheduled'. Must run BEFORE
  // start() so the recovered task is eligible on the first tick.
  try {
    const recovered = localScheduler.recoverStuckRunningTasks();
    if (recovered > 0) {
      console.log(`[LocalScheduler] recovered ${recovered} scheduled task(s) stuck in 'running' after restart`);
    }
  } catch (error) {
    console.error('[LocalScheduler] stuck-task recovery failed:', error?.message || error);
  }
  localScheduler.start();

  // Retire any long-abandoned non-terminal assistant runs left over from a
  // previous process. A stuck run that never reached a terminal status would
  // otherwise keep being treated as "active" and block new work via the
  // supervisor's concurrent-run rule. Best-effort; never fatal to boot.
  try {
    const swept = assistantRunStore.failStaleNonTerminalRuns();
    if (swept > 0) {
      console.log(`[AssistantCore] retired ${swept} stale non-terminal assistant run(s) at startup`);
    }
  } catch (error) {
    console.error('[AssistantCore] stale-run cleanup failed:', error?.message || error);
  }

  // Compact old terminal assistant runs: archive the full record, then slim the
  // hot copy's heavy metadata (toolResults/checkpoint can reach hundreds of MB).
  // Keeps the hot assistant-runs.json small so per-save full rewrites stay cheap.
  // Best-effort; never fatal to boot. Resumable runs are preserved untouched.
  try {
    const { compacted, reclaimedBytes } = assistantRunStore.compactRuns();
    if (compacted > 0) {
      console.log(`[AssistantCore] compacted ${compacted} old assistant run(s) at startup, reclaimed ~${(reclaimedBytes / 1e6).toFixed(1)}MB`);
    }
  } catch (error) {
    console.error('[AssistantCore] run compaction failed:', error?.message || error);
  }
  mcpConnectionManager.start().catch((error) => {
    console.error('[MCP] Failed to start MCP connection manager:', error.message);
  });

  // Pre-warm the CliGate-OWNED desktop agent ONLY if the user explicitly opted
  // in (both flags default to false). This spawns a child process that lives and
  // dies with CliGate (see server close handler below) — it never installs
  // scheduled tasks or touches Windows session/RDP state. Machine-level desktop
  // preparation is a separate, explicit, admin-only path (capture-setup).
  if (settings.desktopAgent?.enabled === true && settings.desktopAgent?.autoStart === true) {
    desktopAgentService.start().catch((error) => {
      console.error('[DesktopAgent] Failed to auto-start desktop agent:', error.message);
    });
  }

  // Global error handler — catches unhandled errors in route handlers
  app.use((err, req, res, _next) => {
    console.error(`[Server] Unhandled error on ${req.method} ${req.originalUrl}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ type: 'error', error: { type: 'server_error', message: err.message } });
    }
  });

  return app;
}

export function startServer({ port }) {
  const app = createServer({ port });
  const server = app.listen(port);
  server.on('close', () => {
    desktopAgentService.stop().catch(() => {});
    agentChannelManager.stop().catch(() => {});
    chatUiRuntimeObserver.stop();
    assistantConsolidator.stop();
    localScheduler.stop();
    mcpConnectionManager.stop().catch(() => {});
  });
  return server;
}

export default { createServer, startServer };
