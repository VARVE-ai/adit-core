import { expect, it } from "vitest";
import { sessionToolDisplay } from "./session-tool-display.js";

it("shows the recorded tool description, command or plan without inventing a purpose", () => {
  expect(
    sessionToolDisplay("Read", {
      description: "Read command registration",
      file_path: "src/main.ts",
    }),
  ).toEqual({
    name: "Read",
    kind: "tool",
    text: "Read command registration",
    icon: "read",
  });
  expect(sessionToolDisplay("Bash", { command: "git status --short" })).toEqual(
    { name: "Bash", kind: "command", text: "git status --short", icon: "git" },
  );
  expect(
    sessionToolDisplay("update_plan", {
      plan: [{ step: "Read source" }, { step: "Verify" }],
    }),
  ).toEqual({
    name: "update_plan",
    kind: "plan",
    text: "Read source → Verify",
    icon: "plan",
  });
});
it("unwraps literal script calls without executing the script or evaluating expressions", () => {
  expect(
    sessionToolDisplay(
      "exec",
      'text(await tools.exec_command({cmd:"git status --short"}));',
    ),
  ).toEqual({
    name: "exec_command",
    kind: "command",
    text: "git status --short",
    icon: "git",
  });
  expect(
    sessionToolDisplay(
      "exec",
      'await Promise.all([tools.exec_command({cmd:`pwd`}),tools.exec_command({cmd:"git diff"})]);',
    ),
  ).toMatchObject({ text: "pwd · git diff", kind: "command" });
  expect(
    sessionToolDisplay(
      "exec",
      'throw Error("do not execute"); await tools.exec_command({cmd:dangerous()});',
    ),
  ).toMatchObject({ text: "", name: "exec_command" });
  expect(sessionToolDisplay("exec", "await tools.exec_command({cmd:")).toEqual({
    name: "exec",
    kind: "tool",
    text: "",
    icon: "tool",
  });
});

it("matches native tools and shell executables without using command arguments as evidence", () => {
  const commands = [
    ['Get-Content -Encoding UTF8 src/main.ts; rg "test" src', "read"],
    ['rg -n "Get-Content" src', "search"],
    ['echo "rg pattern src; Get-Content file"', "terminal"],
    ['node -e "read_file()"', "terminal"],
    ['Set-Content -Path file.txt -Value "text"', "edit"],
    ["Get-ChildItem -Directory", "list"],
    ["curl https://example.test", "web"],
    ['& "C:\\Program Files\\Git\\bin\\git.exe" status', "git"],
    ['"Get-Content"', "terminal"],
    ["$command file.txt", "terminal"],
  ];
  for (const [cmd, icon] of commands) {
    expect(
      sessionToolDisplay("exec_command", {
        cmd,
        description: "Original description",
      }),
    ).toMatchObject({ icon, text: "Original description" });
  }
  for (const [name, icon] of [
    ["Grep", "search"],
    ["Edit", "edit"],
    ["Write", "write"],
    ["apply_patch", "edit"],
    ["Task", "task"],
    ["unknown", "tool"],
  ]) {
    expect(sessionToolDisplay(name, {})).toMatchObject({ icon });
  }
});

it("uses recognized icons through script wrappers and a generic icon for mixed operations", () => {
  expect(
    sessionToolDisplay(
      "exec",
      'text(await tools.exec_command({cmd:"rg --files"}));',
    ),
  ).toMatchObject({ icon: "search" });
  expect(
    sessionToolDisplay(
      "exec",
      'await tools.exec_command({cmd:"cat a"}); await tools.exec_command({cmd:"head b"});',
    ),
  ).toMatchObject({ icon: "read" });
  expect(
    sessionToolDisplay(
      "exec",
      'await tools.exec_command({cmd:"cat a"}); await tools.exec_command({cmd:"rg a"});',
    ),
  ).toMatchObject({ icon: "terminal" });
  expect(
    sessionToolDisplay("exec", "await tools.exec_command({cmd:dangerous()});"),
  ).toMatchObject({ icon: "terminal" });
});
