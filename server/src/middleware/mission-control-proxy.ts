import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Mission Control v2 reverse proxy middleware for Paperclip.
 *
 * PURPOSE
 * -------
 * Hermes Cloud Run agents use the Paperclip ngrok tunnel
 * (unperforable-unperniciously-olinda.ngrok-free.dev) as their `MC_URL`.
 * This middleware forwards a narrow set of MC-style paths to the local
 * Mission Control v2 service on http://localhost:3007 so we don't need a
 * separate tunnel for MC v2.
 *
 * CONSERVATIVE GATING
 * -------------------
 * We only proxy when the request carries an `x-api-key` header that matches
 * `MC_API_KEY` (or `MC_PROXY_API_KEY`). Paperclip's own UI does NOT send
 * `x-api-key`, so Paperclip's internal `/api/agents/:id/...` routes keep
 * working normally. Only Cloud Run agents (which set the header) get
 * forwarded to MC v2.
 *
 * INSTALL
 * -------
 * 1. Drop this file at `paperclip/server/src/middleware/mission-control-proxy.ts`.
 * 2. In `paperclip/server/src/app.ts`, add the import near the other
 *    middleware imports:
 *      import { missionControlProxy } from "./middleware/mission-control-proxy.js";
 * 3. Mount it BEFORE `app.use("/api", api);` — a good spot is immediately
 *    after the actorMiddleware block and before the `llmRoutes` mount:
 *      app.use(missionControlProxy());
 * 4. Set the env vars on the Paperclip process:
 *      MC_PROXY_TARGET=http://localhost:3007
 *      MC_PROXY_API_KEY=80bd96516a1344bc1f093f0dd1662ad2d7e23fcae90bb8a7fbf8fd07f74e2f80
 *    (falls back to MC_API_KEY if MC_PROXY_API_KEY is not set)
 * 5. Restart Paperclip: `kill <pid>; cd paperclip && pnpm --filter @paperclipai/server dev`
 *
 * ACCEPTANCE
 * ----------
 *   curl -s -H "x-api-key: 80bd..." \
 *     https://unperforable-unperniciously-olinda.ngrok-free.dev/api/agents
 * should return the MC v2 agent JSON (not a Paperclip 404 and not
 * Paperclip's own route).
 */

const MC_TARGET = process.env.MC_PROXY_TARGET || "http://localhost:3007";
const MC_API_KEY = process.env.MC_PROXY_API_KEY || process.env.MC_API_KEY || "";

const PATH_MATCHERS: Array<(p: string) => boolean> = [
  (p) => p === "/api/agents" || p.startsWith("/api/agents/"),
  (p) => p === "/api/factory-floor/state" || p.startsWith("/api/factory-floor/state/"),
];

function shouldProxy(req: Request): boolean {
  const apiKey = req.header("x-api-key");
  if (!apiKey) return false;
  if (MC_API_KEY && apiKey !== MC_API_KEY) return false;
  return PATH_MATCHERS.some((match) => match(req.path));
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function missionControlProxy(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!shouldProxy(req)) return next();

    const target = `${MC_TARGET.replace(/\/+$/, "")}${req.originalUrl}`;

    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
      }

      const method = req.method.toUpperCase();
      const init: RequestInit = {
        method,
        headers,
      };

      if (method !== "GET" && method !== "HEAD") {
        const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
        if (rawBody && rawBody.length > 0) {
          init.body = rawBody;
        } else if (req.body !== undefined && req.body !== null) {
          init.body = JSON.stringify(req.body);
          if (!headers["content-type"]) headers["content-type"] = "application/json";
        }
      }

      const upstream = await fetch(target, init);
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (HOP_BY_HOP.has(key.toLowerCase())) return;
        res.setHeader(key, value);
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.status(502).json({
        error: "mission_control_proxy_error",
        detail: err instanceof Error ? err.message : String(err),
        target,
      });
    }
  };
}
