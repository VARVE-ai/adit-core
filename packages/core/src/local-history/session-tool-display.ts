import { parse } from "acorn";

export type SessionToolIcon =
  | "read"
  | "search"
  | "edit"
  | "write"
  | "list"
  | "web"
  | "git"
  | "terminal"
  | "plan"
  | "task"
  | "tool";
export type SessionToolDisplay = {
  name: string;
  text: string;
  kind: "command" | "plan" | "task" | "tool";
  icon?: SessionToolIcon;
};
const shortName = (name: string) => name.replace(/^(?:tools|functions)\./, "");
const commandTool =
  /^(?:exec_command|shell_command|run_shell_command|run_in_terminal|bash|powershell|shell|terminal)$/i;
function namedIcon(name: string): SessionToolIcon {
  const executable = name
    .split(/[\\/]/)
    .pop()!
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (
    /^(read|read_file|readfile|view_file|cat|get-content|head|tail)$/.test(
      executable,
    )
  )
    return "read";
  if (
    /^(grep|glob|rg|ripgrep|select-string|find|find_files|search|search_files|codebase_search|file_search|grep_search)$/.test(
      executable,
    )
  )
    return "search";
  if (
    /^(edit|edit_file|multiedit|multi_edit|notebookedit|apply_patch|applypatch|patch|replace_in_file|set-content|add-content|out-file)$/.test(
      executable,
    )
  )
    return "edit";
  if (
    /^(write|write_file|writefile|create_file|new-item|touch|mkdir)$/.test(
      executable,
    )
  )
    return "write";
  if (
    /^(ls|dir|get-childitem|list_dir|list_directory|list_files)$/.test(
      executable,
    )
  )
    return "list";
  if (
    /^(webfetch|web_fetch|websearch|web_search|fetch_url|curl|wget|invoke-webrequest|invoke-restmethod)$/.test(
      executable,
    )
  )
    return "web";
  if (executable === "git") return "git";
  if (/^(update_plan|todowrite|todo_write)$/.test(executable)) return "plan";
  if (/^(task|agent|spawn_agent)$/.test(executable)) return "task";
  return "tool";
}
function commandIcon(command: unknown): SessionToolIcon {
  if (typeof command !== "string") return "terminal";
  // Only inspect the first executable, never words inside arguments or script bodies.
  // A quoted executable is supported only with PowerShell's explicit invocation operator.
  const source = command.trimStart();
  const invoked = /^&\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(source);
  const name = invoked
    ? invoked[1] || invoked[2] || invoked[3]
    : /^[\w./\\:-]+(?=\s|[;&|]|$)/.exec(source)?.[0];
  const icon = name ? namedIcon(name) : "tool";
  return icon === "tool" ? "terminal" : icon;
}
function native(
  name: string,
  input: any,
  command?: string | null,
  file?: string | null,
): SessionToolDisplay {
  name = shortName(name);
  const kind =
    commandTool.test(name) && !input?.description && !input?.title
      ? "command"
      : /^(?:update_plan|TodoWrite)$/i.test(name)
        ? "plan"
        : /^(?:Task|Agent|spawn_agent)$/i.test(name)
          ? "task"
          : "tool";
  const steps = input?.plan || input?.todos;
  const text =
    kind === "plan" && Array.isArray(steps)
      ? steps
          .map((p) => p.step || p.content)
          .filter(Boolean)
          .join(" → ")
      : input?.description ||
        input?.title ||
        command ||
        input?.cmd ||
        input?.command ||
        file ||
        input?.file_path ||
        input?.path ||
        "";
  const icon = commandTool.test(name)
    ? commandIcon(command || input?.cmd || input?.command)
    : namedIcon(name);
  return { name, text: typeof text === "string" ? text : "", kind, icon };
}

/** Read literal labels from the original call. Never execute scripts or invent a purpose. */
export function sessionToolDisplay(
  name: string,
  input: any,
  command?: string | null,
  file?: string | null,
): SessionToolDisplay {
  const base = native(name, input, command, file);
  if (!/^(?:exec|js)$/.test(base.name)) return base;
  const source =
    typeof input === "string" ? input : input?.code || input?.script;
  if (typeof source !== "string" || source.length > 64000) return base;
  try {
    const tree = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    });
    const calls: SessionToolDisplay[] = [];
    const value = (node: any): any => {
      if (node?.type === "Literal") return node.value;
      if (node?.type === "TemplateLiteral" && !node.expressions.length)
        return node.quasis[0].value.cooked;
      if (node?.type === "ArrayExpression") return node.elements.map(value);
      if (node?.type === "ObjectExpression")
        return Object.fromEntries(
          node.properties
            .filter(
              (p: any) => p.type === "Property" && !p.computed && !p.method,
            )
            .map((p: any) => [p.key.name || p.key.value, value(p.value)]),
        );
      return undefined;
    };
    const visit = (node: any) => {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "MemberExpression" &&
        node.callee.object?.name === "tools" &&
        !node.callee.computed
      ) {
        const label = native(
          node.callee.property.name,
          value(node.arguments[0]),
        );
        calls.push(label);
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child === "object") visit(child);
      }
    };
    visit(tree);
    if (!calls.length) return base;
    return {
      name: [...new Set(calls.map((c) => c.name))].join(" · "),
      text: calls
        .map((c) => c.text)
        .filter(Boolean)
        .join(" · "),
      kind: calls.every((c) => c.kind === calls[0].kind)
        ? calls[0].kind
        : "tool",
      icon: calls.every((c) => c.icon === calls[0].icon)
        ? calls[0].icon
        : calls.every((c) => commandTool.test(c.name))
          ? "terminal"
          : "tool",
    };
  } catch {
    return base;
  }
}
