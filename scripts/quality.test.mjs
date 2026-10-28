import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ESLint } from "eslint";
import { changedSourceFiles, checkChangedFormatting } from "./format-changed.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const eslint = new ESLint({ cwd: projectRoot });

async function messages(source, testFile = false) {
  const [result] = await eslint.lintText(source, {
    filePath: `packages/local-web/src/quality-probe${testFile ? ".test" : ""}.tsx`,
  });
  return result.messages;
}

test("type flexibility is a production warning and a test-only exception", async () => {
  const source = "export function read(value: any) { return value; }";
  assert.equal(
    (await messages(source)).find((m) => m.ruleId === "@typescript-eslint/no-explicit-any")
      ?.severity,
    1,
  );
  assert.equal(
    (await messages(source, true)).some((m) => m.ruleId === "@typescript-eslint/no-explicit-any"),
    false,
  );
});

test("mock generators may omit yield without relaxing the production rule", async () => {
  const source = "export function* stream() { return 1; }";
  assert.equal((await messages(source)).find((m) => m.ruleId === "require-yield")?.severity, 2);
  assert.equal(
    (await messages(source, true)).some((m) => m.ruleId === "require-yield"),
    false,
  );
});

test("duplicate conditions still fail in production and tests", async () => {
  const source =
    "export function read(value: number) { if (value === 1) return 1; else if (value === 1) return 2; return 0; }";
  for (const testFile of [false, true]) {
    assert.equal(
      (await messages(source, testFile)).find((m) => m.ruleId === "no-dupe-else-if")?.severity,
      2,
    );
  }
});

test("ignored cleanup errors need an explanation inside the empty catch", async () => {
  const source = (comment) =>
    `export function clean(action: () => void) { try { action(); } catch { ${comment} } }`;
  assert.equal((await messages(source(""))).find((m) => m.ruleId === "no-empty")?.severity, 2);
  assert.equal(
    (
      await messages(source("/* Best-effort cleanup; a missing temporary file is harmless. */"))
    ).some((m) => m.ruleId === "no-empty"),
    false,
  );
});

test("intentional unused parameters are exempt while unused locals remain visible", async () => {
  const found = await messages(
    "export function read(_unused: string) { const forgotten = 1; return 0; }",
  );
  const unused = found.filter((m) => m.ruleId === "@typescript-eslint/no-unused-vars");
  assert.equal(unused.length, 1);
  assert.equal(unused[0].severity, 1);
  assert.match(unused[0].message, /forgotten/);
});

test("generated source stays outside lint", async () => {
  assert.equal(
    await eslint.isPathIgnored(
      path.join(projectRoot, "packages/local-web/src/agent-brands.generated.ts"),
    ),
    true,
  );
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "adit-quality-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Quality Test",
        "-c",
        "user.email=quality@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${path.join(root, "no-hooks")}`,
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: "pipe" },
    );
  const put = (file, content) => {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  git("init", "-q");
  copyFileSync(path.join(projectRoot, ".prettierrc.json"), path.join(root, ".prettierrc.json"));
  copyFileSync(path.join(projectRoot, ".prettierignore"), path.join(root, ".prettierignore"));
  put(".gitignore", "packages/demo/src/ignored.ts\n");
  for (const name of ["existing", "unchanged", "deleted", "renamed"]) {
    put(`packages/demo/src/${name}.ts`, "export const value = 1;\n");
  }
  // Commits only exist in this disposable fixture, never in the user's checkout.
  git("add", ".");
  git("commit", "-qm", "fixture baseline");
  return { root, git, put };
}

test("format scope includes staged, unstaged, renamed and untracked sources", async (t) => {
  const { root, git, put } = fixture(t);
  put("packages/demo/src/existing.ts", "export const value=2\n");
  put("packages/demo/src/staged.ts", "export const staged=1\n");
  git("add", "packages/demo/src/staged.ts");
  put("packages/demo/src/new view.tsx", "export const view=<div/>\n");
  put("packages/demo/src/data.generated.ts", "export const data=1\n");
  put("packages/demo/src/ignored.ts", "export const ignored=1\n");
  git("mv", "packages/demo/src/renamed.ts", "packages/demo/src/renamed file.ts");
  rmSync(path.join(root, "packages/demo/src/deleted.ts"));
  const before = readFileSync(path.join(root, "packages/demo/src/existing.ts"), "utf8");
  const result = await checkChangedFormatting(root);
  assert.deepEqual(result.checked, [
    "packages/demo/src/existing.ts",
    "packages/demo/src/new view.tsx",
    "packages/demo/src/renamed file.ts",
    "packages/demo/src/staged.ts",
  ]);
  assert.equal(result.different.length, 3);
  assert.equal(readFileSync(path.join(root, "packages/demo/src/existing.ts"), "utf8"), before);
});

test("format writes only selected sources and never updates the Git index", async (t) => {
  const { root, git, put } = fixture(t);
  put("packages/demo/src/existing.ts", "export const value=2\n");
  git("add", "packages/demo/src/existing.ts");
  const index = git("show", ":packages/demo/src/existing.ts");
  const untouched = readFileSync(path.join(root, "packages/demo/src/unchanged.ts"), "utf8");
  const result = await checkChangedFormatting(root, { write: true });
  assert.equal(result.different.length, 1);
  assert.equal((await checkChangedFormatting(root)).different.length, 0);
  assert.equal(git("show", ":packages/demo/src/existing.ts"), index);
  assert.equal(readFileSync(path.join(root, "packages/demo/src/unchanged.ts"), "utf8"), untouched);
});

test("a base ref includes committed branch changes and invalid refs fail", (t) => {
  const { root, git, put } = fixture(t);
  git("branch", "fixture-base");
  put("packages/demo/src/committed.ts", "export const committed = 1;\n");
  git("add", ".");
  git("commit", "-qm", "fixture branch change");
  assert.deepEqual(changedSourceFiles(root), []);
  assert.deepEqual(changedSourceFiles(root, "fixture-base"), ["packages/demo/src/committed.ts"]);
  assert.throws(() => changedSourceFiles(root, "missing-ref"));
});
