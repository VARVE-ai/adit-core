import { describe, expect, it } from "vitest";
import { decodeExecProgram } from "./codex-exec-program.js";

const program = `
const commits = [["cloud", "fix: cloud"], ["core", "fix: core"], ["docker", "fix: docker"]];
for (const [repo, message] of commits) {
  const result = await tools.exec_command({
    cmd: "git commit -m '" + message + "'",
    workdir: "/workspace/" + repo,
    yield_time_ms: 1000
  });
  text({repo, ...result});
  if (result.session_id || result.exit_code !== 0) break;
}
`;

function result(repo: string, exitCode = 0, output = `[main abc1234] fix: ${repo}`): string {
  return JSON.stringify({ repo, chunk_id: repo, wall_time_seconds: 0.01, exit_code: exitCode, output });
}

describe("decodeExecProgram", () => {
  it("pairs each fixed loop iteration with its own labeled result", () => {
    expect(decodeExecProgram(program, [result("cloud"), result("core"), result("docker")]))
      .toEqual(["cloud", "core", "docker"].map((repo, executionIndex) => ({
        command: `git commit -m 'fix: ${repo}'`, cwd: `/workspace/${repo}`,
        executionIndex, exitCode: 0, running: false, output: `[main abc1234] fix: ${repo}`,
      })));
  });

  it("stops at a failed iteration without inventing later executions", () => {
    const calls = decodeExecProgram(program, [result("cloud"), result("core", 1, "nothing to commit")]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ executionIndex: 1, cwd: "/workspace/core", exitCode: 1 });
  });

  it("keeps execution identities stable when a loop stops after its first result", () => {
    expect(decodeExecProgram(program, [result("cloud", 1, "failed")])[0]?.executionIndex).toBe(0);
  });

  it("rejects reordered or mismatched repository labels", () => {
    expect(decodeExecProgram(program, [result("core"), result("cloud"), result("docker")])).toEqual([]);
  });

  it("supports template strings and sequential calls with printed structured results", () => {
    const source = 'const repo="cloud"; const a=await tools.exec_command({cmd:`git commit -m "fix: ${repo}"`,workdir:`/workspace/${repo}`}); text({repo,...a}); const b=await tools.exec_command({cmd:"git status"}); text(b.output);';
    const calls = decodeExecProgram(source, [result("cloud"), "clean"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ command: 'git commit -m "fix: cloud"', cwd: "/workspace/cloud" });
  });

  it.each([
    'const r=await tools.exec_command({cmd:"git commit -m " + unknown,workdir:"/repo"}); text(r.output);',
    'const r=await tools.exec_command({cmd:"git commit -m fix",workdir:"/repo/" + unknown}); text(r.output);',
    'const repo=readFileSync("/private"); const r=await tools.exec_command({cmd:"git commit -m fix",workdir:repo}); text(r.output);',
    'const repos=["cloud"]; repos.reverse(); for(const repo of repos){const r=await tools.exec_command({cmd:"git commit -m fix",workdir:repo});text(r.output);}',
    'const r=await tools.exec_command({cmd:"git commit -m fix"}); const s=await tools.exec_command({cmd:"git status"}); text(s.output); text(r.output);',
    'const r=await tools.exec_command({cmd:"git commit -m fix"}); if(unknown) text(r.output);',
  ])("fails closed for unsupported or ambiguous programs: %s", (source) => {
    expect(decodeExecProgram(source, ["[main abc1234] fix"])).toEqual([]);
  });

  it("does not consume missing or extra execution results", () => {
    expect(decodeExecProgram(program, [result("cloud")])).toEqual([]);
    expect(decodeExecProgram(program, [result("cloud", 1), result("core")])).toEqual([]);
  });

  it("retains completed evidence when a later error check throws", () => {
    const source = 'const r=await tools.exec_command({cmd:"git commit -m fix"}); text(r); if(r.exit_code !== 0) throw new Error("failed");';
    expect(decodeExecProgram(source, [JSON.stringify({wall_time_seconds: 0, exit_code: 1, output: "failed"})])[0]?.exitCode).toBe(1);
  });
});
