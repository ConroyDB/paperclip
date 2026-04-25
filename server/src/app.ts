import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { missionControlProxy } from "./middleware/mission-control-proxy.js";
import { healthRoutes } from "./routes/health.js";
import { companyRoutes } from "./routes/companies.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { routineRoutes } from "./routes/routines.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { goalRoutes } from "./routes/goals.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { sidebarPreferenceRoutes } from "./routes/sidebar-preferences.js";
import { inboxDismissalRoutes } from "./routes/inbox-dismissals.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import { llmRoutes } from "./routes/llms.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { pluginRoutes } from "./routes/plugins.js";
import { adapterRoutes } from "./routes/adapters.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { applyUiBranding } from "./ui-branding.js";
import { getWarRoomHtml } from "./warroom-html.js";
import { logger } from "./middleware/logger.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "./services/plugin-loader.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { createPluginToolDispatcher } from "./services/plugin-tool-dispatcher.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { createPluginJobCoordinator } from "./services/plugin-job-coordinator.js";
import { buildHostServices, flushPluginLogBuffer } from "./services/plugin-host-services.js";
import { createPluginEventBus } from "./services/plugin-event-bus.js";
import { setPluginEventBus } from "./services/activity-log.js";
import { createPluginDevWatcher } from "./services/plugin-dev-watcher.js";
import { createPluginHostServiceCleanup } from "./services/plugin-host-service-cleanup.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";
import { createCachedViteHtmlRenderer } from "./vite-html-renderer.js";

type UiMode = "none" | "static" | "vite-dev";
const FEEDBACK_EXPORT_FLUSH_INTERVAL_MS = 5_000;
const VITE_DEV_ASSET_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/assets/",
  "/node_modules/",
  "/src/",
];
const VITE_DEV_STATIC_PATHS = new Set([
  "/apple-touch-icon.png",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/favicon.ico",
  "/favicon.svg",
  "/site.webmanifest",
  "/sw.js",
]);

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
}

