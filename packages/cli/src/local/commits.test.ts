import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { LocalStore } from "@varveai/adit-core";
import { createHistorySchema } from "../../../core/src/local-history/schema.js";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
import { analyzeAttribution } from "./attribution-analysis.js";
import { branchFromCommitOutput, queryCommits } from "./commits.js";
import { queryCommitSources } from "./commit-sources.js";
let root: string, store: LocalStore;
afterEach(() => {
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture(
  content = "export const originalValue = 123;\nexport const unknownValue = 456;\n",
) {
  root = mkdtempSync(join(tmpdir(), "adit-commits-"));
  store = new LocalStore(join(root, "state"));
  createHistorySchema(store.db);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
  git(["init", "-b", "feature/fixture"]);
  git(["config", "user.email", "fixture@example.com"]);
  git(["config", "user.name", "Fixture"]);
  writeFileSync(join(root, "code.ts"), content);
  git(["add", "code.ts"]);
  git(["-c", "core.hooksPath=NUL", "commit", "-m", "fixture"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  const now = Date.now();
  store.db
    .prepare("INSERT INTO adit_local_repositories VALUES (?,?)")
    .run(root, now);
  store.db
    .prepare("INSERT INTO adit_local_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      root,
      sha,
      "tree",
      now,
      "Fixture",
      "fixture@example.com",
      now,
      "Fixture",
      "fixture@example.com",
      "fixture",
      "",
      now,
    );
  return {
    git,
    sha,
    now,
    workspace: store.saveWorkspace({
      path: root,
      repositories: [root],
      providers: ["claude", "codex"],
    }),
    history: new StructuredHistory(store.db),
  };
}
it("keeps saved commit sources and can reanalyze original absolute write paths after a directory move",async()=>{
  const {workspace,sha,now,history}=fixture();
  history.write({provider:"claude",id:"writer-before-move",cwd:root,messages:[{key:"write",role:"assistant",timestamp:new Date(now-1000).toISOString(),raw:{},content:[
    {type:"tool_use",id:"write",name:"Write",input:{file_path:join(root,"code.ts"),content:"export const originalValue = 123;"}},
  ]}]});
  const native=JSON.stringify(history.read("claude","writer-before-move"));
  await analyzeAttribution(store,workspace);
  const before=await queryCommitSources(store,workspace,root,sha);expect(before.matched).toBe(1);
  const moved=join(root,"moved");mkdirSync(moved);renameSync(join(root,".git"),join(moved,".git"));renameSync(join(root,"code.ts"),join(moved,"code.ts"));
  const saved=store.saveWorkspace({version:workspace.version,path:moved},workspace.id);
  expect((await queryCommitSources(store,saved,moved,sha)).matched).toBe(1);
  await analyzeAttribution(store,saved,{recheck:[{repository:moved,sha}]});
  expect((await queryCommitSources(store,saved,moved,sha)).sources[0].sessionId).toBe("writer-before-move");
  expect(JSON.stringify(history.read("claude","writer-before-move"))).toBe(native);
});
it("hides previously collected merges and skips their analysis without filtering subjects", async () => {
  const { sha, workspace } = fixture();
  await analyzeAttribution(store, workspace);
  const saved = queryCommits(store, workspace).analysis.runId;
  // This merge has no Git object. Any attempted attribution would fail.
  const merge = "f".repeat(40);
  store.db
    .prepare(
      "INSERT INTO adit_local_commits SELECT repository,?,tree_sha,authored_at,author_name,author_email,committed_at,committer_name,committer_email,'integrate branches',body,indexed_at FROM adit_local_commits WHERE sha=?",
    )
    .run(merge, sha);
  store.db
    .prepare(
      "UPDATE adit_local_commits SET subject='fix: merge helper' WHERE sha=?",
    )
    .run(sha);
  for (const [ordinal, parent] of [sha, "e".repeat(40)].entries())
    store.db
      .prepare("INSERT INTO adit_local_commit_parents VALUES (?,?,?,?)")
      .run(root, merge, parent, ordinal);
  // Old saved associations must not bring the merge back into the page.
  store.db
    .prepare(
      "INSERT INTO adit_attribution_commits SELECT run_id,repository,?,submit_provider,submit_session_id,submit_turn_id,submit_tool_call_id,match_method,matched_sha,eligible_lines,excluded_lines,certain_lines,likely_lines,possible_lines,moved_lines,unknown_lines FROM adit_attribution_commits WHERE sha=?",
    )
    .run(merge, sha);
  const changes = store.db.prepare("SELECT total_changes() n").get();
  expect(queryCommits(store, workspace).commits.map((c) => c.sha)).toEqual([
    sha,
  ]);
  await expect(
    queryCommitSources(store, workspace, root, merge),
  ).rejects.toThrow("Commit not found");
  expect(await analyzeAttribution(store, workspace)).toEqual({
    id: saved,
    cached: true,
  });
  expect(store.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
  await analyzeAttribution(store, workspace, { force: true });
  expect(
    store.db.prepare("SELECT sha FROM adit_attribution_commits").all(),
  ).toEqual([{ sha }]);
  expect(queryCommits(store, workspace).commits[0].subject).toBe(
    "fix: merge helper",
  );
});
it("saves hunk-majority attribution and candidates without changing any original session or recalculating on reads", async () => {
  const { sha, now, workspace, history } = fixture();
  const write = (id: string, text: string, at: number) =>
    history.write({
      provider: "claude",
      id,
      cwd: root,
      messages: [
        {
          key: "u",
          role: "user",
          timestamp: new Date(at - 1).toISOString(),
          content: id,
          raw: {},
        },
        {
          key: "a",
          role: "assistant",
          timestamp: new Date(at).toISOString(),
          content: [
            {
              type: "tool_use",
              id: "write-" + id,
              name: "Write",
              input: { file_path: join(root, "code.ts"), content: text },
            },
          ],
          raw: {},
        },
      ],
    });
  write(
    "majority",
    "export const originalValue = 123;\nexport const unknownValue = 456;",
    now - 30000,
  );
  write("latest", "export const originalValue = 123;", now - 10000);
  const original = () =>
    JSON.stringify({
      sessions: store.db
        .prepare("SELECT * FROM adit_history_sessions ORDER BY id")
        .all(),
      messages: store.db
        .prepare("SELECT * FROM adit_history_messages ORDER BY id")
        .all(),
      calls: store.db
        .prepare("SELECT * FROM adit_history_tool_calls ORDER BY id")
        .all(),
    });
  const before = original();
  const run = await analyzeAttribution(store, workspace);
  expect(original()).toBe(before);
  const saved = await queryCommitSources(store, workspace, root, sha);
  expect(saved).toMatchObject({ matched: 2, unknown: 0 });
  expect(saved.sources).toHaveLength(1);
  expect(saved.sources[0]).toMatchObject({
    sessionId: "majority",
    certain: 1,
    likely: 1,
    possible: 0,
  });
  expect(saved.sources[0].alternatives[0]).toMatchObject({
    sessionId: "latest",
  });
  expect(
    store.db
      .prepare(
        "SELECT sum(certain_lines+likely_lines+possible_lines) n FROM adit_attribution_alternatives",
      )
      .get(),
  ).toMatchObject({ n: 1 });
  const changes = () => store.db.prepare("SELECT total_changes() n").get();
  const count = changes();
  expect(await queryCommitSources(store, workspace, root, sha)).toEqual(saved);
  queryCommits(store, workspace);
  expect(changes()).toEqual(count);
  expect(await analyzeAttribution(store, workspace)).toEqual({
    id: run.id,
    cached: true,
  });
  expect(original()).toBe(before);
});
it("does not attribute identical or similar text from another write target or repository", async () => {
  const { sha, now, workspace, history } = fixture();
  const otherRepository = join(root, "other-repo");
  workspace.repositories.push(otherRepository);
  store.saveWorkspace(workspace, workspace.id);
  // Explicit patch targets own each write, even when the outer session is
  // opened in the repository whose commit is being analyzed.
  for (const [id, path, text] of [
    [
      "other-project",
      join(otherRepository, "code.ts"),
      "export const originalValue = 123;",
    ],
    [
      "other-file",
      join(root, "unrelated.ts"),
      "export const originalValue = 123;",
    ],
    [
      "similar-other-file",
      join(root, "unrelated.ts"),
      "export const unknownValue = 456;",
    ],
  ])
    history.write({
      provider: "codex",
      id,
      cwd: root,
      messages: [
        {
          key: "write",
          role: "assistant",
          timestamp: new Date(now - 1000).toISOString(),
          content: null,
          raw: {
            payload: {
              type: "custom_tool_call",
              call_id: id,
              name: "exec",
              input: `await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Add File: ${path}\n+${text}\n*** End Patch`)});`,
            },
          },
        },
      ],
    });
  history.write({
    provider: "codex",
    id: "actual-writer",
    cwd: join(root, "subdirectory"),
    messages: [
      {
        key: "write",
        role: "assistant",
        timestamp: new Date(now - 2000).toISOString(),
        content: null,
        // Both files receive the same line in one call; deduplication must keep each target.
        raw: {
          payload: {
            type: "custom_tool_call",
            call_id: "actual",
            name: "apply_patch",
            input: `*** Begin Patch\n*** Add File: ${join(root, "unrelated.ts")}\n+export const originalValue = 123;\n*** Add File: ../code.ts\n+export const originalValue = 123;\n*** End Patch`,
          },
        },
      },
    ],
  });
  history.write({
    provider: "claude",
    id: "unscoped-script",
    cwd: root,
    messages: [
      {
        key: "write",
        role: "assistant",
        timestamp: new Date(now - 1000).toISOString(),
        raw: {},
        content: [
          {
            type: "tool_use",
            id: "outside",
            name: "exec_command",
            input: {
              cwd: tmpdir(),
              command: `writeFileSync('somewhere.ts', 'export const unknownValue = 456;')`,
            },
          },
        ],
      },
    ],
  });
  await analyzeAttribution(store, workspace);
  const result = await queryCommitSources(store, workspace, root, sha);
  expect(result).toMatchObject({ matched: 1, unknown: 1 });
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]).toMatchObject({
    sessionId: "actual-writer",
    certain: 1,
    alternatives: [],
  });
});

it("rechecks a selected SHA atomically while keeping other commits and native history intact", async () => {
  const { sha, now, workspace, history, git } = fixture();
  writeFileSync(join(root, "second.ts"), "const secondCommitValue = 9000;\n");
  git(["add", "second.ts"]);
  git(["-c", "core.hooksPath=NUL", "commit", "-m", "second"]);
  const second = git(["rev-parse", "HEAD"]).trim();
  store.db
    .prepare(
      "INSERT INTO adit_local_commits SELECT repository,?,tree_sha,authored_at,author_name,author_email,committed_at,committer_name,committer_email,subject,body,indexed_at FROM adit_local_commits WHERE sha=?",
    )
    .run(second, sha);
  await analyzeAttribution(store, workspace);
  const old = await queryCommitSources(store, workspace, root, sha);
  const otherSummary = () =>
    store.db
      .prepare(
        "SELECT sha,eligible_lines,certain_lines,likely_lines,possible_lines,moved_lines,unknown_lines FROM adit_attribution_commits WHERE sha=?",
      )
      .all(second);
  const before = otherSummary();
  history.write({
    provider: "claude",
    id: "late-evidence",
    cwd: root,
    messages: [
      {
        key: "write",
        role: "assistant",
        timestamp: new Date(now - 1000).toISOString(),
        raw: {},
        content: [
          {
            type: "tool_use",
            id: "w",
            name: "Write",
            input: {
              file_path: "code.ts",
              content: "export const originalValue = 123;",
            },
          },
        ],
      },
    ],
  });
  const native = JSON.stringify(
    store.db.prepare("SELECT * FROM adit_history_sessions").all(),
  );
  const recheck = [{ repository: root, sha }];
  renameSync(join(root, ".git"), join(root, "git-unavailable"));
  try {
    await expect(
      analyzeAttribution(store, workspace, { recheck }),
    ).rejects.toThrow();
  } finally {
    renameSync(join(root, "git-unavailable"), join(root, ".git"));
  }
  expect(
    (await queryCommitSources(store, workspace, root, sha)).sources,
  ).toEqual(old.sources);
  expect(otherSummary()).toEqual(before);
  await analyzeAttribution(store, workspace, { recheck });
  expect(
    (await queryCommitSources(store, workspace, root, sha)).sources[0]
      .sessionId,
  ).toBe("late-evidence");
  expect(otherSummary()).toEqual(before);
  expect(
    JSON.stringify(
      store.db.prepare("SELECT * FROM adit_history_sessions").all(),
    ),
  ).toBe(native);
  expect(
    store.db
      .prepare(
        "SELECT commit_count,completed_count FROM adit_attribution_runs WHERE status='done'",
      )
      .get(),
  ).toEqual({ commit_count: 1, completed_count: 1 });
  expect(store.db.pragma("foreign_key_check")).toEqual([]);
  const changes = store.db.prepare("SELECT total_changes() n").get();
  expect((await analyzeAttribution(store, workspace)).cached).toBe(true);
  expect(store.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
  await expect(
    analyzeAttribution(store, workspace, {
      recheck: [{ repository: root + "-unconfigured", sha }],
    }),
  ).rejects.toThrow("outside the collected workspace");
});
it("stores JSON-value matches and ninety-percent token matches, while ignoring tool output as authorship", async () => {
  const words =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
  const { sha, now, workspace, history } = fixture(
    `${words} uniform\n"newKey": "Welcome to the application",\nconst onlyInOutput = 987654;\n`,
  );
  history.write({
    provider: "claude",
    id: "writer",
    cwd: root,
    messages: [
      {
        key: "w",
        role: "assistant",
        timestamp: new Date(now - 10000).toISOString(),
        content: [
          {
            type: "tool_use",
            id: "write-source",
            name: "Write",
            input: {
              file_path: join(root, "code.ts"),
              content: words + '\n"oldKey": "Welcome to the application",',
            },
          },
        ],
        raw: {},
      },
      {
        key: "out",
        role: "user",
        timestamp: new Date(now - 9000).toISOString(),
        content: [
          {
            type: "tool_result",
            tool_use_id: "write-source",
            content: "const onlyInOutput = 987654;",
          },
        ],
        raw: {},
      },
    ],
  });
  await analyzeAttribution(store, workspace);
  const saved = await queryCommitSources(store, workspace, root, sha);
  expect(saved).toMatchObject({ eligible: 3, matched: 2, unknown: 1 });
  expect(saved.sources[0]).toMatchObject({
    certain: 1,
    likely: 0,
    possible: 1,
  });
  expect(saved.sources[0].files).toEqual([{ path: "code.ts", lines: 2 }]);
});
it("saves weaker submission bases for quiet commits and rewritten hashes instead of labelling them hash matches", async () => {
  const { sha, now, workspace, history } = fixture();
  const session = (command: string, output: string) => ({
    provider: "claude",
    id: "submitter",
    cwd: root,
    messages: [
      {
        key: "c",
        role: "assistant",
        timestamp: new Date(now - 1000).toISOString(),
        content: [
          {
            type: "tool_use",
            id: "commit-command",
            name: "Bash",
            input: { command },
          },
        ],
        raw: {},
      },
      {
        key: "r",
        role: "user",
        timestamp: new Date(now).toISOString(),
        content: [
          {
            type: "tool_result",
            tool_use_id: "commit-command",
            content: output,
          },
        ],
        raw: {},
      },
    ],
  });
  history.write(session('git commit -q -m "fixture"', ""));
  await analyzeAttribution(store, workspace);
  expect(queryCommits(store, workspace).commits[0].record).toMatchObject({
    method: "subject_time",
  });
  expect(queryCommits(store, workspace).commits[0].branch).toBeNull();
  const originalHash = "c".repeat(40);
  history.write(
    session(
      'git commit -m "fixture"',
      JSON.stringify({ output: `[feature/fixture ${originalHash}] fixture` }),
    ),
  );
  store.db
    .prepare("UPDATE adit_local_commits SET committed_at=? WHERE sha=?")
    .run(now + 3600000, sha);
  await analyzeAttribution(store, workspace, { force: true });
  expect(queryCommits(store, workspace).commits[0].record).toMatchObject({
    method: "rewritten_subject",
    matchedSha: originalHash,
  });
  expect(queryCommits(store, workspace).commits[0].branch).toBeNull();
});
it.each([
  { escaped: false, quiet: false, search: false },
  { escaped: true, quiet: false, search: false },
  { escaped: true, quiet: true, search: false },
  { escaped: true, quiet: false, search: true },
])("recognizes wrapped multiline commit commands without treating searches as submissions: %j", async ({ escaped, quiet, search }) => {
  const { sha, now, workspace, history } = fixture();
  const command = search ? 'rg "git commit" history.log' : [
    "git diff --check",
    ...Array.from({ length: 20 }, (_, i) => `Write-Output 'preflight check ${i}'`),
    'git commit -m "fixture"',
  ].join("\n");
  const script = `text(await tools.exec_command({cmd:${JSON.stringify(command)},workdir:${JSON.stringify(root)}}));\n`;
  const input = escaped ? JSON.stringify(script).slice(1, -1) : script;
  history.write({
    provider: "codex", id: "wrapped-submitter", cwd: root,
    messages: [
      { key: "u", role: "user", timestamp: new Date(now - 2000).toISOString(), content: "commit changes", raw: {} },
      { key: "c", role: "assistant", timestamp: new Date(now - 1000).toISOString(), content: null,
        raw: { payload: { type: "custom_tool_call", call_id: "wrapped-commit", name: "exec", input } } },
      { key: "r", role: "tool", timestamp: new Date(now).toISOString(), content: null,
        raw: { payload: { type: "custom_tool_call_output", call_id: "wrapped-commit",
          output: "Script completed\nOutput:\n\n" + JSON.stringify({ exit_code: 0,
            output: quiet ? "" : `Staged source scan passed.\n[feature/fixture ${sha.slice(0, 7)}] fixture\n` }) } } },
    ],
  });
  await analyzeAttribution(store, workspace);
  const record = queryCommits(store, workspace).commits[0].record;
  if (search) expect(record).toBeNull();
  else expect(record).toMatchObject({ provider: "codex", sessionId: "wrapped-submitter", method: quiet ? "subject_time" : "hash" });
});
it("extracts the matching commit's recorded branch without guessing from other commits or detached HEAD", () => {
  const sha = "a".repeat(40);
  expect(
    branchFromCommitOutput(
      [
        "[feature/other bbbbbbb] other commit\n[feature/original (root-commit) aaaaaaa] target",
      ],
      sha,
    ),
  ).toBe("feature/original");
  expect(
    branchFromCommitOutput(
      [
        JSON.stringify({
          output: "[feature/original aaaaaaa] target\n 1 file changed",
        }),
      ],
      sha,
    ),
  ).toBe("feature/original");
  expect(
    branchFromCommitOutput(["[feature/other bbbbbbb] other commit"], sha),
  ).toBeNull();
  expect(
    branchFromCommitOutput(["[detached HEAD aaaaaaa] target"], sha),
  ).toBeNull();
  expect(
    branchFromCommitOutput(
      ["[feature/a aaaaaaa] target", "[feature/b aaaaaaa] target"],
      sha,
    ),
  ).toBeNull();
  expect(branchFromCommitOutput([], sha)).toBeNull();
});
it("returns only configured repository commits and confirms native Git hash evidence", async () => {
  const { git, sha, now, workspace, history } = fixture();
  history.write({
    provider: "claude",
    id: "s",
    cwd: root,
    messages: [
      {
        key: "u",
        role: "user",
        timestamp: new Date(now - 20000).toISOString(),
        content: "please commit",
        raw: {},
      },
      {
        key: "a",
        role: "assistant",
        timestamp: new Date(now - 10000).toISOString(),
        content: [
          {
            type: "tool_use",
            id: "call",
            name: "Bash",
            input: { command: "git commit -m fixture" },
          },
        ],
        raw: {},
      },
      {
        key: "r",
        role: "user",
        timestamp: new Date(now - 9000).toISOString(),
        content: [
          {
            type: "tool_result",
            tool_use_id: "call",
            content: `[feature/fixture ${sha.slice(0, 7)}] fixture`,
          },
        ],
        raw: {},
      },
    ],
  });
  await analyzeAttribution(store, workspace);
  git(["branch", "-m", "feature/renamed"]);
  const before = store.db.prepare("SELECT total_changes() n").get();
  expect(queryCommits(store, workspace).commits[0].branch).toBe(
    "feature/fixture",
  );
  expect(store.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  expect(queryCommits(store, workspace).commits[0].record).toMatchObject({
    provider: "claude",
    title: "please commit",
  });
  expect(queryCommits(store, workspace, { filter: "linked", limit: 50 }).commits.map(c => c.sha)).toEqual([sha]);
  expect(queryCommits(store, workspace, { filter: "unlinked", limit: 50 }).total).toBe(0);
  expect(
    queryCommits(store, { ...workspace, repositories: [] }).commits,
  ).toEqual([]);
  history.write({
    provider: "codex",
    id: "conflict",
    cwd: root,
    messages: [
      {
        key: "a",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "c",
            name: "Bash",
            input: { command: "git commit -m fixture" },
          },
        ],
        raw: {},
      },
      {
        key: "r",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "c",
            content: `[feature/fixture ${sha.slice(0, 7)}] fixture`,
          },
        ],
        raw: {},
      },
    ],
  });
  await analyzeAttribution(store, workspace, { force: true });
  expect(queryCommits(store, workspace).commits[0].record).toBeNull();
  expect(queryCommits(store, workspace).commits[0].branch).toBeNull();
});
it("compares actual added code with earlier same-repository writes and never treats unknown as manual", async () => {
  const { sha, now, workspace, history } = fixture();
  history.write({
    provider: "claude",
    id: "s",
    cwd: root,
    messages: [
      {
        key: "a",
        role: "assistant",
        timestamp: new Date(now - 20000).toISOString(),
        content: [
          {
            type: "tool_use",
            id: "write",
            name: "Write",
            input: {
              file_path: join(root, "code.ts"),
              content: "export const originalValue = 123;",
            },
          },
        ],
        raw: {},
      },
    ],
  });
  await analyzeAttribution(store, workspace);
  const sources = await queryCommitSources(store, workspace, root, sha);
  expect(sources).toMatchObject({
    eligible: 2,
    matched: 1,
    unknown: 1,
    moved: 0,
  });
  expect(sources.sources[0]).toMatchObject({ certain: 1, possible: 0 });
  history.write({
    provider: "codex",
    id: "late",
    cwd: root,
    messages: [
      {
        key: "a",
        role: "assistant",
        timestamp: new Date(now + 20000).toISOString(),
        content: [
          {
            type: "tool_use",
            id: "write",
            name: "Write",
            input: {
              file_path: join(root, "code.ts"),
              content: "export const unknownValue = 456;",
            },
          },
        ],
        raw: {},
      },
    ],
  });
  await analyzeAttribution(store, workspace, { force: true });
  expect((await queryCommitSources(store, workspace, root, sha)).matched).toBe(
    1,
  );
  await expect(
    queryCommitSources(store, workspace, root + "-other", sha),
  ).rejects.toThrow("Invalid commit");
  await expect(
    queryCommitSources(store, workspace, root, "--help"),
  ).rejects.toThrow("Invalid commit");
});
it("classifies copied existing code separately from session-authored additions", async () => {
  const { git, sha, workspace } = fixture();
  writeFileSync(join(root, "copied.ts"), "export const originalValue = 123;\n");
  git(["add", "copied.ts"]);
  git(["-c", "core.hooksPath=NUL", "commit", "-m", "copy"]);
  const copiedSha = git(["rev-parse", "HEAD"]).trim();
  store.db
    .prepare(
      "INSERT INTO adit_local_commits SELECT repository,?,tree_sha,authored_at,author_name,author_email,committed_at,committer_name,committer_email,subject,body,indexed_at FROM adit_local_commits WHERE sha=?",
    )
    .run(copiedSha, sha);
  await analyzeAttribution(store, workspace);
  expect(
    store.db
      .prepare(
        "SELECT commit_count,completed_count FROM adit_attribution_runs WHERE status='done'",
      )
      .get(),
  ).toEqual({ commit_count: 2, completed_count: 2 });
  expect(
    await queryCommitSources(store, workspace, root, copiedSha),
  ).toMatchObject({ eligible: 1, matched: 0, moved: 1, unknown: 0 });
});
it("reads adjacent Claude backups and preserves the saved generation if a later analysis fails", async () => {
  const { sha, now, workspace, history } = fixture();
  history.write({
    provider: "claude",
    id: "backup-session",
    cwd: root,
    messages: [],
  });
  const home = join(root, "claude-home"),
    project = join(home, "projects", "project"),
    backup = join(home, "file-history", "backup-session");
  mkdirSync(project, { recursive: true });
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, "file@v1"), "old unrelated expression;\n");
  writeFileSync(
    join(backup, "file@v2"),
    "old unrelated expression;\nexport const originalValue = 123;\n",
  );
  const source = join(project, "backup-session.jsonl");
  writeFileSync(
    source,
    [1, 2]
      .map((version) =>
        JSON.stringify({
          type: "file-history-snapshot",
          snapshot: {
            trackedFileBackups: {
              "code.ts": {
                backupFileName: `file@v${version}`,
                backupTime: new Date(
                  now - 30000 + version * 1000,
                ).toISOString(),
              },
            },
          },
        }),
      )
      .join("\n"),
  );
  store.db
    .prepare("INSERT INTO adit_history_sources VALUES (?,?,?,?,?)")
    .run("claude", source, "backup-session", "fixture", 5);
  await analyzeAttribution(store, workspace);
  const saved = await queryCommitSources(store, workspace, root, sha);
  expect(saved.sources[0]).toMatchObject({
    sessionId: "backup-session",
    certain: 1,
  });
  // Backup changes alone must not reopen an already analyzed commit.
  writeFileSync(
    join(backup, "file@v2"),
    "completely changed backup contents;\n",
  );
  const changes = store.db.prepare("SELECT total_changes() n").get();
  expect(await analyzeAttribution(store, workspace)).toEqual({
    id: saved.analysis.runId,
    cached: true,
  });
  expect(store.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
  expect(
    (await queryCommitSources(store, workspace, root, sha)).sources,
  ).toEqual(saved.sources);
  renameSync(join(root, ".git"), join(root, "git-unavailable"));
  try {
    await expect(
      analyzeAttribution(store, workspace, { force: true }),
    ).rejects.toThrow();
  } finally {
    renameSync(join(root, "git-unavailable"), join(root, ".git"));
  }
  const preserved = await queryCommitSources(store, workspace, root, sha);
  expect(preserved.sources).toEqual(saved.sources);
  expect(preserved.analysis).toMatchObject({
    status: "failed",
    stale: true,
    runId: saved.analysis.runId,
  });
});

it("analyzes only newly collected SHAs and atomically carries forward historical results across retries", async () => {
  const { git, sha, now, workspace, history } = fixture();
  const write = (id: string, content: string, file = "code.ts") =>
    history.write({
      provider: "claude",
      id,
      cwd: root,
      messages: [
        {
          key: "write",
          role: "assistant",
          timestamp: new Date(now - 1000).toISOString(),
          content: [
            {
              type: "tool_use",
              id: "write-" + id,
              name: "Write",
              input: { file_path: file, content },
            },
          ],
          raw: {},
        },
      ],
    });
  write("original-writer", "export const originalValue = 123;");
  write("alternative", "export const originalValue = 123;");
  const first = await analyzeAttribution(store, workspace);
  const withoutRun = (row: any) => {
    const { run_id, ...rest } = row;
    return rest;
  };
  const stored = (commitSha: string) => {
    const commit = store.db
      .prepare(
        "SELECT * FROM adit_attribution_commits WHERE sha=? AND run_id IN (SELECT id FROM adit_attribution_runs WHERE status='done')",
      )
      .get(commitSha);
    const summaries = Object.fromEntries(["writers", "alternatives", "turns"].map(table => [table,
      store.db.prepare(`SELECT * FROM adit_attribution_${table} WHERE sha=? AND run_id IN
        (SELECT id FROM adit_attribution_runs WHERE status='done') ORDER BY provider,session_id`)
        .all(commitSha).map(withoutRun),
    ]));
    return { commit: withoutRun(commit), ...summaries };

  };
  const original = stored(sha);
  expect(original.alternatives).toHaveLength(1);
  expect(original.writers).toHaveLength(1);
  expect(original.turns).toHaveLength(1);
  expect(original.commit.unknown_lines).toBe(1);

  // New transcript content would change the old answer if it were recomputed.
  write(
    "original-writer",
    "export const originalValue = 123;\nexport const unknownValue = 456;",
  );
  const changes = store.db.prepare("SELECT total_changes() n").get();
  renameSync(join(root, ".git"), join(root, "git-unavailable"));
  try {
    expect(await analyzeAttribution(store, workspace)).toEqual({
      id: first.id,
      cached: true,
    });
  } finally {
    renameSync(join(root, "git-unavailable"), join(root, ".git"));
  }
  expect(store.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
  expect(stored(sha)).toEqual(original);

  const add = (name: string, content: string, offset: number) => {
    writeFileSync(join(root, name), content);
    git(["add", name]);
    git(["-c", "core.hooksPath=NUL", "commit", "-m", name]);
    const next = git(["rev-parse", "HEAD"]).trim();
    store.db
      .prepare(
        "INSERT INTO adit_local_commits SELECT repository,?,tree_sha,?,author_name,author_email,?,committer_name,committer_email,?,body,indexed_at FROM adit_local_commits WHERE sha=?",
      )
      .run(next, now + offset, now + offset, name, sha);
    return next;
  };
  const newText =
    "export function greeting() { return 'hello incremental world'; }";
  write("new-writer", newText, "new.ts");
  const next = add("new.ts", newText, 1000);
  const bad = "f".repeat(40);
  store.db
    .prepare(
      "INSERT INTO adit_local_commits SELECT repository,?,tree_sha,?,author_name,author_email,?,committer_name,committer_email,subject,body,indexed_at FROM adit_local_commits WHERE sha=?",
    )
    .run(bad, now + 2000, now + 2000, sha);
  // One target succeeds before the next fails; partial results remain unpublished.
  await expect(analyzeAttribution(store, workspace)).rejects.toThrow();
  expect(stored(sha)).toEqual(original);
  expect(
    (await queryCommitSources(store, workspace, root, next)).eligible,
  ).toBeNull();
  expect(queryCommits(store, workspace).analysis).toMatchObject({
    runId: first.id,
    status: "failed",
    completed: 1,
    total: 2,
  });
  store.db.prepare("DELETE FROM adit_local_commits WHERE sha=?").run(bad);

  const nativeBefore = store.db
    .prepare("SELECT * FROM adit_history_sessions ORDER BY id")
    .all();
  const second = await analyzeAttribution(store, workspace);
  expect(second.cached).toBe(false);
  expect(stored(sha)).toEqual(original);
  expect(
    (await queryCommitSources(store, workspace, root, next)).sources[0],
  ).toMatchObject({ sessionId: "new-writer", certain: 1 });
  expect(queryCommits(store, workspace).analysis).toMatchObject({
    runId: second.id,
    status: "done",
    completed: 1,
    total: 1,
  });
  expect(queryCommits(store, workspace).commits.every((c) => c.analyzed)).toBe(
    true,
  );
  expect(
    store.db.prepare("SELECT * FROM adit_history_sessions ORDER BY id").all(),
  ).toEqual(nativeBefore);
  const secondResult = stored(next);

  const thirdSha = add("third.ts", "export const thirdOnly = true;", 3000);
  await analyzeAttribution(store, workspace);
  expect(stored(sha)).toEqual(original);
  expect(stored(next)).toEqual(secondResult);
  expect(
    (await queryCommitSources(store, workspace, root, thirdSha)).eligible,
  ).toBe(1);
  expect(
    store.db.prepare("SELECT count(*) n FROM adit_attribution_runs").get(),
  ).toEqual({ n: 1 });
  expect(
    store.db.prepare("SELECT count(*) n FROM adit_attribution_commits").get(),
  ).toEqual({ n: 3 });
  expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  // No per-line detail or duplicated evidence text is persisted.
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('adit_attribution_lines','adit_attribution_candidates','adit_attribution_evidence')").all()).toEqual([]);
  expect(store.db.prepare("SELECT count(*) n FROM adit_attribution_turns").get()).toEqual({ n: 2 });

});
