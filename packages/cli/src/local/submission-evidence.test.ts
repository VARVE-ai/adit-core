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