export function shouldServeViteDevHtml(req: ExpressRequest): boolean {
  const pathname = req.path;
  if (VITE_DEV_STATIC_PATHS.has(pathname)) return false;
  if (VITE_DEV_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  return req.accepts(["html"]) === "html";
}

export function shouldEnablePrivateHostnameGuard(opts: {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
}): boolean {
  return (
    opts.deploymentExposure === "private" &&
    (opts.deploymentMode === "local_trusted" || opts.deploymentMode === "authenticated")
  );
}

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    serverPort: number;
    storageService: StorageService;
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    instanceId?: string;
    hostVersion?: string;
    localPluginDir?: string;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const app = express();

  app.use(express.json({
    // Company import/export payloads can inline full portable packages.
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  app.use(httpLogger);
  const privateHostnameGateEnabled = shouldEnablePrivateHostnameGuard({
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
  });
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });
  app.use(
    privateHostnameGuard({
      enabled: privateHostnameGateEnabled,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    }),
  );
  app.use(
    actorMiddleware(db, {
      deploymentMode: opts.deploymentMode,
      resolveSession: opts.resolveSession,
    }),
  );
  // Mission Control v2 reverse proxy. Only intercepts requests that carry the
  // `x-api-key` header matching MC_API_KEY — Paperclip's own UI is untouched.
  // Forwards /api/agents, /api/agents/*, /api/factory-floor/state to
  // http://localhost:3007 (configurable via MC_PROXY_TARGET).
  app.use(missionControlProxy());
  app.get("/api/auth/get-session", (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json({
      session: {
        id: `paperclip:${req.actor.source}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user: {
        id: req.actor.userId,
        email: null,
        name: req.actor.source === "local_implicit" ? "Local Board" : null,
      },
    });
  });
  if (opts.betterAuthHandler) {
    app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));

  // Mount API routes
  const api = Router();
  api.use(boardMutationGuard());
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
    }),
  );
  api.use("/companies", companyRoutes(db, opts.storageService));
  api.use(companySkillRoutes(db));
  api.use(agentRoutes(db));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService, {
    feedbackExportService: opts.feedbackExportService,
  }));
  api.use(routineRoutes(db));
  api.use(executionWorkspaceRoutes(db));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db));
  api.use(secretRoutes(db));
  api.use(costRoutes(db));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(sidebarPreferenceRoutes(db));
  api.use(inboxDismissalRoutes(db));
  api.use(instanceSettingsRoutes(db));
  const hostServicesDisposers = new Map<string, () => void>();
  const workerManager = createPluginWorkerManager();
  const pluginRegistry = pluginRegistryService(db);
  const eventBus = createPluginEventBus();
  setPluginEventBus(eventBus);
  const jobStore = pluginJobStore(db);
  const lifecycle = pluginLifecycleManager(db, { workerManager });
  const scheduler = createPluginJobScheduler({
    db,
    jobStore,
    workerManager,
  });
  const toolDispatcher = createPluginToolDispatcher({
    workerManager,
    lifecycleManager: lifecycle,
    db,
  });
  const jobCoordinator = createPluginJobCoordinator({
    db,
    lifecycle,
    scheduler,
    jobStore,
  });
  const hostServiceCleanup = createPluginHostServiceCleanup(lifecycle, hostServicesDisposers);
  let viteHtmlRenderer: ReturnType<typeof createCachedViteHtmlRenderer> | null = null;
  const loader = pluginLoader(
    db,
    { localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR },
    {
      workerManager,
      eventBus,
      jobScheduler: scheduler,
      jobStore,
      toolDispatcher,
      lifecycleManager: lifecycle,
      instanceInfo: {
        instanceId: opts.instanceId ?? "default",
        hostVersion: opts.hostVersion ?? "0.0.0",
      },
      buildHostHandlers: (pluginId, manifest) => {
        const notifyWorker = (method: string, params: unknown) => {
          const handle = workerManager.getWorker(pluginId);
          if (handle) handle.notify(method, params);
        };
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker);
        hostServicesDisposers.set(pluginId, () => services.dispose());
        return createHostClientHandlers({
          pluginId,
          capabilities: manifest.capabilities,
          services,
        });
      },
    },
  );
  api.use(
    pluginRoutes(
      db,
      loader,
      { scheduler, jobStore },
      { workerManager },
      { toolDispatcher },
      { workerManager },
    ),
  );
  api.use(adapterRoutes());
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    }),
  );
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  app.use(pluginUiStaticRoutes(db, {
    localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
  }));

  if (process.env.WARROOM_ENABLED === 'true') {
    const warroomPort = parseInt(process.env.WARROOM_PORT || '7860', 10);
    const __warroomDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'warroom');
    const warroomVoicesPath = path.join(__warroomDir, 'voices.json');
    const warroomPinPath = '/tmp/warroom-pin.json';

    // Load voices.json to build agent roster
    function loadWarroomAgents(): Array<{ id: string; name: string; description: string }> {
      try {
        const raw = JSON.parse(fs.readFileSync(warroomVoicesPath, 'utf-8'));
        return Object.entries(raw).map(([id, cfg]: [string, any]) => ({
          id,
          name: cfg.name || id,
          description: cfg.description || '',
        }));
      } catch {
        return [];
      }
    }

    // Write agent roster to /tmp so Python server can read it
    try {
      const roster = loadWarroomAgents();
      fs.writeFileSync('/tmp/warroom-agents.json', JSON.stringify(roster, null, 2), 'utf-8');
    } catch { /* non-fatal */ }

    function readPinState(): { agent: string; mode: string } {
      try {
        const data = JSON.parse(fs.readFileSync(warroomPinPath, 'utf-8'));
        return { agent: data.agent || 'yano-langley', mode: data.mode || 'direct' };
      } catch {
        return { agent: 'yano-langley', mode: 'direct' };
      }
    }

    async function killWarroomAsync(): Promise<void> {
      const { spawn } = await import('child_process');
      const pids: number[] = await new Promise((resolve) => {
        const p = spawn('pgrep', ['-f', 'warroom/server.py']);
        let out = '';
        p.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
        p.on('close', () => resolve(out.trim().split(/\s+/).map(Number).filter(Number.isFinite)));
        p.on('error', () => resolve([]));
      });
      for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    }

    app.get('/warroom', (req, res) => {
      const token = process.env.WARROOM_TOKEN || 'warroom-cbi';
      const chatId = (req.query['chatId'] as string) || '';
      res.status(200).set('Content-Type', 'text/html').set('Cache-Control', 'no-cache').end(
        getWarRoomHtml(token, chatId, warroomPort)
      );
    });

    // Serve agent avatars from warroom/avatars/
    app.get('/warroom-avatar/:id', (req, res) => {
      const id = (req.params['id'] || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const avatarPath = path.join(__warroomDir, 'avatars', `${id}.png`);
      if (fs.existsSync(avatarPath)) {
        res.sendFile(avatarPath);
      } else {
        res.status(404).end();
      }
    });

    // Return agent list from voices.json
    app.get('/api/warroom/agents', (_req, res) => {
      res.json({ agents: loadWarroomAgents() });
    });

    // Probe Python WS server readiness
    app.post('/api/warroom/start', async (_req, res) => {
      const net = await import('net');
      const ready = await new Promise<boolean>((resolve) => {
        const sock = new net.Socket();
        const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 3000);
        sock.connect(warroomPort, '127.0.0.1', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
        sock.on('error', () => { clearTimeout(timer); sock.destroy(); resolve(false); });
      });
      if (!ready) {
        res.status(503).json({ ok: false, status: 'starting', error: 'War Room server not ready yet' });
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
      res.json({ ok: true, status: 'ready' });
    });

    // Pin state read/write
    app.get('/api/warroom/pin', (_req, res) => {
      const { agent, mode } = readPinState();
      res.json({ ok: true, agent, mode });
    });

    app.post('/api/warroom/pin', (req, res) => {
      const body = req.body || {};
      const current = readPinState();
      const nextAgent = body.agent !== undefined ? body.agent : current.agent;
      const nextMode = body.mode !== undefined ? body.mode : current.mode;
      try {
        fs.writeFileSync(warroomPinPath, JSON.stringify({ agent: nextAgent, mode: nextMode, pinnedAt: Date.now() }), 'utf-8');
        if (body.restart !== false) { void killWarroomAsync(); }
        res.json({ ok: true, agent: nextAgent, mode: nextMode });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    });

    app.post('/api/warroom/unpin', (_req, res) => {
      try {
        if (fs.existsSync(warroomPinPath)) fs.unlinkSync(warroomPinPath);
        void killWarroomAsync();
        res.json({ ok: true, agent: null, mode: 'direct' });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    });

    // Lightweight in-memory meeting tracking
    const _meetings = new Map<string, { id: string; mode: string; agent: string; startedAt: number }>();
    app.post('/api/warroom/meeting/start', (req, res) => {
      const body = req.body || {};
      const id = body.id || crypto.randomUUID();
      _meetings.set(id, { id, mode: body.mode || 'direct', agent: body.agent || 'yano-langley', startedAt: Date.now() });
      res.json({ ok: true, meetingId: id });
    });
    app.post('/api/warroom/meeting/end', (req, res) => {
      const body = req.body || {};
      if (body.id) _meetings.delete(body.id);
      res.json({ ok: true });
    });
    app.post('/api/warroom/meeting/transcript', (_req, res) => { res.json({ ok: true }); });
    app.get('/api/warroom/meetings', (_req, res) => { res.json({ meetings: [] }); });
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    // Try published location first (server/ui-dist/), then monorepo dev location (../../ui/dist)
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      const indexHtml = applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"));
      // Hashed asset files (Vite emits them under /assets/<name>.<hash>.<ext>)
      // never change once built, so they can be cached aggressively.
      app.use(
        "/assets",
        express.static(path.join(uiDist, "assets"), {
          maxAge: "1y",
          immutable: true,
        }),
      );
      // Non-hashed static files (favicon.ico, manifest, robots.txt, etc.):
      // short cache so operators who swap them out see the new version
      // reasonably fast. Override for `index.html` specifically — it is
      // served by this middleware for `/` and `/index.html`, and it must
      // never outlive the asset hashes it points at.
      app.use(
        express.static(uiDist, {
          maxAge: "1h",
          setHeaders(res, filePath) {
            if (path.basename(filePath) === "index.html") {
              res.set("Cache-Control", "no-cache");
            }
          },
        }),
      );
      // SPA fallback. Only for non-asset routes — if the browser asks for
      // /assets/something.js that doesn't exist, we must NOT serve the HTML
      // shell: the browser would try to load it as a JavaScript module, fail
      // with a MIME-type error, and cache that broken response. Return 404
      // instead. The index.html response itself is no-cache so a subsequent
      // deploy's updated asset hashes are picked up on next load.
      app.get(/.*/, (req, res) => {
        if (req.path.startsWith("/assets/")) {
          res.status(404).end();
          return;
        }
        res
          .status(200)
          .set("Content-Type", "text/html")
          .set("Cache-Control", "no-cache")
          .end(indexHtml);
      });
    } else {
      console.warn("[paperclip] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = path.resolve(__dirname, "../../ui");
    const publicUiRoot = path.resolve(uiRoot, "public");
    const hmrPort = resolveViteHmrPort(opts.serverPort);
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "custom",
      server: {
        middlewareMode: true,
        hmr: {
          host: opts.bindHost,
          port: hmrPort,
          clientPort: hmrPort,
        },
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
      },
    });
    viteHtmlRenderer = createCachedViteHtmlRenderer({
      vite,
      uiRoot,
      brandHtml: applyUiBranding,
    });
    const renderViteHtml = viteHtmlRenderer;

    if (fs.existsSync(publicUiRoot)) {
      app.use(express.static(publicUiRoot, { index: false }));
    }
    app.get(/.*/, async (req, res, next) => {
      if (!shouldServeViteDevHtml(req)) {
        next();
        return;
      }
      try {
        const html = await renderViteHtml.render(req.originalUrl);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
    app.use(vite.middlewares);
  }

  app.use(errorHandler);

  jobCoordinator.start();
  scheduler.start();
  const feedbackExportTimer = opts.feedbackExportService
    ? setInterval(() => {
      void opts.feedbackExportService?.flushPendingFeedbackTraces().catch((err) => {
        logger.error({ err }, "Failed to flush pending feedback exports");
      });
    }, FEEDBACK_EXPORT_FLUSH_INTERVAL_MS)
    : null;
  feedbackExportTimer?.unref?.();
  if (opts.feedbackExportService) {
    void opts.feedbackExportService.flushPendingFeedbackTraces().catch((err) => {
      logger.error({ err }, "Failed to flush pending feedback exports");
    });
  }
  void toolDispatcher.initialize().catch((err) => {
    logger.error({ err }, "Failed to initialize plugin tool dispatcher");
  });
  const devWatcher = opts.uiMode === "vite-dev"
    ? createPluginDevWatcher(
      lifecycle,
      async (pluginId) => (await pluginRegistry.getById(pluginId))?.packagePath ?? null,
    )
    : null;
  void loader.loadAll().then((result) => {
    if (!result) return;
    for (const loaded of result.results) {
      if (devWatcher && loaded.success && loaded.plugin.packagePath) {
        devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
      }
    }
  }).catch((err) => {
    logger.error({ err }, "Failed to load ready plugins on startup");
  });
  process.once("exit", () => {
    if (feedbackExportTimer) clearInterval(feedbackExportTimer);
    devWatcher?.close();
    viteHtmlRenderer?.dispose();
    hostServiceCleanup.disposeAll();
    hostServiceCleanup.teardown();
  });
  process.once("beforeExit", () => {
    void flushPluginLogBuffer();
  });

  return app;
}
