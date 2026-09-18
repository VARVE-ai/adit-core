import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { commandWriteTargets, repositoryTargets } from "./command-targets.js";

const root = resolve("test-command-targets");
const paths = (...files: string[]) => files.map((file) => resolve(root, file)).sort();
const targets = (command: string) => commandWriteTargets(command, root).sort();

describe("commandWriteTargets", () => {
  it.each([
    ["printf hello > docs/note.md", ["docs/note.md"]],
    ["echo hi>>'docs/new note.md'", ["docs/new note.md"]],
    ["Set-Content -LiteralPath 'docs/new note.md' -Value hello -Encoding utf8", ["docs/new note.md"]],
    ["'hello' | Out-File -FilePath docs/note.md -Encoding utf8", ["docs/note.md"]],
    ["New-Item -ItemType File -Path docs/note.md -Force", ["docs/note.md"]],
    ["Remove-Item -LiteralPath docs/old.md", ["docs/old.md"]],
    ["cp docs/old.md docs/new.md", ["docs/new.md"]],
    ["mv docs/old.md docs/new.md", ["docs/old.md", "docs/new.md"]],
    ["sed -i '' 's/old/new/' src/file.ts", ["src/file.ts"]],
    ["cd src; printf hi > file.ts", ["src/file.ts"]],
    ["$file = 'docs/note.md'; Set-Content -Path $file -Value hello", ["docs/note.md"]],
    ["[System.IO.File]::WriteAllText('docs/note.md', 'hello')", ["docs/note.md"]],
    ["Set-Content docs\\note.md hello", ["docs/note.md"]],
    ["$root = 'docs'; $file = Join-Path $root 'note.md'; Set-Content $file hello", ["docs/note.md"]],
    ["Push-Location src; Set-Content file.ts hello; Pop-Location; Set-Content README.md hello", ["src/file.ts", "README.md"]],
    ["Rename-Item -LiteralPath src/old.ts -NewName new.ts", ["src/old.ts", "src/new.ts"]],
  ])("finds writes in %s", (command, expected) => {
    expect(targets(command)).toEqual(paths(...expected));
  });

  it.each([
    ["Set-Content -LiteralPath 'docs\\new note.md' -Value hello", ["docs/new note.md"]],
    ["Add-Content -Path docs\\note.md -Value hello", ["docs/note.md"]],
    ["'hello' | Out-File -FilePath docs\\note.md", ["docs/note.md"]],
    ["New-Item -ItemType File -Path docs\\note.md", ["docs/note.md"]],
    ["Remove-Item -LiteralPath docs\\old.md", ["docs/old.md"]],
    ["Copy-Item -LiteralPath docs\\old.md -Destination docs\\new.md", ["docs/new.md"]],
    ["Move-Item -LiteralPath docs\\old.md -Destination docs\\new.md", ["docs/old.md", "docs/new.md"]],
    ["Rename-Item -LiteralPath src\\nested\\old.ts -NewName new.ts", ["src/nested/old.ts", "src/nested/new.ts"]],
    ["$folder = 'docs\\nested'; $file = Join-Path $folder 'note.md'; Set-Content $file hello", ["docs/nested/note.md"]],
    ["Set-Location src\\nested; Set-Content file.ts hello", ["src/nested/file.ts"]],
    ["Push-Location src\\nested; Set-Content file.ts hello; Pop-Location; Set-Content README.md hello", ["src/nested/file.ts", "README.md"]],
  ])("normalizes PowerShell path separators in %s", (command, expected) => {
    expect(targets(command)).toEqual(paths(...expected));
  });

  it("preserves native path semantics outside PowerShell cmdlets", () => {
    expect(targets("touch 'docs\\literal.md'")).toEqual(paths("docs\\literal.md"));
    expect(targets("Set-Content docs\\note.md hello; touch 'docs\\literal.md'"))
      .toEqual(paths("docs/note.md", "docs\\literal.md"));
  });

  it.each(["git status", "Get-Content src/a.ts", "rg src/a.ts", "python worker.py", "node worker.js", "npm run build", "git merge feature/test", "python -c \"print('src/a.ts')\""])("does not infer writes from %s", (command) => {
    expect(targets(command)).toEqual([]);
  });

  it("extracts Python Path writes and paths assembled in the current inline body", () => {
    expect(targets("python - <<'PY'\nfrom pathlib import Path\nbase = Path('src')\nfile = base / 'one.ts'\nfile.write_text('new')\nfor name in ['two.ts', 'three.ts']:\n    file = base / name\n    file.write_text('new')\nPath('read-only.ts').read_text()\nPY"))
      .toEqual(paths("src/one.ts", "src/two.ts", "src/three.ts"));
  });

  it("extracts inline Python open writes, not reads", () => {
    expect(targets("python -c \"open('docs/write.md', 'w').write('hello'); open('docs/read.md').read()\""))
      .toEqual(paths("docs/write.md"));
  });

  it("handles literal tuple and locale dictionaries seen in real inline edits", () => {
    expect(targets("python - <<'PY'\nfrom pathlib import Path\nfor name, old, new in [('src/one.ts', 'old', 'new'), ('src/two.ts', 'old', 'new')]:\n file = Path(name)\n file.write_text(new)\nfor locale, labels in {'zh-CN': {'title':'标题'}, 'en': {'title':'Title'}}.items():\n file = Path('src/messages') / locale / 'teamWork.json'\n file.write_text('new')\nPY"))
      .toEqual(paths("src/one.ts", "src/two.ts", "src/messages/zh-CN/teamWork.json", "src/messages/en/teamWork.json"));
  });

  it("does not tokenize source code inside Python multiline strings", () => {
    expect(targets("python - <<'PY'\nfrom pathlib import Path\ntext = '''const example = \"hello\"; // don't write anything\nPath('other.ts').write_text('no')\n'''\nfile = Path('src/file.ts'); file.write_text(text)\nPY"))
      .toEqual(paths("src/file.ts"));
  });

  it("does not treat contents read from a Path as another writable Path", () => {
    expect(targets("python - <<'PY'\nfrom pathlib import Path\ntext = Path('src/read.ts').read_text()\ntext = text.replace('old', 'new')\nPY"))
      .toEqual([]);
  });

  it("does not interpret quoted command examples or string replacements as writes", () => {
    expect(targets("echo 'echo hello > src/other.ts'")).toEqual([]);
    expect(targets("python -c \"text = 'src/other.ts'; text.replace('src', 'docs')\"")).toEqual([]);
    expect(targets("node -e \"console.log('fs.writeFileSync(123)')\"")).toEqual([]);
  });

  it("extracts Node writes with path.join without treating reads as writes", () => {
    expect(targets("node -e \"const file = path.join('src', 'file.ts'); fs.writeFileSync(file, 'new'); fs.readFileSync('read.ts')\""))
      .toEqual(paths("src/file.ts"));
  });

  it("only analyzes a newly created script body if the current command executes it", () => {
    const creation = "@'\nfrom pathlib import Path\nPath('src/file.ts').write_text('hello')\n'@ | Set-Content -Encoding UTF8 output/edit.py";
    expect(targets(creation)).toEqual(paths("output/edit.py"));
    expect(targets(creation + "\npython output/edit.py")).toEqual(paths("output/edit.py", "src/file.ts"));
    expect(targets("python output/edit.py")).toEqual([]);
  });

  it("analyzes script bodies piped directly to an interpreter", () => {
    expect(targets("@'\nfrom pathlib import Path\nPath('docs/file.md').write_text('hello')\n'@ | python -"))
      .toEqual(paths("docs/file.md"));
  });

  it("extracts patch additions, deletions, updates and rename destinations", () => {
    expect(targets("apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: src/new.ts\n+hello\n*** Update File: src/old.ts\n*** Move to: src/moved.ts\n*** Delete File: docs/old.md\n*** End Patch\nPATCH"))
      .toEqual(paths("src/new.ts", "src/old.ts", "src/moved.ts", "docs/old.md"));
  });

  it("extracts unified patch paths using the declared strip count", () => {
    expect(targets("patch -p1 <<'PATCH'\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new\nPATCH"))
      .toEqual(paths("src/file.ts"));
  });

  it("limits paths to the owning repository and excludes ADIT/Git metadata", () => {
    expect(repositoryTargets(paths("src/file.ts", "../outside.ts", ".git/config", ".adit/file.json"), root))
      .toEqual(["src/file.ts"]);
  });
});
