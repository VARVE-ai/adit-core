import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { cleanupProjectFiles } from "./project-cleanup.js";
import {
  LocalStore,
  LocalStateError,
  canonicalDirectory,
  directoryAvailable,
  relocatedRepositories,
  resolveLocalProject,
  LocalAnalytics,
  LocalAchievements,
  LocalInspection,
  LocalSessionBrowser,
  redactSecretValue,
  type InspectionStatus,
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
import { LoginStartup, type StartupRegistration } from "./login-startup.js";
import { AchievementService } from "./achievement-service.js";
import { readmePreview } from "./readme-preview.js";
import { InspectionService } from "./inspection-service.js";
import { scanHistoryInBackground } from "./collection-scan.js";
import { PublicationApi } from "./publication-api.js";
import { LocalCloudSync } from "./cloud-sync.js";

async function body(req: IncomingMessage, limit = 65536): Promise<Record<string, unknown>> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > limit)
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
    startupRegistration?: StartupRegistration;
  } = {},
) {
  const store = new LocalStore(options.directory);
  const startup = new LoginStartup(store, options.startupRegistration);
  const attributionService=options.instance?new AttributionService(store.directory):undefined;
  let achievements: LocalAchievements;
  let achievementService: AchievementService | undefined;
  let inspectionService: InspectionService;
  const achievementWork = new Map<string,number>();
  const evaluateAchievements = async (workspace: ReturnType<LocalStore["workspace"]>, sourceErrors?: number) => {
    achievementWork.set(workspace.id,(achievementWork.get(workspace.id)||0)+1);
    try {
    sourceErrors ??= store.jobs<CollectionJob>().find(j=>j.workspaceId===workspace.id && j.kind==="collect" && ["done","partial"].includes(j.status))?.error ? 1 : 0;
    if (achievementService) await achievementService.evaluate(workspace, sourceErrors);
    else achievements.evaluate(workspace, { sourceErrors });
    } finally { const count=achievementWork.get(workspace.id)!-1; if(count)achievementWork.set(workspace.id,count);else achievementWork.delete(workspace.id); }
  };
  const collector = new Collector(store,attributionService?(workspace,job)=>attributionService.analyze(workspace,job):undefined,evaluateAchievements,workspace=>inspectionService.start(workspace,"collection"),options.instance ? scanHistoryInBackground : undefined);
  const inspection = new LocalInspection(store.db);
  inspectionService = new InspectionService(inspection, options.instance ? store.dbPath : undefined);
  achievements = new LocalAchievements(store.db);
  achievementService = options.instance ? new AchievementService(store.dbPath) : undefined;
  if(attributionService)store.db.prepare("UPDATE adit_attribution_runs SET status='failed',error='上次分析已中断',finished_at=? WHERE status='running'").run(Date.now());
  const analytics = new LocalAnalytics(store.db);
  const overviewService = options.instance ? new OverviewService(store.dbPath) : undefined;
  const priceTimer = options.instance ? setInterval(() => void analytics.prices.refresh(), 60_000) : undefined;
  priceTimer?.unref();
  // Tests may use isolated servers; only the detached production daemon starts network metadata refresh.
  if (options.instance) void analytics.prices.refresh();
  const account = new LocalAccount(store.directory);
  const cloudSync = new LocalCloudSync(store, collector);
  const secrets = new LocalSecrets(store.directory);
  const publications = new PublicationApi(store, analytics.prices, !!options.instance);
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
    res.end(JSON.stringify(redactSecretValue(value)));
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
        const input = req.method === "GET" ? {} : await body(req, path === "/api/local/sessions/turn" && req.method === "PATCH" ? 2_097_152 : 65536);
        const route = path.replace("/api/local", "");
        const publicationResponse = await publications.route(req.method || "GET", route, url, input);
        if (publicationResponse) return json(res, publicationResponse.value, publicationResponse.status);
        if (route.startsWith("/inspection")) {
          const workspace=store.workspace(url.searchParams.get("workspaceId")||"");
          const status=(url.searchParams.get("status")||"pending") as InspectionStatus;
          const offset=Number(url.searchParams.get("offset")||0);
          if(!["pending","handled","ignored"].includes(status)||!Number.isSafeInteger(offset)||offset<0)throw new LocalStateError("Invalid inspection filter");
          if(route==="/inspection" && req.method==="GET") {
            const provider=url.searchParams.get("provider"),sessionId=url.searchParams.get("sessionId");
            if((provider||sessionId)&&(!provider||!sessionId))throw new LocalStateError("Invalid inspection session");
            return json(res,inspection.read(workspace,status,offset,url.searchParams.get("rule")||undefined,
              provider&&sessionId?{kind:"session",provider,sessionId}:url.searchParams.get("view")==="sessions"?{kind:"sessions"}:undefined));
          }
          if(route==="/inspection/detail" && req.method==="GET")return json(res,inspection.detail(workspace,url.searchParams.get("id")||""));
          if(route==="/inspection/scan" && req.method==="POST") {
            if(!inspectionService.available)throw new LocalStateError("Inspection is unavailable; restart the local service",503);
            void inspectionService.start(workspace).catch(()=>{});return json(res,inspection.read(workspace,status),202);
          }
          if(route==="/inspection/cancel" && req.method==="POST") {inspection.cancel(workspace);return json(res,{ok:true});}
          if(route==="/inspection/status" && req.method==="PATCH") {inspection.setStatus(workspace,String(input.id||""),input.status as InspectionStatus);return json(res,{ok:true});}
          if(route==="/inspection/session-status" && req.method==="PATCH") {
            const updated=inspection.setSessionStatus(workspace,String(input.provider||""),String(input.sessionId||""),
              input.from as InspectionStatus,input.status as InspectionStatus,typeof input.rule==="string"?input.rule:undefined);
            return json(res,{ok:true,updated});
          }
          if(route==="/inspection/folder" && req.method==="POST") {
            let source=inspection.sourcePath(workspace,String(input.id||""));
            if(source&&!existsSync(source))source=source.slice(0,source.lastIndexOf("#")>0?source.lastIndexOf("#"):source.length);
            if(!source||!existsSync(source)||!statSync(source).isFile())throw new LocalStateError("Original source file is unavailable",404);
            const folder=dirname(resolve(source));
            await new Promise<void>((resolveOpen,reject)=>{
              // This is an explicit desktop action. Hiding Explorer creates an
              // invisible folder window even though process creation succeeds.
              const child=spawn(process.platform==="win32"?"explorer.exe":process.platform==="darwin"?"open":"xdg-open",[folder],{windowsHide:false,stdio:"ignore"});
              child.once("error",()=>reject(new LocalStateError("Could not open source folder")));child.once("spawn",()=>{child.unref();resolveOpen();});
            });return json(res,{ok:true});
          }
          throw new LocalStateError("Not found",404);
        }
        if (route.startsWith("/achievements")) {
          const workspace = store.workspace(url.searchParams.get("workspaceId") || "");
          if (route === "/achievements" && req.method === "GET") return json(res, achievements.read(workspace));
          if (route === "/achievements/preferences" && req.method === "PATCH") return json(res, achievements.savePreferences(workspace,input));
          if (route === "/achievements/acknowledge" && req.method === "POST") {
            achievements.acknowledge(workspace,input.ids); return json(res,{ok:true});
          }
          throw new LocalStateError("Not found",404);
        }
        if (route === "/commits/sources" && req.method === "GET") {
          return json(res, await queryCommitSources(store, store.workspace(url.searchParams.get("workspaceId")||""),url.searchParams.get("repository")||"",url.searchParams.get("sha")||""));
        }
        if (route === "/commits" && req.method === "GET") {
          return json(res, queryCommits(store,store.workspace(url.searchParams.get("workspaceId")||"")));
        }
        if (["/sessions", "/sessions/detail", "/sessions/turn", "/sessions/turn/edit", "/sessions/content", "/sessions/context"].includes(route) && ["GET", "PATCH", "DELETE"].includes(req.method || "")) {
          const workspace=store.workspace(url.searchParams.get("workspaceId")||"");
          const browser=new LocalSessionBrowser(store.db,analytics.prices);
          const provider=url.searchParams.get("provider")||"all",id=url.searchParams.get("id")||"";
          const offset=Number(url.searchParams.get("offset")||0);
          const mode=url.searchParams.get("mode")==="focused"?"focused":"normal";
          if(req.method!=="GET") {
            if(route!=="/sessions/turn")throw new LocalStateError("Not found",404);
            const turnId=url.searchParams.get("turnId")||"";
            if(req.method==="PATCH")browser.updateTurn(workspace,provider,id,turnId,input.revision,input.changes);
            else browser.deleteTurn(workspace,provider,id,turnId,input.revision);
            return json(res,{ok:true});
          }
          if(route==="/sessions/turn/edit")return json(res,browser.editTurn(workspace,provider,id,url.searchParams.get("turnId")||""));
          if(route==="/sessions")return json(res,browser.list(workspace,{provider,query:url.searchParams.get("q")||"",sort:url.searchParams.get("sort")||"activity",onlyCommits:url.searchParams.get("commits")==="1",offset}));
          if(route==="/sessions/detail")return json(res,browser.detail(workspace,provider,id,mode,url.searchParams.has("offset")?offset:undefined,url.searchParams.get("q")||""));
          if(route==="/sessions/turn")return json(res,browser.turn(workspace,provider,id,url.searchParams.get("turnId")||"",mode,offset));
          if(route==="/sessions/context")return json(res,browser.context(workspace,provider,id,offset));
          return json(res,browser.content(workspace,provider,id,url.searchParams.get("eventId")||"",url.searchParams.get("kind")||"",offset));
        }
        if (route === "/readme-preview" && req.method === "GET") {
          return json(res, await readmePreview(store.workspace(url.searchParams.get("workspaceId") || ""), url.searchParams.get("repository") || undefined));
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
        if (route === "/state" && req.method === "GET") {
          const syncStatuses = cloudSync.statuses();
          return json(res, {
            workspaces: store.workspaces().map((w) => ({
              ...w,
              directoryAvailable: directoryAvailable(w.path),
              counts: collector.snapshot(w),
              repositoryInfo: collector.repositoryInfo(w),
              gistConfigured: secrets.configured(w.id),
              cloudSync: syncStatuses.get(w.id),
              inspection: { pending: inspection.pendingCount(w) },
              achievements: {
                unread: (store.db.prepare("SELECT count(*) AS n FROM adit_achievement_unlocks u LEFT JOIN adit_achievement_preferences p ON p.workspace_id=u.workspace_id WHERE u.workspace_id=? AND u.valid=1 AND u.acknowledged_at IS NULL AND coalesce(p.notify_enabled,1)=1").get(w.id) as {n:number}).n,
              },
            })),
            schedule: { ...store.schedule(), nextAt: collector.nextAt },
            jobs: collector.jobs(),
            startup: startup.status(),
          });
        }
        if (route === "/projects/resolve" && req.method === "GET")
          return json(res,resolveLocalProject({path:url.searchParams.get("path") || undefined,workspaceId:url.searchParams.get("workspaceId") || undefined,directory:store.directory,requireRepository:url.searchParams.get("repository")==="1"}));
        if (route === "/startup" && req.method === "PATCH")
          return json(res, await startup.save(input));
        if (route === "/workspaces" && req.method === "POST") {
          startup.assertCloudMode(input);
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
          /^\/workspaces\/([^/]+)(?:\/(collect|gist-credential|sync|deletion-preview))?$/.exec(route);
        if (match) {
          const id = match[1];
          const workspace = store.workspace(id);
          if (match[2] === "deletion-preview" && req.method === "GET") return json(res,store.deletionPreview(id));
          if (match[2] === "sync" && req.method === "POST") return json(res, cloudSync.start(id), 202);
          if (match[2] === "sync" && req.method === "GET") return json(res, cloudSync.status(id));
          if (!match[2] && req.method === "GET") return json(res, {...workspace,directoryAvailable:directoryAvailable(workspace.path)});
          if (!match[2] && req.method === "DELETE") {
            if (publications.busy(id) || achievementWork.has(id)) throw new LocalStateError("Wait for this project's background tasks to finish before deleting it.",409);
            store.db.transaction(() => {
              store.deleteWorkspace(id, input.version, () => {
                cleanupProjectFiles(store,workspace);
                secrets.clear(id);
              });
            }).immediate();
            publications.forget(id);
            cloudSync.forget(id);
            collector.schedule();
            return json(res, { ok: true });
          }
          if (!match[2] && req.method === "PATCH") {
            startup.assertCloudMode({ cloud: input.cloud ?? workspace.cloud });
            await collector.validateProviders(
              Array.isArray(input.providers)
                ? input.providers
                : workspace.providers,
            );
            const root = canonicalDirectory(
              String(input.path ?? workspace.path),
            );
            const selected = relocatedRepositories(workspace,root,Array.isArray(input.repositories) ? input.repositories as string[] : workspace.repositories);
            validateRepositories(root, selected);
            const saved = store.saveWorkspace({...input,repositories:selected}, id);
            collector.schedule();
            if (saved.started) void evaluateAchievements(saved).catch(()=>{});
            return json(res, {...saved,directoryAvailable:true});
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
          const imported=await collector.history.importExport(resolve(input.path),String(input.provider || ""),workspace.path);
          void inspectionService.start(workspace,"collection").catch(()=>{});
          void evaluateAchievements(workspace).catch(()=>{});
          return json(res,imported,201);
        }
        if (route === "/sessions/unassigned" && req.method === "GET") return json(res,collector.history.unassigned());
        if (route === "/sessions/assign" && req.method === "POST") {
          const workspace=store.workspace(String(input.workspaceId || ""));
          const assigned=collector.history.assign(String(input.provider || ""),String(input.id || ""),workspace.path);
          void inspectionService.start(workspace,"collection").catch(()=>{});
          void evaluateAchievements(workspace).catch(()=>{});
          return json(res,assigned);
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
            collector.collectAll(),
            202,
          );
        if (route === "/account" && req.method === "GET")
          return json(res, account.status());
        if (route === "/account/check" && req.method === "POST")
          return json(res, await account.check());
        if (route === "/account/token" && req.method === "POST")
          return json(res, await account.loginWithToken(
            input.token, typeof input.server === "string" ? input.server : undefined,
          ));
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
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${file === join(web, "share-reader.html") ? " https://api.github.com https://gist.githubusercontent.com" : ""}; frame-ancestors 'none'; base-uri 'none'`,
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
  let closing: Promise<void> | undefined;
  try {
    await new Promise<void>((resolveReady, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => resolveReady());
    });
  } catch (error) {
    await close();
    throw error;
  }
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  collector.schedule(true);
  if (options.instance) cloudSync.schedule();
  if (options.instance) for (const workspace of store.workspaces().filter(w=>w.started)) {
    void inspectionService.start(workspace,"startup").catch(()=>{});
    const latest = store.jobs<CollectionJob>().find(j=>j.workspaceId===workspace.id && j.kind==="collect" && ["done","partial"].includes(j.status));
    void evaluateAchievements(workspace, latest?.error ? 1 : 0).catch(()=>{});
  }
  function close(): Promise<void> {
    return (closing ??= (async () => {
      account.cancel();
      await cloudSync.close();
      clearInterval(priceTimer);
      await analytics.prices.close();
      await publications.close();
      await overviewService?.close();
      await attributionService?.close();
      await inspectionService.close();
      await collector.close();
      await achievementService?.close();
      await new Promise<void>((r) => {
        server.close(() => r());
        // A partial request or an in-flight browser poll must not keep the
        // local daemon's shutdown lock alive after its workers have stopped.
        server.closeAllConnections();
      });
      store.close();
    })());
  }
  return { origin, instance, token, close, server, store, collector };
}
