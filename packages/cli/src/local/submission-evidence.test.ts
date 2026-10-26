import { expect, it } from "vitest";
import { submissionCandidates } from "./submission-evidence.js";
const call = (id: string, input: unknown, tool = "exec", at = 1, session = "s") => ({id, input_json: JSON.stringify(input), tool_name: tool, occurred_at: at, provider: "codex", session_id: session, turn_id: "original-turn"});
const result = (id: string, output: unknown, at = 1) => ({tool_call_id: id, content_text: typeof output === "string" ? output : JSON.stringify(output), occurred_at: at});
const start = 'text(await tools.exec_command({cmd:"git commit -m \\"fix: example\\"",workdir:"/repo"}));';
const poll = 'text(await tools.write_stdin({session_id:7711,chars:""}));';
it("links escaped wrappers and multiple polls to the initiating call and turn", () => {
  const escaped = start.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const candidates = submissionCandidates([call("start",escaped),call("poll1",poll,"exec",3),call("poll2",poll,"exec",5)], [
    result("start",'Script completed\nOutput:\n'+JSON.stringify({session_id:7711,output:""}),2),
    result("poll1",{session_id:7711,output:"working"},4),
    result("poll2",{exit_code:0,output:"[develop 530378e] fix: example\n[develop 8b09863] fix: another"},6),
  ]);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({call:{id:"start",turn_id:"original-turn"},cwd:"/repo",hashes:["530378e","8b09863"],subjects:["fix: example","fix: another"]});
  expect(candidates[0].command).toBe('git commit -m "fix: example"');
});
it("follows an outer running cell before its shell process", () => {
  expect(submissionCandidates([call("start",start),call("wait",{cell_id:"cell-1"},"wait",3),call("poll",poll,"exec",5)], [
    result("start","Script running with cell ID cell-1",2),result("wait",{session_id:7711,output:""},4),result("poll",{exit_code:0,output:"[develop 530378e] fix: example"},6),
  ])[0].hashes).toEqual(["530378e"]);
});
it("does not infer quiet success while running or on a failed follow-up", () => {
  const calls=[call("start",start),call("poll",poll,"exec",3)];
  const first=result("start",{session_id:7711,output:""},2);
  expect(submissionCandidates(calls,[first])[0].subjects).toEqual([]);
  expect(submissionCandidates(calls,[first,result("poll",{exit_code:1,output:"commit failed"},4)])).toEqual([]);
  expect(submissionCandidates(calls,[first,result("poll",{exit_code:0,output:""},4)])[0].subjects).toEqual(["fix: example"]);
});
it("isolates providers and sessions, rejects earlier polls and conflicting handles", () => {
  const calls=[call("start",start,"exec",3),call("early",poll,"exec",1),call("other",poll,"exec",5,"other")];
  const results=[result("start",{session_id:7711,output:""},4),result("early",{output:"[develop 530378e] fix: example"},2),result("other",{output:"[develop 530378e] fix: example"},6)];
  expect(submissionCandidates(calls,results)[0].hashes).toEqual([]);
  calls.push({...call("provider",poll,"exec",5),provider:"claude"});
  results.push(result("provider",{output:"[develop 530378e] fix: example"},6));
  expect(submissionCandidates(calls,results)[0].hashes).toEqual([]);
  calls.push(call("collision",start,"exec",5),call("poll",poll,"exec",7));
  results.push(result("collision",{session_id:7711,output:""},6),result("poll",{output:"[develop 530378e] fix: example"},8));
  expect(submissionCandidates(calls,results)).toEqual([]);
});
it("does not attach anonymous parallel outputs to one of several wrapped commands", () => {
  const script='await Promise.all([tools.exec_command({cmd:"git commit -m foo"}),tools.exec_command({cmd:"git commit -m bar"})]);';
  expect(submissionCandidates([call("batch",script)],[result("batch",{session_id:7711,output:""},2)])).toEqual([]);
});
it("closes completed handles and reads native calls with a reused process number", () => {
  const calls=[call("one",{cmd:"git commit -m first"},"exec_command",1),call("poll1",{session_id:7711},"write_stdin",3),call("two",{cmd:"git commit -m second"},"exec_command",5),call("poll2",{session_id:7711},"write_stdin",7)];
  const results=[result("one",{session_id:7711,output:""},2),result("poll1",{exit_code:0,output:"[main 530378e] first"},4),result("two",{session_id:7711,output:""},6),result("poll2",{exit_code:0,output:"[main 8b09863] second"},8)];
  expect(submissionCandidates(calls,results).map(c=>c.hashes)).toEqual([["530378e"],["8b09863"]]);
});

