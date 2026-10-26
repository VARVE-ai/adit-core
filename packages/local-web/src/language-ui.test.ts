import React from "react";
import type { CloudSyncSummary } from "./overview-cloud-push";
import {
  act,
  create,
  type ReactTestRenderer,
  type ReactTestInstance,
} from "react-test-renderer";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: () => {} }),
}));
vi.mock("react-dom", () => ({ createPortal: (children: React.ReactNode) => children }));
let App: typeof import("./main").App;
let i18n: typeof import("./i18n");
let renderer: ReactTestRenderer | undefined;
let gitAvailable=true;
const storage = new Map<string, string>();
const workspace = {
  id: "ws",
  name: "用户工作目录",
  path: "D:/用户项目",
  version: 1,
  started: true,
  providers: ["claude"],
  repositories: ["D:/用户项目"],
  counts: { claude: 2 },
  gistConfigured: false,
  cloud: { enabled: false, mode: "manual", interval: 5 },
};
const account = {
  connected: true,
  server: "https://example.test",
  auth: "valid",
  account: "用户账号",
  reachable: true,
  checkedAt: "2026-10-19T00:00:00Z",
};
const record = {
  provider: "claude",
  sessionId: "session",
  turnId: "turn",
  title: "用户会话标题",
  ordinal: 1,
  at: Date.UTC(2026, 9, 19),
  command: "git commit -m 用户提交说明",
  prompt: "用户原始提问",
  method: "hash",
  matchedSha: "abcdef123",
};
const commits = [
  {
    repository: workspace.path,
    sha: "abcdef123",
    subject: "用户提交说明",
    authoredAt: Date.UTC(2026, 9, 19),
    branch: "feature/original-branch",
    analyzed: true,
    sourceCount: 1,
    files: [{ path: "src/用户文件.ts", additions: 5, deletions: 1, binary: 0 }],
    record,
  },
  {
    repository: workspace.path,
    sha: "123456789",
    subject: "用户手动提交",
    authoredAt: Date.UTC(2026, 9, 18),
    branch: null,
    analyzed: true,
    sourceCount: 0,
    files: [],
    record: null,
  },
];
const analysis = {
  runId: "run",
  status: "done",
  stale: false,
  completed: 2,
  total: 2,
  error: null,
};
const overview = {
  scope: { first: "2026-10-19", year: 2026 },
  agents: [{ id: "claude", name: "Claude Code" }],
  summary: {
    sessions: 2,
    subtasks: 0,
    messages: 12,
    prompts: 2,
    activeDays: 1,
    recordDays: 1,
    totalCommits: 2,
    linkedCommits: 1,
    estimatedCost: 1000000,
    avgCommitCost: 1000000,
    withCommitRatio: 1,
    topModel: "model-name",
  },
  activity: {
    period: { activeDays: 1, recordDays: 1, busiest: { date: "2026-10-19", count: 12 } },
    days: [{ date: "2026-01-01", state: "recorded", count: 12 }],
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      total: hour === 9 ? 12 : 0,
      average: hour === 9 ? 12 : 0,
    })),
    peakHours: [9],
    busiest: { date: "2026-10-19", count: 12 },
    years: [2026],
  },
  work: {
    duration: 3660000,
    byProvider: [{ provider: "claude", duration: 3660000 }],
    over30m: 1,
    peak: 1,
    peakAt: null,
    longest: [
      {
        id: "turn",
        provider: "claude",
        session_id: "session",
        started_at: Date.UTC(2026, 9, 19),
        duration_status: "observed",
        messages: 12,
        prompt: "用户原始提问",
        duration: 3660000,
      },
    ],
  },
  usage: {
    totals: {
      total_tokens: 12500,
      cache_read_tokens: 10000,
      cache_write_tokens: 0,
      uncached_input_tokens: 2000,
      output_tokens: 500,
    },
    priced: 2,
    unpriced: 0,
  },
  costs: {
    daily: [{ date: "2026-10-19", providers: { claude: 1000000 } }],
    models: [{ model: "model-name", amount: 1000000 }],
    prices: {
      fetchedAt: Date.UTC(2026, 9, 19),
      error: "公开价格更新失败，保留上次价格",
    },
  },
  averageCommitCost: { sampleSize: 2 },
  coverage: { missingUsage: 0, childUsageExcluded: 0 },
};
let empty = false;
let accountConnected = true;
let startup = { enabled: false, supported: true, version: 0 };
let savedWorkspace: typeof workspace & { cloudSync?: CloudSyncSummary; repositoryInfo?: {path:string;count:number|null;skipReason?:"missing-git-email"}[] } = workspace;
let jobs: { id: string; workspaceId: string; kind: string; status: string; phase?:string; repositories?:{path:string;count:number|null}[]; providers?:Record<string,number>;pending?:Record<string,number>;sourceProgress?:Record<string,{completed:number;total:number|null;status:string}>;repositoryProgress?:Record<string,{completed:number;total:number|null;status:string;matched:number}> }[] = [];
let syncStartFails = false;
let startupSaveFails = false;
const respond = (path: string, input?: any): unknown => {
  if(path === "/discoveries") {
    const job={id:"discover",workspaceId:input.path,kind:"discover",status:"running",phase:"git"};
    jobs=[job];return job;
  }
  if (path === "/state")
    return {
      workspaces: empty ? [] : [savedWorkspace],
      startup,
      jobs,
      schedule: { enabled: true, interval: 5, version: 1 },
    };
  if (path === "/workspaces/ws/collect") {
    const job = { id: "collect", workspaceId: "ws", kind: "collect", status: "running" };
    jobs = [job];
    return job;
  }
  if (path === `/workspaces/${savedWorkspace.id}/sync`) {
    if (syncStartFails) throw new Error("Sync could not be started");
    return { id: "sync", status: "queued" };
  }
  if (path === "/workspaces" && input) {
    savedWorkspace = { ...workspace, ...input, id: "original-flow-project", version: 1, started: false };
    empty = false;
  gitAvailable=true;
    return savedWorkspace;
  }
  if (path === "/startup") {
    if (startupSaveFails) throw new Error("Login startup registration failed");
    startup = { ...startup, enabled: input.enabled, version: startup.version + 1 };
    if (!startup.enabled) savedWorkspace = { ...savedWorkspace, version: savedWorkspace.version + 1, cloud: { ...savedWorkspace.cloud, mode: "manual" } };
    return startup;
  }
  if (path === `/workspaces/${savedWorkspace.id}`) {
    if (input) savedWorkspace = { ...savedWorkspace, ...input, version: savedWorkspace.version + 1 };
    return savedWorkspace;
  }
  if (path === `/workspaces/${savedWorkspace.id}/gist-credential`) {
    savedWorkspace = { ...savedWorkspace, gistConfigured: true };
    return { configured: true, account: "test-github-user" };
  }
  if (path.startsWith("/account")) return accountConnected ? account : { ...account, connected: false, auth: "disconnected", reachable: null };
  if (path === "/providers")
    return [
      {
        id: "claude",
        name: "Claude Code",
        paths: ["D:/用户项目"],
        homesSupported: true,
        homes: [],
        enabled: true,
        supported: true,
        version: 1,
      },
    ];
  if (path === "/runtime")
    return {
      version: "0.2.0",
      cli: { path: "D:/adit" },
      skills: [
        {
          name: "adit-history",
          platforms: [
            {
              platform: "claude",
              status: "installed",
              path: "D:/adit-history",
            },
          ],
        },
      ],
    };
  if (path.startsWith("/overview?")) return overview;
  if (path.startsWith("/sessions?")) return {
    items:[{provider:"claude",id:"session",title:"用户会话标题",startedAt:Date.UTC(2026,9,19),lastActivityAt:Date.UTC(2026,9,19),messages:12,prompts:1,commits:1}],
    total:1,messages:12,first:Date.UTC(2026,9,19),providers:[{id:"claude",name:"Claude Code",count:1}],nextOffset:null,
  };
  if (path.startsWith("/sessions/preview?")) return {
    session: {provider:"claude",id:"session",title:"用户会话标题"}, targetTurnId:"turn",
    turns: [{id:"turn",ordinal:1,prompt:"用户原始提问",reply:"Final response",imageCount:0,at:Date.UTC(2026,9,19)}],
  };
  if (path.startsWith("/sessions/detail?")) return {
    session:{provider:"claude",id:"session",title:"用户会话标题",startedAt:Date.UTC(2026,9,19),lastActivityAt:Date.UTC(2026,9,19),messages:12,prompts:1,commits:1},
    models:["model-name"],cost:1000000,unpriced:0,totalTurns:1,nextOffset:null,previousOffset:null,matchTurnId:new URLSearchParams(path.split("?")[1]).get("turnId"),children:[],parent:null,commits:[],context:[],contextNextOffset:null,
    turns:[{id:"turn",ordinal:1,prompt:"用户原始提问",promptBlockId:"prompt",promptTruncated:false,at:Date.UTC(2026,9,19),contextOnly:false,nextOffset:null,previousOffset:null,matchEventId:null,commits:[],
      usage:{input:2000,output:500,cache:10000,cacheWrite:0,requests:1,models:["model-name"],efforts:["high"]},
      events: path.includes("mode=focused")?[{id:"reply",kind:"reply",text:"Final response",at:null}]:[{id:"tool",kind:"tool",name:"Bash",text:"echo hello",at:null},{id:"reply",kind:"reply",text:"Final response",at:null}],
    }],
  };
  if (path.startsWith("/commits?")) {
    const params = new URLSearchParams(path.split("?")[1]);
    const filtered = commits.filter(c => (!params.get("repository") || c.repository === params.get("repository"))
      && (params.get("filter") === "linked" ? !!c.record : params.get("filter") === "unlinked" ? c.analyzed && !c.record : true)
      && `${c.subject} ${c.sha}`.toLowerCase().includes((params.get("q") || "").toLowerCase()));
    return { repositories: [workspace.path], commits: filtered, analysis, total: filtered.length, nextOffset: null,
      summary: { total: commits.length, linked: commits.filter(c => c.record).length, first: Math.min(...commits.map(c => c.authoredAt)) } };
  }
  if (path.startsWith("/commits/sources?"))
    return {
      analysis,
      eligible: 5,
      matched: 4,
      moved: 0,
      unknown: 1,
      coverage:
        "缺少时间的写入记录 3 条；无法读取的备份 2 个。缺失部分不推断归属。",
      sources: [
        {
          provider: "claude",
          sessionId: "session",
          title: "用户会话标题",
          certain: 2,
          likely: 1,
          possible: 1,
          files: [{ path: "src/用户文件.ts", lines: 4 }],
          alternatives: [
            { provider: "codex", sessionId: "other", title: "用户其他会话" },
          ],
        },
      ],
    };
  if (path.startsWith("/projects/git?")) return {available:gitAvailable,...(!gitAvailable?{error:"No Git repository found. Select a directory containing a Git repository to create the project or start organizing."}:{})};
  if (path === "/directories/list")
    return {
      path: workspace.path,
      parent: "D:/",
      drives: ["C:/", "D:/", "E:/"],
      entries: [],
    };
  if (path.startsWith("/sessions/unassigned")) return [];
  if (path === "/workspaces/ws/deletion-preview") return {sharedSessions:1,sharedRepositories:0};
  throw new Error(`Unexpected test request: ${path}`);
};

