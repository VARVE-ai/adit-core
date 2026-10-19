import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  LocalStore,
  LocalStateError,
  canonicalDirectory,
  LocalAnalytics,
} from "@varveai/adit-core";
import {
  Collector,
  localAssets,
  inside,
  type CollectionJob,
} from "./collector.js";
import { LocalAccount } from "./account.js";
import { LocalSecrets } from "./secrets.js";
import { runtimeStatus } from "./runtime.js";
import { OverviewService } from "./overview-service.js";
import { queryCommits } from "./commits.js";
import { queryCommitSources } from "./commit-sources.js";
import { AttributionService } from './attribution-service.js';
import { BrowserSessions, BROWSER_SESSION_MAX_AGE } from './browser-sessions.js';

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 65536)
      throw new LocalStateError("Request too large", 413);
  }
  try {
    const value = JSON.parse(data || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new LocalStateError("Invalid JSON");
  }
}
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateRepositories(root: string, value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.some(
      (p) =>
        typeof p !== "string" ||
        !inside(root, canonicalDirectory(p)) ||
        !existsSync(join(p, ".git")),
    )
  ) {
    throw new LocalStateError("Select Git repositories inside the workspace");
  }
}

export async function startLocalServer(
  options: {
    directory?: string;
    port?: number;
    token?: string;
    instance?: string;
  } = {},
) {
  const store = new LocalStore(options.directory);
  const attributionService=options.instance?new AttributionService(store.directory):undefined;
  const collector = new Collector(store,attributionService?(workspace)=>attributionService.analyze(workspace):undefined);
  if(attributionService)store.db.prepare("UPDATE adit_attribution_runs SET status='failed',error='上次分析已中断',finished_at=? WHERE status='running'").run(Date.now());
  const analytics = new LocalAnalytics(store.db);
  const overviewService = options.instance ? new OverviewService(store.dbPath) : undefined;
  const priceTimer = options.instance ? setInterval(() => void analytics.prices.refresh(), 60_000) : undefined;
  priceTimer?.unref();
  // Tests may use isolated servers; only the detached production daemon starts network metadata refresh.
  if (options.instance) void analytics.prices.refresh();
  const account = new LocalAccount();
  const secrets = new LocalSecrets(store.directory);
  const token = options.token || randomBytes(32).toString("hex");
  const instance = options.instance || randomBytes(16).toString("hex");
  const sessions = new BrowserSessions(store);
  let origin = "";
  const json = (res: ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host)
        throw new LocalStateError("Invalid host", 403);
      const url = new URL(req.url || "/", origin);
      const path = url.pathname;
      if (path === "/health" && req.method === "GET")
        return json(res, { service: "adit-local", instance, pid: process.pid });
      if (path === "/api/local/session" && req.method === "POST") {
        if (req.headers.origin !== origin)
          throw new LocalStateError("Invalid origin", 403);
        const input = await body(req);
        if (!equal(String(input.token || ""), token))
          throw new LocalStateError("Open this page using adit serve", 401);
        const session = sessions.issue();
        res.setHeader(
          "set-cookie",
          `adit_local=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${BROWSER_SESSION_MAX_AGE}`,
        );
        return json(res, { ok: true });
      }
      if (path.startsWith("/api/")) {
        const bearer = req.headers.authorization?.replace(/^Bearer /, "") || "";
        const isCli = equal(bearer, token);
        const cookie = /(?:^|;\s*)adit_local=([a-f0-9]+)/.exec(
          req.headers.cookie || "",
        )?.[1];
        if (!isCli && !sessions.valid(cookie))
          throw new LocalStateError("Open this page using adit serve", 401);
        if (!isCli && req.headers.origin && req.headers.origin !== origin)
          throw new LocalStateError("Invalid origin", 403);
        if (
          !isCli &&
          req.method !== "GET" &&
          (req.headers.origin !== origin || req.headers["x-adit-local"] !== "1")
        )
          throw new LocalStateError("Invalid request origin", 403);
        const input = req.method === "GET" ? {} : await body(req);
        const route = path.replace("/api/local", "");
        if (route === "/commits/sources" && req.method === "GET") {
          return json(res, await queryCommitSources(store, store.workspace(url.searchParams.get("workspaceId")||""),url.searchParams.get("repository")||"",url.searchParams.get("sha")||""));
        }
        if (route === "/commits" && req.method === "GET") {
          return json(res, queryCommits(store,store.workspace(url.searchParams.get("workspaceId")||"")));
        }
        if (route === "/overview" && req.method === "GET") {
          const workspace=store.workspace(url.searchParams.get("workspaceId")||"");
          const query={range:url.searchParams.get("range")||"all",provider:url.searchParams.get("provider")||"all",year:url.searchParams.has("year")?Number(url.searchParams.get("year")):undefined,timezone:url.searchParams.get("timezone")||undefined};
          const data=overviewService?await overviewService.query(workspace,query):analytics.overview(workspace,query);
          data.costs.prices.error=analytics.prices.status().error;
          return json(res,data);
        }
        if (route === "/stop" && req.method === "POST") {
          json(res, { ok: true });
          setTimeout(() => void close(), 50);
          return;
        }
        if (route === "/state" && req.method === "GET")
          return json(res, {
            workspaces: store.workspaces().map((w) => ({
              ...w,
              counts: collector.snapshot(w),
              gistConfigured: secrets.configured(w.id),
            })),
            schedule: { ...store.schedule(), nextAt: collector.nextAt },
            jobs: store.jobs<CollectionJob>(),
          });
        if (route === "/workspaces" && req.method === "POST") {
          await collector.validateProviders(
            Array.isArray(input.providers) ? input.providers : [],
          );
          validateRepositories(
            canonicalDirectory(String(input.path || "")),
            input.repositories ?? [],
          );
          return json(res, store.saveWorkspace(input), 201);
        }
        const match =
          /^\/workspaces\/([^/]+)(?:\/(collect|gist-credential))?$/.exec(route);
        if (match) {
          const id = match[1];
          const workspace = store.workspace(id);
          if (!match[2] && req.method === "GET") return json(res, workspace);
          if (!match[2] && req.method === "PATCH") {
            await collector.validateProviders(
              Array.isArray(input.providers)
                ? input.providers
                : workspace.providers,
            );
            const root = canonicalDirectory(
              String(input.path ?? workspace.path),
            );
            const selected = input.repositories ?? workspace.repositories;
            validateRepositories(root, selected);
            const saved = store.saveWorkspace(input, id);
            collector.schedule();
            return json(res, saved);
          }
          if (match[2] === "collect" && req.method === "POST") {
            const job = collector.collect(id);
            collector.schedule();
            return json(res, job, 202);
          }
          if (match[2] === "gist-credential") {
            if (req.method === "PUT")
              await secrets.save(id, String(input.token || ""));
            else if (req.method === "DELETE") secrets.clear(id);
            else throw new LocalStateError("Method not allowed", 405);
            return json(res, { configured: secrets.configured(id) });
          }
        }
        if (route === "/discoveries" && req.method === "POST")
          return json(res, collector.discover(String(input.path || "")), 202);
        if (route === "/imports" && req.method === "POST") {
          const workspace=store.workspace(String(input.workspaceId || ""));
          if (typeof input.path !== "string" || !input.path.trim()) throw new LocalStateError("Select an export file");
          return json(res,await collector.history.importExport(resolve(input.path),String(input.provider || ""),workspace.path),201);
        }
        if (route === "/sessions/unassigned" && req.method === "GET") return json(res,collector.history.unassigned());
        if (route === "/sessions/assign" && req.method === "POST") {
          const workspace=store.workspace(String(input.workspaceId || ""));
          return json(res,collector.history.assign(String(input.provider || ""),String(input.id || ""),workspace.path));
        }
        if (route === "/directories/list" && req.method === "POST") {
          const drives = process.platform === "win32"
            ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`)
                .filter((root) => existsSync(root))
            : [];
          const requested = String(input.path || "");
          const path = canonicalDirectory(
            String(
              (process.platform === "win32" && /^[a-z]:$/i.test(requested.trim())
                ? `${requested.trim()}\\` : requested) ||
                process.env.USERPROFILE ||
                process.env.HOME ||
                store.directory,
            ),
          );
          const entries = readdirSync(path, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map((e) => ({ name: e.name, path: join(path, e.name) }));
          return json(res, { path, parent: dirname(path), entries, drives });
        }
        if (route === "/providers" && req.method === "GET")
          return json(res, await collector.providers());
        if (route.startsWith("/providers/") && req.method === "PATCH") {
          const id = route.slice(11);
          const provider = (await collector.providers()).find(
            (p) => p.id === id,
          );
          if (!provider?.supported)
            throw new LocalStateError("Unsupported provider");
          if (
            !provider.homesSupported &&
            Array.isArray(input.homes) &&
            input.homes.length
          )
            throw new LocalStateError("Alternate homes are not supported");
          return json(res, store.saveProvider(id, input));
        }
        if (route === "/collection/schedule" && req.method === "PATCH") {
          const config = store.saveSchedule(input);
          collector.schedule();
          return json(res, config);
        }
        if (route === "/collection/run" && req.method === "POST")
          return json(
            res,
            store
              .workspaces()
              .filter((w) => w.started)
              .map((w) => collector.collect(w.id)),
            202,
          );
        if (route === "/account" && req.method === "GET")
          return json(res, account.status());
        if (route === "/account/check" && req.method === "POST")
          return json(res, await account.check());
        if (route === "/account/login" && req.method === "POST")
          return json(
            res,
            await account.login(
              typeof input.server === "string" ? input.server : undefined,
            ),
          );
        if (route === "/account/login" && req.method === "DELETE") {
          account.cancel();
          return json(res, account.status());
        }
        if (route === "/account/logout" && req.method === "POST")
          return json(res, await account.logout());
        if (route === "/runtime" && req.method === "GET")
          return json(res, await runtimeStatus());
        throw new LocalStateError("Not found", 404);
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new LocalStateError("Method not allowed", 405);
      const web = join(localAssets, "web");
      const requested = resolve(web, `.${decodeURIComponent(path)}`);
      if (!inside(web, requested))
        throw new LocalStateError("Invalid path", 403);
      const file =
        existsSync(requested) && statSync(requested).isFile()
          ? requested
          : join(web, "index.html");
      if (!existsSync(file))
        throw new LocalStateError("Local web assets are not built", 503);
      const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
      };
      res.writeHead(200, {
        "content-type": mime[extname(file)] || "application/octet-stream",
        "cache-control": "no-cache",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(req.method === "HEAD" ? undefined : readFileSync(file));
    } catch (error) {
      const status = error instanceof LocalStateError ? error.status : 500;
      json(
        res,
        { error: error instanceof Error ? error.message : "Request failed" },
        status,
      );
    }
  });
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolveReady());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  collector.schedule(true);
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return (closing ??= (async () => {
      account.cancel();
      clearInterval(priceTimer);
      await analytics.prices.close();
      await overviewService?.close();
      await attributionService?.close();
      await collector.close();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    })());
  }
  return { origin, instance, token, close, server, store, collector };
}