it("keeps direct successful commit evidence from a batch but never guesses which pending handle belongs to it", () => {
  const script='await Promise.all([tools.exec_command({cmd:"git commit -m foo",workdir:"/a"}),tools.exec_command({cmd:"git commit -m bar",workdir:"/b"})]);';
  const matched=submissionCandidates([call("batch",script),call("poll",poll,"exec",3)],[result("batch",{session_id:7711,output:"[main 530378e] foo\n[main 8b09863] bar"},2),result("poll",{output:"[main abcdef0] unrelated"},4)]);
  expect(matched).toHaveLength(1);
  expect(matched[0]).toMatchObject({batch:true,hashes:["530378e","8b09863"],subjects:[]});
});

const sequential = (...commands: string[]) => commands.map(cmd => `text(await tools.exec_command(${JSON.stringify({cmd, workdir:"/repo"})}));`).join("\n");
const batchOutput = (...values: unknown[]) => "Script completed\nWall time 0.2 seconds\nOutput:\n\n" + values.map(v => JSON.stringify(v)).join("\n");
it.each(["codex", "claude", "deepseek-harness"])("isolates successful and failed sequential operations for %s", provider => {
  const script = poll + "\n" + sequential('git commit -m "fix: example"');
  const candidate = submissionCandidates([{...call("batch", script), provider}], [result("batch", batchOutput(
    {exit_code:1,output:"configuration not set"},
    {exit_code:0,output:"[develop 530378e] fix: example"},
  ))]);
  expect(candidate).toHaveLength(1);
  expect(candidate[0]).toMatchObject({call:{id:"batch",provider,turn_id:"original-turn"},batch:false,cwd:"/repo",hashes:["530378e"]});
});
it("does not borrow a hash from a successful read when the actual commit failed", () => {
  const script = sequential('git commit -m "fix: example"', 'cat old-commit-output.txt');
  expect(submissionCandidates([call("batch",script)], [result("batch", batchOutput(
    {exit_code:1,output:"commit failed"},
    {exit_code:0,output:"[develop 530378e] fix: example"},
  ))])).toEqual([]);
});
it("keeps failures isolated in both orders and accepts arrays and escaped wrappers", () => {
  const script = sequential('git commit -m "fix: example"', 'git config --get core.hooksPath');
  for (const input of [script, JSON.stringify(script).slice(1,-1)]) {
    const candidates = submissionCandidates([call("batch",input,"js")],[result("batch",[
      {exit_code:0,output:"[develop 530378e] fix: example"}, {exit_code:1,output:""},
    ])]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].hashes).toEqual(["530378e"]);
  }
});
it("follows a pending commit inside a sequential batch through a later mixed poll batch", () => {
  const startScript = sequential('git config --get core.hooksPath', 'git commit -m "fix: example"');
  const pollScript = poll + "\n" + sequential('git config --get core.hooksPath');
  const calls = [call("batch", startScript), call("poll",pollScript,"exec",3)];
  const results = [result("batch",batchOutput({exit_code:1,output:""},{session_id:7711,output:""}),2)];
  expect(submissionCandidates(calls,results)[0]).toMatchObject({hashes:[],subjects:[],pending:true});
  results.push(result("poll",batchOutput({exit_code:0,output:"[develop 530378e] fix: example"},{exit_code:1,output:""}),4));
  expect(submissionCandidates(calls,results)[0]).toMatchObject({call:{id:"batch",turn_id:"original-turn"},hashes:["530378e"],pending:false});
  results[1] = result("poll",batchOutput({exit_code:1,output:"commit failed"},{exit_code:0,output:""}),4);
  expect(submissionCandidates(calls,results)).toEqual([]);
});
it("does not split unordered, conditional, truncated or nested output records", () => {
  const a = {exit_code:1,output:"failed"}, b = {exit_code:0,output:"[develop 530378e] fix: example"};
  for (const script of [
    'await Promise.all([tools.exec_command({cmd:"git commit -m foo"}),tools.exec_command({cmd:"cat old.log"})]);',
    'if (condition) ' + sequential('git commit -m "fix: example"', 'cat old.log'),
    'text(await tools.exec_command({cmd:"git commit -m foo",...options}));' + sequential('cat old.log'),
  ]) expect(submissionCandidates([call("batch",script)],[result("batch",batchOutput(a,b))])).toEqual([]);
  const script = sequential('git commit -m "fix: example"', 'cat old.log');
  expect(submissionCandidates([call("batch",script)],[result("batch",batchOutput(a))])).toEqual([]);
  expect(submissionCandidates([call("batch",script)],[result("batch",{exit_code:1,output:batchOutput(a,b)})])).toEqual([]);
});