async function openHeaderStatus(title: "本地采集" | "云端存储") {
  const trigger = renderer!.root.findAllByType("button").find(b =>
    b.props.className === "icon header-status-trigger" && b.props["aria-label"].startsWith(i18n.t(title) + " · "))!;
  await act(async () => { trigger.props.onClick(); });
}

beforeAll(async () => {
  const local = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  const location = { pathname: "/settings/workspaces", search: "", hash: "" };
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("location", location);
  vi.stubGlobal("history", {
    pushState: (_: unknown, __: string, path: string) => {
      const url = new URL(path, "http://127.0.0.1");
      location.pathname = url.pathname;
      location.search = url.search;
    },
    replaceState: vi.fn(),
  });
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: local,
      location,
      matchMedia: () => ({ matches: true }),
    }),
  );
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      documentElement: { lang: "", classList: { toggle: vi.fn() } },
      title: "",
      getElementById: () => null,
      activeElement: null,
    }),
  );
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: { body?: string; method?: string }) => {
      if (url === "/api/local/workspaces/ws" && options?.method === "DELETE") {
        empty = true;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        json: async () => respond(url.replace("/api/local", ""), options?.body ? JSON.parse(options.body) : undefined),
      };
    }),
  );
  i18n = await import("./i18n");
  App = (await import("./main")).App;
});
beforeEach(() => {
  vi.useFakeTimers();
  empty = false;
  accountConnected = true;
  startup = { enabled: false, supported: true, version: 0 };
  savedWorkspace = workspace;
  jobs = [];
  syncStartFails = false;
  startupSaveFails = false;
  storage.clear();
  location.hash = "";
  location.search = "";
  i18n.setLanguage("en");
});
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  vi.useRealTimers();
});
async function render(path: string) {
  location.pathname = path;
  await act(async () => {
    renderer = create(React.createElement(App));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  return renderer!.root;
}
function text(node: ReactTestInstance): string {
  return node.children
    .map((c) => (typeof c === "string" ? c : text(c)))
    .join("");
}
function button(label: string) {
  return renderer!.root
    .findAllByType("button")
    .find((n) => text(n).trim() === label)!;
}
async function toggle() {
  await act(async () => {
    renderer!.root
      .findByProps({ className: "icon language-switch" })
      .props.onClick();
  });
}
it("opens a copied local address without a browser login exchange", async () => {
  vi.mocked(fetch).mockClear();
  await render("/overview/ws");
  expect(text(renderer!.root)).not.toContain("Cannot connect to the local service");
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/local/state")).toBe(true);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/local/session")).toBe(false);
});
it("defaults daily activity to twelve months and allows selecting a year and switching back", async () => {
  vi.mocked(fetch).mockClear();
  const root = await render("/overview/ws");
  const select = root.findByProps({ "aria-label": "Activity period" });
  const latestQuery = () => new URLSearchParams(String(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("/api/local/overview?")).at(-1)![0]).split("?")[1]);
  expect(select.props.value).toBe("12m");
  expect(text(select)).toContain("Last 12 months");
  expect(latestQuery().get("activityRange")).toBe("12m");
  expect(latestQuery().has("year")).toBe(false);
  await act(async () => select.props.onChange({ target: { value: "2026" } }));
  expect(latestQuery().get("activityRange")).toBe("year");
  expect(latestQuery().get("year")).toBe("2026");
  await toggle();
  expect(select.props.value).toBe("2026");
  expect(text(select)).toContain("近 12 个月");
  await act(async () => select.props.onChange({ target: { value: "12m" } }));
  expect(latestQuery().get("activityRange")).toBe("12m");
  expect(latestQuery().has("year")).toBe(false);
});
it("removes an old launch token without logging in or losing the page query", async () => {
  location.hash = "#token=expired-launch-token";
  location.search = "?range=7d";
  vi.mocked(fetch).mockClear();
  vi.mocked(history.replaceState).mockClear();
  await render("/overview/ws");
  expect(history.replaceState).toHaveBeenCalledWith(null, "", "/overview/ws?range=7d");
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/local/session")).toBe(false);
  expect(text(renderer!.root)).not.toContain("Cannot connect to the local service");
});
function expectEnglish() {
  const native = [
    "中文",
    "用户工作目录",
    "用户会话标题",
    "用户提交说明",
    "用户手动提交",
    "用户原始提问",
    "用户其他会话",
    "用户账号",
    "用",
    "用户项目",
    "D:/用户项目",
    "src/用户文件.ts",
    "git commit -m 用户提交说明",
    "Stored through cloud account 用户账号",
  ];
  const strings = renderer!.root
    .findAll((n) => typeof n.type === "string")
    .flatMap((n) => [
      ...n.children.filter((c) => typeof c === "string"),
      n.props.title,
      n.props["aria-label"],
      n.props.placeholder,
    ])
    .filter((s): s is string => typeof s === "string" && !native.includes(s));
  expect(strings.filter((s) => /\p{Script=Han}/u.test(s))).toEqual([]);
}

describe("language switching across the local workbench", () => {
  it("uses the local GitHub account only on click and never fills the token input", async () => {
    const root = await render("/settings/workspaces/ws");
    const endpoint = "/api/local/workspaces/ws/gist-credential";
    const before = vi.mocked(fetch).mock.calls.filter(([url]) => url === endpoint).length;
    expect(root.findByProps({ "aria-label": "GitHub token" }).props.value).toBe("");
    await act(async () => { button("Use local GitHub account").props.onClick(); });
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => url === endpoint);
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)?.[1]).toMatchObject({ method: "POST", body: "{}" });
    expect(root.findByProps({ "aria-label": "GitHub token" }).props.value).toBe("");
    expect(text(root)).toContain("Connected to GitHub account test-github-user. Sharing permission verified.");
    await toggle();
    expect(text(root)).toContain("已连接 GitHub 账号 test-github-user，分享权限检查通过。");
    const input = root.findByProps({ "aria-label": "GitHub 令牌" });
    expect(input.props.type).toBe("password");
    await act(async () => { input.props.onChange({ target: { value: "TEST_MANUAL_TOKEN" } }); });
    await act(async () => { button("保存令牌").props.onClick(); });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === endpoint).at(-1)?.[1]).toMatchObject({ method: "PUT", body: JSON.stringify({ token: "TEST_MANUAL_TOKEN" }) });
    expect(root.findByProps({ "aria-label": "GitHub 令牌" }).props.value).toBe("");
    expect(text(root)).not.toContain("test-github-user");
  });
  it("keeps manual entry available after a failed GitHub account check", async () => {
    const root = await render("/settings/workspaces/ws");
    vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: false, json: async () => ({ error: "The local GitHub sign-in has expired. Sign in again and retry." }) }) as Response);
    await act(async () => { button("Use local GitHub account").props.onClick(); });
    expect(text(root.findByProps({ role: "alert" }))).toContain("sign-in has expired");
    expect(root.findByProps({ "aria-label": "GitHub token" }).props.value).toBe("");
    expect(button("Use local GitHub account").props.disabled).toBe(false);
    expect(text(root)).toContain("Not configured");
  });
  it("keeps missing Git configuration on the unchecked repository row in both languages", async () => {
    const skipped = `${workspace.path}/unconfigured`;
    savedWorkspace = { ...workspace, repositoryInfo: [
      { path: workspace.path, count: 7 }, { path: skipped, count: null, skipReason: "missing-git-email" },
    ] };
    jobs = [{ id: "latest", workspaceId: "ws", kind: "collect", status: "done" }];
    const root = await render("/settings/workspaces/ws");
    const row = () => root.findAllByProps({ className: "selection-row repository-row" }).find(n => text(n).includes(skipped))!;
    expect(row().findByType("input").props.checked).toBe(false);
    expect(text(row())).toContain("Git user.email is missing. Commit collection skipped.");
    expect(text(root.findByType("header"))).not.toContain("partially");
    await toggle();
    expect(text(row())).toContain("缺少 Git user.email，无法提取提交信息；已跳过。");
    expect(text(root)).not.toContain("部分失败");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(row().findByType("input").props.checked).toBe(false);
    expect(text(row())).toContain("缺少 Git user.email");
  });
  it("confirms workspace deletion in both languages and updates the list only after success", async () => {
    const root = await render("/settings/workspaces");
    expect(root.findAllByProps({ className: "workspace-more" })).toHaveLength(0);
    expect(root.findAllByProps({ className: "workspace-delete" })).toHaveLength(0);
    await act(async () => { button("View details").props.onClick(); });
    expect(location.pathname).toBe("/settings/workspaces/ws");
    const requests = () => vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === "DELETE");
    const before = requests().length;
    const openDelete = async () => {
      await act(async () => { root.findByProps({ className: "workspace-delete" }).props.onClick(); });
    };
    await openDelete();
    expect(requests()).toHaveLength(before);
    expect(text(root.findByProps({ role: "dialog" }))).toContain(workspace.path);
    expect(text(root.findByProps({ role: "dialog" }))).toContain("Cloud data and published shares will remain.");
    expect(text(root.findByProps({ role: "dialog" }))).toContain("Records still used by other projects will be kept");
    await act(async () => { button("Cancel").props.onClick(); });
    expect(root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(requests()).toHaveLength(before);
    await toggle();
    await openDelete();
    expect(root.findByProps({ role: "dialog" }).props["aria-label"]).toBe("删除工作目录");
    vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: false, json: async () => ({ error: "Wait for this workspace's organization to finish before deleting it." }) }) as Response);
    await act(async () => { root.findByProps({ className: "workspace-delete-confirm" }).props.onClick(); });
    expect(text(root.findByProps({ role: "dialog" }))).toContain("请等待此工作目录整理结束后再删除。");
    expect(empty).toBe(false);
    expect(location.pathname).toBe("/settings/workspaces/ws");
    await act(async () => { root.findByProps({ className: "workspace-delete-confirm" }).props.onClick(); });
    expect(root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(location.pathname).toBe("/settings/workspaces");
    expect(text(root)).toContain("暂无工作目录");
    expect(requests().at(-1)?.[1]?.body).toBe(JSON.stringify({ version: workspace.version }));
    await toggle();
    expect(text(root)).toContain("No workspaces yet");
  });
  it.each([false, true])("chooses a login method before authorization, preserves translations and clears token input (connected: %s)", async connected => {
    accountConnected = connected;
    const root = await render("/settings/account");
    const loginCalls = () => vi.mocked(fetch).mock.calls.filter(([url, options]) => url === "/api/local/account/login" && options?.method === "POST");
    const before = loginCalls().length;
    async function openToken() {
      expect(text(root.findByProps({ className: "account-actions" }))).not.toContain(i18n.t("使用设备 Token"));
      await act(async () => { button(i18n.t(connected ? "切换账号" : "连接云端账号")).props.onClick(); });
      expect(root.findByProps({ role: "dialog" }).props["aria-label"]).toBe(i18n.t("选择登录方式"));
      expect(loginCalls()).toHaveLength(before);
      await act(async () => { root.findByProps({ className: "cloud-login-method", "aria-label": i18n.t("使用设备 Token") }).props.onClick(); });
    }
    await openToken();
    expectEnglish();
    await act(async () => {
      root.findByProps({ id: "cloud-device-token" }).props.onChange({ target: { value: "adit_test_only" } });
    });
    expect(root.findByProps({ id: "cloud-device-token" }).props.type).toBe("password");
    await toggle();
    expect(root.findByProps({ role: "dialog" }).props["aria-label"]).toBe("使用设备 Token");
    expect(root.findByProps({ id: "cloud-device-token" }).props.value).toBe("adit_test_only");
    await act(async () => { button("取消").props.onClick(); });
    await openToken();
    expect(root.findByProps({ id: "cloud-device-token" }).props.value).toBe("");
    await act(async () => {
      root.findByProps({ id: "cloud-device-token" }).props.onChange({ target: { value: "adit_test_only" } });
    });
    await act(async () => {
      root.findByProps({ className: "cloud-token-form" }).props.onSubmit({ preventDefault() {} });
    });
    expect(root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    const call = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/local/account/token");
    expect(JSON.parse(call![1]!.body as string)).toEqual({ server: account.server, token: "adit_test_only" });
    expect([...storage.values()].join()).not.toContain("adit_test_only");
    await openToken();
    expect(root.findByProps({ id: "cloud-device-token" }).props.value).toBe("");
    await act(async () => { button(i18n.t("返回")).props.onClick(); });
    expect(root.findByProps({ role: "dialog" }).props["aria-label"]).toBe(i18n.t("选择登录方式"));
    await act(async () => { root.findByProps({ className: "cloud-login-method", "aria-label": i18n.t("浏览器授权") }).props.onClick(); });
    expect(loginCalls()).toHaveLength(before + 1);
    expect(root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });
  it("enables Sessions, switches focused content, preserves the header and translates the session controls",async()=>{
    const root=await render("/overview/ws"),header=root.findByType("header");
    expect(button("Sessions").props.disabled).toBe(false);
    await act(async()=>{button("Sessions").props.onClick();await import("./sessions");});
    expect(root.findByType("header")).toBe(header);
    expect(text(root)).toContain("echo hello");
    await act(async()=>{button("Focused").props.onClick();});
    expect(text(root)).not.toContain("echo hello");expect(text(root)).toContain("Final response");
    expect(storage.get("adit-transcript-mode")).toBe("focused");
    expectEnglish();
    await toggle();expect(button("普通")).toBeDefined();expect(button("聚焦").props['aria-pressed']).toBe(true);
    await act(async()=>{button("普通").props.onClick();});expect(text(root)).toContain("echo hello");
  });
  it("places icon statuses before the rightmost workspace picker without starting sync on open", async () => {
    const root = await render("/overview/ws");
    const right = root.findByProps({ className: "top-right" });
    const controls = right.findAllByType("button");
    expect(controls.map(b => b.props["aria-label"] || b.props.title)).toEqual([
      expect.stringContaining("Local collection ·"), expect.stringContaining("Cloud storage ·"),
      "Dark theme", "Switch to Chinese", "Current workspace",
    ]);
    expect(right.findAllByProps({ role: "region" })).toHaveLength(0);
    expect(root.findAllByProps({ className: "overview-cloud-quick" })).toHaveLength(0);
    const writes = () => vi.mocked(fetch).mock.calls.filter(([, options]) => (options as RequestInit)?.method === "POST").length;
    const before = writes();
    await openHeaderStatus("本地采集");
    await openHeaderStatus("云端存储");
    expect(writes()).toBe(before);
    const tools = root.findByProps({ className: "overview-tools" });
    expect(text(tools)).not.toContain("Cloud storage");
  });
  it("shows real pending counts in both languages and keeps them independent of overview filters",async()=>{
    savedWorkspace={...workspace,cloud:{...workspace.cloud,enabled:true},cloudSync:{pending:{state:"ready",sessions:3,commits:2}}};
    const root=await render("/overview/ws");
    await openHeaderStatus("云端存储");
    expect(text(root.findByProps({className:"overview-cloud-quick"}))).toBe("3 sessions · 2 commits pendingPush now");
    const pushes = () => vi.mocked(fetch).mock.calls.filter(([url, options]) => url === "/api/local/workspaces/ws/sync" && (options as RequestInit)?.method === "POST").length;
    const before = pushes();
    await act(async () => { button("Push now").props.onClick(); });
    expect(pushes()).toBe(before + 1);
    await act(async()=>{button(i18n.t("最近 7 天")).props.onClick();});
    expect(text(root.findByProps({className:"overview-cloud-quick"}))).toContain("3 sessions · 2 commits pending");
    await toggle();
    expect(text(root.findByProps({className:"overview-cloud-quick"}))).toContain("待推送 3 个会话、2 个提交");
    savedWorkspace={...savedWorkspace,cloudSync:{status:"done",pending:{state:"ready",sessions:0,commits:0}}};
    await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
    expect(text(root.findByProps({className:"overview-cloud-quick"}))).toContain("待推送 0 个会话、0 个提交");
    // A push still reads new local records even when the current archive has nothing pending.
    expect(button("立即推送").props.disabled).toBe(false);
    savedWorkspace={...savedWorkspace,cloudSync:{status:"running",pending:{state:"ready",sessions:1,commits:0}}};
    await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
    expect(button("正在同步新记录…").props.disabled).toBe(true);
  });
  it("links disabled Cloud storage to directory settings instead of displaying fake pending numbers",async()=>{
    const root=await render("/overview/ws");
    await openHeaderStatus("云端存储");
    expect(text(root.findByProps({className:"overview-cloud-quick"}))).toBe("Cloud storage is offEnable cloud storage");
    await act(async()=>{button("Enable cloud storage").props.onClick();});
    expect(location.pathname).toBe("/settings/workspaces/ws");
  });
  it("links a disconnected account to sign-in and explains an uninitialized history boundary",async()=>{
    savedWorkspace={...workspace,cloud:{...workspace.cloud,enabled:true},cloudSync:{pending:{state:"uninitialized",sessions:null,commits:null}}};
    const root=await render("/overview/ws");
    await openHeaderStatus("云端存储");
    expect(text(root.findByProps({className:"overview-cloud-quick"}))).toBe("Cloud history not checked yetPush now");
    expect(button("Push now").props.disabled).toBe(false);
    act(()=>renderer!.unmount());renderer=undefined;accountConnected=false;
    const disconnected=await render("/overview/ws");
    await openHeaderStatus("云端存储");
    expect(text(disconnected.findByProps({className:"overview-cloud-quick"}))).toContain("Connect a cloud account first.");
    await act(async()=>{button("Sign in to Cloud").props.onClick();});
    expect(location.pathname).toBe("/settings/account");
  });
  it("keeps the shared header and local collection action across overview and commits", async () => {
    const root = await render("/overview/ws");
    const header = root.findByType("header");
    await openHeaderStatus("本地采集");
    const initial = text(header);
    const refreshButton = () => header.findByProps({
      "aria-label": i18n.t("重新采集当前工作目录的本地记录"),
    });
    await act(async () => { button("Commits").props.onClick(); });
    expect(root.findByType("header")).toBe(header);
    expect(header.props.className).toBe("top");
    expect(text(header)).toBe(initial);
    await act(async () => { refreshButton().props.onClick(); });
    expect(text(header)).toContain(i18n.t("本地采集中"));
    expect(refreshButton().props.disabled).toBe(true);
    await act(async () => { button("Overview").props.onClick(); });
    expect(root.findByType("header")).toBe(header);
    expect(text(header)).toContain(i18n.t("本地采集中"));
    expect(refreshButton().props.disabled).toBe(true);
    jobs = [{ ...jobs[0], status: "done" }];
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(text(header)).toContain(i18n.t("本地采集完成"));
    expect(refreshButton().props.disabled).toBe(false);
    await toggle();
    expect(text(header)).toContain("本地采集完成");
  });
  it("manages login startup globally in ADIT CLI and pauses automatic sync when disabled", async () => {
    startup = { enabled: true, supported: true, version: 1 };
    savedWorkspace = { ...workspace, cloud: { ...workspace.cloud, mode: "automatic" } };
    const root = await render("/settings/cli");
    const checkbox = () => root.findAllByType("label")
      .find(n => text(n).trim() === "Start automatically when you sign in")!.findByType("input");
    expect(checkbox().props.checked).toBe(true);
    await act(async () => { await checkbox().props.onChange({ target: { checked: false } }); });
    expect(checkbox().props.checked).toBe(false);
    expect(savedWorkspace.cloud.mode).toBe("manual");
    await toggle();
    expect(text(root)).toContain("启动设置");
    expect(text(root)).toContain("登录电脑后自动启动");
  });
  it("asks for startup consent before selecting automatic sync and keeps manual mode on cancel or failure", async () => {
    const root = await render("/settings/workspaces/ws");
    const automatic = () => root.findAllByType("input").filter(n => n.props.name === "cloud-mode")[1];
    await act(async () => { button("Change frequency").props.onClick(); });
    expect(text(root)).not.toContain("Start automatically when you sign in");
    await act(async () => { automatic().props.onChange(); });
    expect(automatic().props.checked).toBe(false);
    expect(button("Enable and continue").props.disabled).toBe(true);
    const dialog = () => root.findByProps({ role: "dialog" });
    await act(async () => { dialog().findAllByType("button").find(n => text(n) === "Cancel")!.props.onClick(); });
    expect(automatic().props.checked).toBe(false);
    expect(startup.enabled).toBe(false);
    await act(async () => { automatic().props.onChange(); });
    await act(async () => { dialog().findByType("input").props.onChange({ target: { checked: true } }); });
    startupSaveFails = true;
    await act(async () => { button("Enable and continue").props.onClick(); });
    expect(dialog().findByProps({ role: "alert" })).toBeTruthy();
    expect(automatic().props.checked).toBe(false);
    expect(savedWorkspace.cloud.mode).toBe("manual");
    startupSaveFails = false;
    await act(async () => { button("Enable and continue").props.onClick(); });
    expect(root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(startup.enabled).toBe(true);
    expect(automatic().props.checked).toBe(true);
    await act(async () => { button("Save").props.onClick(); });
    expect(savedWorkspace.cloud.mode).toBe("automatic");
  });
  it("selects automatic sync directly when startup is enabled and explains unsupported systems", async () => {
    startup = { enabled: true, supported: true, version: 1 };
    const root = await render("/settings/workspaces/ws");
    await act(async () => { button("Change frequency").props.onClick(); });
    const automatic = () => root.findAllByType("input").filter(n => n.props.name === "cloud-mode")[1];
    await act(async () => { automatic().props.onChange(); });
    expect(automatic().props.checked).toBe(true);
    expect(root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    startup = { enabled: false, supported: false, version: 2 };
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await act(async () => { automatic().props.onChange(); });
    expect(automatic().props.checked).toBe(false);
    expect(button("Enable and continue").props.disabled).toBe(true);
    expect(text(root.findByProps({ role: "dialog" }))).toContain("Login startup is not supported on this system");
    await toggle();
    expect(text(root.findByProps({ role: "dialog" }))).toContain("当前系统不支持登录后自动启动");
  });
  it("keeps manual sync available without startup and without expanding cloud settings", async () => {
    savedWorkspace = { ...workspace, cloud: { ...workspace.cloud, enabled: true } };
    const root = await render("/settings/workspaces/ws");
    expect(root.findAllByProps({ id: "cloud-settings" })).toHaveLength(0);
    expect(button("Sync now").props.disabled).toBe(false);
    await act(async () => { button("Change frequency").props.onClick(); });
    expect(root.findByProps({ id: "workspace-name" }).props.disabled).toBe(true);
    expect(button("Sync now").props.disabled).toBe(false);
    expect(startup.enabled).toBe(false);
    const previous = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/local/workspaces/ws/sync").length;
    await act(async () => { button("Sync now").props.onClick(); });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/local/workspaces/ws/sync")).toHaveLength(previous + 1);
    await act(async () => { button("Cancel").props.onClick(); });
    expect(root.findAllByProps({ id: "cloud-settings" })).toHaveLength(0);
    expect(button("Sync now").props.disabled).toBe(false);
  });
  it("renders collection progress in each selected row and opens Overview only after the first collection completes",async()=>{
    savedWorkspace={...workspace,started:false};
    jobs=[{id:"first",workspaceId:"ws",kind:"collect",status:"running",phase:"analysis",sourceProgress:{claude:{completed:2,total:2,status:"done"}},repositoryProgress:{[workspace.path]:{completed:1,total:3,status:"running",matched:1}}}];
    const root=await render("/settings/workspaces/ws");
    expect(text(root)).toContain("Matching commit sources across 1 repositories");
    expect(text(root)).toContain("1 / 3 commits");expect(text(root)).toContain("2 / 2 sessions");
    expect(text(root)).toContain("Completed");expect(text(root)).toContain("In progress");
    expect(text(root)).not.toContain("files, updated");
    expect(root.findAll(n=>n.type==="label"&&String(n.props.className).includes("collection-item"))).toHaveLength(2);
    await toggle();
    expect(text(root)).toContain("比对 1 个仓库的提交来源");expect(text(root)).toContain("读取 1 个 Agent 的记录");
    expect(text(root)).toContain("点击右上角“编辑”，调整需要读取的会话记录。");
    jobs=[{...jobs[0],status:"done",repositoryProgress:{[workspace.path]:{completed:3,total:3,status:"done",matched:1}}}];
    savedWorkspace={...savedWorkspace,started:true};
    await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
    expect(location.pathname).toBe("/overview/ws");
  });
  it("keeps an organized workspace's main state during automatic collection and distinguishes unknown totals and interruptions",async()=>{
    jobs=[{id:"auto",workspaceId:"ws",kind:"collect",status:"running",phase:"sessions",sourceProgress:{claude:{completed:1,total:null,status:"running"}},repositoryProgress:{[workspace.path]:{completed:3,total:3,status:"done",matched:0}}}];
    const root=await render("/settings/workspaces/ws");
    expect(text(root.findByProps({className:"page-heading"}))).toContain(i18n.t("整理完成"));
    expect(text(root)).toContain("1 / — sessions");expect(text(root)).toContain("0 linked to sessions");
    jobs=[{...jobs[0],status:"interrupted"}];
    await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
    expect(text(root)).toContain("Interrupted");expect(text(root)).not.toContain("In progress");
    expect(location.pathname).toBe("/settings/workspaces/ws");
  });
  it("shows Git while session discovery runs, preserves manual selections and uses discovery-specific copy in both languages",async()=>{
    empty=true;const root=await render("/settings/workspaces/new");
    await act(async()=>{root.findByProps({id:"workspace-path"}).props.onChange({target:{value:workspace.path}});});
    await act(async()=>{button("Discover").props.onClick();});
    expect(text(root)).toContain("Discovering");expect(text(root)).not.toContain("Organizing");
    jobs=[{...jobs[0],phase:"sessions",repositories:[{path:workspace.path,count:3}]}];
    await act(async()=>{await vi.advanceTimersByTimeAsync(2500);});
    expect(text(root)).toContain("Git repositories are ready. Reading session metadata…");
    const repo=()=>root.findByProps({className:"selection-row repository-row"}).findByType("input");
    expect(repo().props.checked).toBe(true);
    await act(async()=>{repo().props.onChange({target:{checked:false}});});
    const source=()=>root.findByProps({className:"selection-row"}).findByType("input");
    await act(async()=>{source().props.onChange({target:{checked:true}});});
    await act(async()=>{source().props.onChange({target:{checked:false}});});
    jobs=[{...jobs[0],status:"done",providers:{claude:2},pending:{claude:1}}];
    await act(async()=>{await vi.advanceTimersByTimeAsync(2500);});
    expect(repo().props.checked).toBe(false);expect(source().props.checked).toBe(false);
    expect(text(root)).toContain("Discovery complete");
    expect(text(root)).toContain("2 sessions confirmed; remaining records need organizing");
    expect(text(root)).toContain("Full transcripts and analysis are processed when you select Start organizing.");
    await toggle();
    expect(text(root)).toContain("发现完成");expect(text(root)).toContain("完整正文解析和分析将在“开始整理”时执行。");
  });
  it.each([false, true])("registers a new workspace before unified sync and retains its identity when starting sync fails (%s)", async (fails) => {
    empty = true;
    syncStartFails = fails;
    const root = await render("/settings/workspaces/new");
    await act(async () => { root.findByProps({ "aria-label":"Enable cloud storage" }).props.onChange({target:{checked:true}}); });
    expect(button("Sync now").props.disabled).toBe(true);
    expect(text(root)).toContain("Enter a workspace name and path first.");
    await act(async () => {
      root.findByProps({id:"workspace-name"}).props.onChange({target:{value:"flow"}});
      root.findByProps({id:"workspace-path"}).props.onChange({target:{value:"D:/flowworkerspace"}});
    });
    expect(button("Sync now").props.disabled).toBe(true);
    await act(async()=>{await vi.advanceTimersByTimeAsync(200);});
    expect(text(root)).toContain("Select at least one Git repository or session source.");
    await act(async () => { root.findAllByProps({className:"selection-row"}).find(n=>text(n).includes("Claude Code"))!.findByType("input").props.onChange({target:{checked:true}}); });
    expect(button("Sync now").props.disabled).toBe(false);
    expect(startup.enabled).toBe(false);
    const before = vi.mocked(fetch).mock.calls.length;
    await act(async () => { button("Sync now").props.onClick(); });
    const writes = vi.mocked(fetch).mock.calls.slice(before).filter(([,options])=>options?.method === "POST");
    expect(writes.map(([url])=>url)).toEqual(["/api/local/workspaces", "/api/local/workspaces/original-flow-project/sync"]);
    expect(JSON.parse(writes[0][1]!.body as string)).toMatchObject({name:"flow",path:"D:/flowworkerspace",providers:["claude"],cloud:{enabled:true,mode:"manual"}});
    expect(location.pathname).toBe("/settings/workspaces/original-flow-project");
    expect(savedWorkspace.id).toBe("original-flow-project");
    expect(text(root)).toContain(fails ? "Sync could not be started" : "flow");
    if (fails) {
      syncStartFails = false;
      const retryFrom = vi.mocked(fetch).mock.calls.length;
      await act(async () => { button("Sync now").props.onClick(); });
      expect(vi.mocked(fetch).mock.calls.slice(retryFrom).filter(([,options])=>options?.method==="POST").map(([url])=>url)).toEqual(["/api/local/workspaces/original-flow-project/sync"]);
    }
  });
  it.each([false, true])("keeps the first cloud sync visible through collection and first acknowledgement (organized: %s)", async (started) => {
    savedWorkspace = { ...workspace, started, cloud: { ...workspace.cloud, enabled: true }, cloudSync: { pending: { state: "uninitialized", sessions: null, commits: null } } };
    await render("/settings/workspaces/ws");
    expect(text(renderer!.root)).toContain("Not linked yet");
    await act(async () => { button("Sync now").props.onClick(); });
    for (const phase of ["sessions", "analysis", "achievements"]) {
      savedWorkspace = { ...savedWorkspace, cloudSync: { status: "running", pending: { state: "uninitialized", sessions: null, commits: null } } };
      jobs = [{ id: "first-sync-collection", workspaceId: "ws", kind: "collect", status: "running", phase,
        sourceProgress: { claude: { completed: 2, total: 2, status: "done" } },
        repositoryProgress: { [workspace.path]: { completed: 3, total: 3, status: "done", matched: 1 } } }];
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(button("Sync now").props.disabled).toBe(true);
      expect(text(renderer!.root)).toContain(workspace.name);
    }
    savedWorkspace = { ...savedWorkspace, started: true, cloudSync: { status: "running", pending: { state: "ready", sessions: 2, commits: 3 } } };
    jobs = [{ ...jobs[0], status: "done" }];
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(location.pathname).toBe(started ? "/settings/workspaces/ws" : "/overview/ws");
    savedWorkspace = { ...savedWorkspace, cloudSync: { status: "done", endedAt: "2026-10-26T01:00:00Z", pending: { state: "ready", sessions: 0, commits: 0 } } };
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(text(renderer!.root)).toContain(workspace.name);
    expect(renderer!.root.findByProps({ "aria-label": "Cloud storage · Sync complete" })).toBeTruthy();
  });
  it("renders an initial sync before provider counts are available", async () => {
    savedWorkspace = Object.assign({ ...workspace, started: false }, { counts: undefined });
    jobs = [{ id: "first", workspaceId: "ws", kind: "collect", status: "queued" }];
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (args[0] === "/api/local/providers") return {
        ok: true, json: async () => [
          { id: "claude", name: "Claude Code", enabled: true, supported: true },
          { id: "antigravity", name: "Antigravity", enabled: true, supported: true },
        ],
      } as Response;
      return originalFetch(...args);
    });
    try {
      await render("/settings/workspaces/ws");
      expect(text(renderer!.root)).toContain("Antigravity");
      expect(text(renderer!.root)).toContain("Not found");
      savedWorkspace = { ...workspace, started: false, counts: Object.assign({ claude: 2 }, { antigravity: 1 }) };
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(text(renderer!.root)).toContain("1 sessions");
    } finally {
      vi.mocked(fetch).mockImplementation(originalFetch);
    }
  });
  it("shows the cloud storage switch outside settings and saves it immediately", async () => {
    const root = await render("/settings/workspaces/ws");
    const storageSwitch = () => root.findByProps({ "aria-label": "Enable cloud storage" });
    expect(root.findAllByProps({ id: "cloud-settings" })).toHaveLength(0);
    expect(storageSwitch().props.checked).toBe(false);
    await act(async () => { root.findByProps({ "aria-label": "Enable cloud storage" }).props.onChange({ target: { checked: true } }); });
    expect(savedWorkspace.cloud.enabled).toBe(true);
    expect(savedWorkspace.cloud.mode).toBe("manual");
    expect(startup.enabled).toBe(false);
    expect(root.findAllByProps({ id: "cloud-settings" })).toHaveLength(0);
    expect(button("Sync now").props.disabled).toBe(false);
    await act(async () => { storageSwitch().props.onChange({ target: { checked: false } }); });
    expect(savedWorkspace.cloud.enabled).toBe(false);
    expect(button("Sync now").props.disabled).toBe(true);
    await toggle();
    expect(root.findByProps({ "aria-label": "开启云端存储" }).props.checked).toBe(false);
  });
  it("saves the storage switch without applying unsaved frequency changes or losing the draft", async () => {
    startup.enabled = true;
    savedWorkspace = { ...workspace, cloud: { enabled: true, mode: "automatic", interval: 15 } };
    const root = await render("/settings/workspaces/ws");
    await act(async () => { button("Change frequency").props.onClick(); });
    expect(root.findByProps({ id:"cloud-settings" }).findAllByProps({ "aria-label":"Enable cloud storage" })).toHaveLength(0);
    await act(async () => { root.findByProps({ id:"cloud-frequency" }).props.onChange({target:{value:"30"}}); });
    await act(async () => { root.findByProps({ "aria-label": "Enable cloud storage" }).props.onChange({ target: { checked: false } }); });
    expect(savedWorkspace.cloud).toEqual({ enabled:false,mode:"automatic",interval:15 });
    expect(root.findByProps({ id:"cloud-frequency" }).props.value).toBe(30);
    await act(async () => { button("Save").props.onClick(); });
    expect(savedWorkspace.cloud).toEqual({ enabled:false,mode:"automatic",interval:30 });
    expect(root.findAllByProps({ id:"cloud-settings" })).toHaveLength(0);
    await act(async () => { button("Change frequency").props.onClick(); });
    await act(async () => { root.findByProps({ id:"cloud-frequency" }).props.onChange({target:{value:"60"}}); });
    await act(async () => { button("Cancel").props.onClick(); });
    expect(savedWorkspace.cloud.interval).toBe(30);
  });
  it("retains the saved switch state when enabling cloud storage fails", async () => {
    const root = await render("/settings/workspaces/ws");
    vi.mocked(fetch).mockImplementationOnce(async () => ({ ok:false,json:async()=>({error:"Settings changed; retry"}) }) as Response);
    await act(async () => { root.findByProps({ "aria-label": "Enable cloud storage" }).props.onChange({target:{checked:true}}); });
    expect(savedWorkspace.cloud.enabled).toBe(false);
    expect(root.findByProps({ "aria-label": "Enable cloud storage" }).props.checked).toBe(false);
    expect(button("Sync now").props.disabled).toBe(true);
    expect(text(root)).toContain("Settings changed; retry");
  });
  it("saving only cloud settings preserves unrelated unsaved directory edits", async () => {
    const root = await render("/settings/workspaces/ws");
    await act(async () => { button("Edit").props.onClick(); });
    await act(async () => { root.findByProps({ id: "workspace-name" }).props.onChange({target:{value:"Unsaved name"}}); });
    await act(async () => { button("Change frequency").props.onClick(); });
    await act(async () => { root.findByProps({ "aria-label": "Enable cloud storage" }).props.onChange({target:{checked:true}}); });
    expect(savedWorkspace.name).toBe(workspace.name);
    expect(root.findByProps({ id:"workspace-name" }).props.value).toBe("Unsaved name");
    expect(savedWorkspace.cloud.enabled).toBe(true);
  });
  it("selecting English from Chinese updates the screenshot's labels and keeps English selected", async () => {
    i18n.setLanguage("zh");
    const root = await render("/commits/ws");
    expect(root.findByProps({ className: "icon language-switch" }).props["aria-label"]).toBe("切换为英文");
    expect(button("全部仓库")).toBeDefined();

    await toggle();
    expect(root.findByProps({ className: "icon language-switch" }).props["aria-label"]).toBe("Switch to Chinese");
    for (const label of [
      "Overview",
      "Settings",
      "All repositories",
      "All",
      "With commit session",
      "No commit session found",
    ]) {
      expect(button(label), label).toBeDefined();
    }
    const detail = text(root.findByProps({ id: "commit-detail-panel" }));
    for (const label of [
      "Commit record",
      "Code sources",
      "Compared:",
      "Matched:",
      "View committed files",
      "View matched files",
      "Also wrote this content",
    ]) {
      expect(detail).toContain(label);
    }
    expectEnglish();
    expect(storage.get("adit-language")).toBe("en");

    // The icon toggles languages; background polling preserves the selection.
    await toggle();
    expect(document.documentElement.lang).toBe("zh-CN");
    await toggle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expectEnglish();
    expect(root.findByProps({ className: "icon language-switch" }).props["aria-label"]).toBe("Switch to Chinese");
    act(() => renderer!.unmount());
    await render("/commits/ws");
    expectEnglish();
    expect(renderer!.root.findByProps({ className: "icon language-switch" }).props["aria-label"]).toBe("Switch to Chinese");
  });

  it.each([
    "/settings/workspaces",
    "/settings/workspaces/ws",
    "/settings/providers",
    "/settings/account",
    "/settings/cli",
    "/overview/ws",
    "/commits/ws",
  ])("renders %s in English and switches in place", async (path) => {
    await render(path);
    expectEnglish();
    expect(document.documentElement.lang).toBe("en-US");
    await toggle();
    expect(text(renderer!.root)).toContain("设置");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(storage.get("adit-language")).toBe("zh");
    expect(location.pathname).toBe(path);
    await toggle();
    expectEnglish();
  });

  it("translates the empty workspace state", async () => {
    empty = true;
    await render("/settings/workspaces");
    expect(text(renderer!.root)).toContain("No workspaces yet");
    await toggle();
    expect(text(renderer!.root)).toContain("暂无工作目录");
  });

  it("preserves unsaved edits and the directory dialog during a language switch", async () => {
    const root = await render("/settings/workspaces/ws");
    await act(async () => {
      button("Edit").props.onClick();
    });
    await act(async () => {
      root
        .findByProps({ id: "workspace-name" })
        .props.onChange({ target: { value: "未保存的目录名称" } });
    });
    await act(async () => {
      root.findByProps({ title: "Choose directory" }).props.onClick();
    });
    expect(root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    await toggle();
    expect(root.findByProps({ id: "workspace-name" }).props.value).toBe(
      "未保存的目录名称",
    );
    expect(root.findByProps({ role: "dialog" }).props["aria-label"]).toBe(
      "选择工作目录",
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("preserves commit filters, search and selected native content", async () => {
    const root = await render("/commits/ws");
    await act(async () => {
      button("No commit session found").props.onClick();
    });
    await act(async () => {
      root
        .findByProps({ placeholder: "Search commit message or hash" })
        .props.onChange({ target: { value: "用户手动提交" } });
    });
    await toggle();
    expect(button("未找到提交会话").props.className).toBe("on");
    expect(
      root.findByProps({ placeholder: "搜索提交说明或编号" }).props.value,
    ).toBe("用户手动提交");
    expect(text(root.findByProps({ id: "commit-detail-panel" }))).toContain(
      "用户手动提交",
    );
    expect(text(root.findByProps({ className: "commit-branch" }))).toBe("—");
    expect(root.findByProps({ className: "commit-branch" }).props.title).toBe(
      "未记录提交时的分支",
    );
  });

  it("opens the exact session turn from a commit's question and preserves the original title and reply", async () => {
    const root = await render("/commits/ws");
    const conversation = root.findByProps({ className: "commit-conversation" });
    expect(text(conversation)).toContain("用户会话标题");
    expect(text(conversation)).toContain("用户原始提问");
    expect(text(conversation)).toContain("Final response");
    expect(text(conversation)).not.toContain("Locate commit event");
    const row = conversation.findAllByType("a").find(node => node.props.className === "commit-context-row prompt")!;
    const preventDefault = vi.fn();
    await act(async () => { row.props.onClick({button:0,preventDefault}); });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(location.pathname).toBe("/sessions/ws");
    expect(new URLSearchParams(location.search).get("turn")).toBe("turn");
    const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(calls.some(url => url.startsWith("/api/local/sessions/detail?") && new URLSearchParams(url.split("?")[1]).get("turnId") === "turn")).toBe(true);
    expect(renderer!.root.findAll(node => node.props.className?.split?.(" ").includes("search-match"))).toHaveLength(1);
  });

  it("shows the recorded branch after the file count as in the prototype", async () => {
    const root = await render("/commits/ws");
    const meta = root.findByProps({ className: "commit-detail-meta" });
    const branch = root.findByProps({ className: "commit-branch" });
    expect(meta.children.at(-1)).toBe(branch);
    expect(text(branch)).toBe("feature/original-branch");
    expect(branch.props.title).toBe(
      "Branch recorded by Git at commit time: feature/original-branch",
    );
    await toggle();
    expect(text(branch)).toBe("feature/original-branch");
    expect(branch.props.title).toBe(
      "Git 提交记录中的分支：feature/original-branch",
    );
  });

  it("preserves the overview filter across language changes and opens the exact session turn", async () => {
    const root = await render("/overview/ws");
    await act(async () => {
      button("Last 7 days").props.onClick();
    });
    await toggle();
    expect(button("最近 7 天").props["aria-pressed"]).toBe(true);
    vi.mocked(fetch).mockClear();
    await act(async () => {
      root.findByProps({ className: "overview-turn" }).props.onClick();
    });
    expect(location.pathname).toBe("/sessions/ws");
    expect(Object.fromEntries(new URLSearchParams(location.search))).toEqual({
      provider: "claude", session: "session", turn: "turn",
    });
    const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(calls.some(url => {
      if (!url.startsWith("/api/local/sessions/detail?")) return false;
      const query = new URLSearchParams(url.split("?")[1]);
      return query.get("provider") === "claude" && query.get("id") === "session" && query.get("turnId") === "turn";
    })).toBe(true);
    expect(root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    const matched = root.findAll(node => node.props.className?.split?.(" ").includes("search-match"));
    expect(matched).toHaveLength(1);
    expect(text(matched[0])).toContain("用户原始提问");
  });
});

it("shows the no-Git reason in both languages, blocks organization, and rechecks changed paths",async()=>{
 gitAvailable=false;savedWorkspace={...workspace,started:false};const root=await render("/settings/workspaces/ws");
 expect(text(root)).toContain("No Git repository found.");expect(button("Start organizing").props.disabled).toBe(true);
 await toggle();expect(text(root)).toContain("未检测到 Git 仓库");await toggle();
 gitAvailable=true;await act(async()=>{root.findByProps({id:"workspace-path"}).props.onChange({target:{value:"D:/valid-git"}});});
 expect(button("Start organizing").props.disabled).toBe(true);await act(async()=>{await vi.advanceTimersByTimeAsync(200);});
 expect(text(root)).not.toContain("No Git repository found.");expect(button("Start organizing").props.disabled).toBe(false);
});
