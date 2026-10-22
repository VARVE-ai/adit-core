import { parse } from "acorn";
export const COMMAND_PARSER_VERSION = 2;

const commandTools =
  /^(?:.*\.)?(?:exec_command|shell_command|run_shell_command|run_in_terminal|bash|powershell|shell|terminal)$/i;
const rejected =
  /(?:approval.{0,30}(?:reject|denied)|rejected by user|execution (?:denied|cancelled)|permission denied by policy)/i;
/** Count guaranteed, awaited command calls in supported scripts. Never execute a script. */
export function scriptCommands(source: string): number | null {
  let tree: any;
  try {
    tree = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return null;
  }
  const path = (node: any): string =>
    node?.type === "Identifier"
      ? node.name
      : node?.type === "MemberExpression" && !node.computed
        ? path(node.object) + "." + path(node.property)
        : "";
  const expression = (node: any, awaited = false): number | null => {
    if (!node) return 0;
    if (node.type === "AwaitExpression") return expression(node.argument, true);
    if (node.type !== "CallExpression")
      return /^(Literal|Identifier|ObjectExpression|ArrayExpression)$/.test(
        node.type,
      )
        ? 0
        : null;
    const name = path(node.callee);
    if (name.startsWith("tools.") && commandTools.test(name))
      return awaited ? 1 : null;
    if (
      ["text", "image", "notify", "console.log", "JSON.stringify"].includes(
        name,
      )
    ) {
      const counts = node.arguments.map((a: any) => expression(a));
      return counts.includes(null)
        ? null
        : counts.reduce((a: number, b: number) => a + b, 0);
    }
    if (
      ["Promise.all", "Promise.allSettled"].includes(name) &&
      awaited &&
      node.arguments[0]?.type === "ArrayExpression"
    ) {
      const counts = node.arguments[0].elements.map((a: any) =>
        expression(a, true),
      );
      return counts.includes(null)
        ? null
        : counts.reduce((a: number, b: number) => a + b, 0);
    }
    // Mixed tools may include polling output that must not prove a new execution.
    if (name.startsWith("tools.")) return null;
    return null;
  };
  let count = 0;
  for (const node of tree.body) {
    if (node.type === "EmptyStatement") continue;
    const values =
      node.type === "ExpressionStatement"
        ? [expression(node.expression)]
        : node.type === "VariableDeclaration"
          ? node.declarations.map((d: any) => expression(d.init))
          : [null];
    if (values.includes(null)) return null;
    count += values.reduce((a: number, b: number) => a + b, 0);
  }
  return count;
}
export function commandExecutions(tool: {
  name: string | null;
  command: string | null;
  input: string | null;
  result: string | null;
  resultStatus?: string;
  exitCode?: number | null;
}) {
  const name = tool.name || "",
    output = tool.result || "";
  if (
    rejected.test(output) ||
    /invalid (?:tool )?arguments|failed to parse function call|error parsing function call/i.test(
      output,
    )
  )
    return { count: 0, incomplete: true };
  if (commandTools.test(name))
    return {
      count: output || tool.exitCode != null ? 1 : 0,
      incomplete: !output && tool.exitCode == null,
    };
  if (!/(?:^|\.)(exec|js)$/.test(name)) return { count: 0, incomplete: false };
  let input: any;
  try {
    input = JSON.parse(tool.input || "null");
  } catch {
    input = tool.input;
  }
  const source =
    typeof input === "string" ? input : (input?.code ?? input?.script ?? "");
  if (
    !/tools\.(?:exec_command|shell_command|run_shell_command)\s*\(/.test(source)
  )
    return { count: 0, incomplete: false };
  const count = scriptCommands(source);
  // Wrapper completion alone does not prove execution: tool calls can return
  // approval/validation failures without throwing. Require process results too.
  const chunks = new Set([...output.matchAll(/"chunk_id"\s*:\s*"([^"\r\n]+)"/g)].map(m => m[1]));
  const processes = [...output.matchAll(/"(?:exit_code|session_id)"\s*:\s*-?\d+/g)].length;
  if (
    count !== null &&
    count > 0 &&
    chunks.size >= count && processes >= count &&
    /^Script completed\b/.test(output) &&
    !/"status"\s*:\s*"rejected"|isError["']?\s*:\s*true/.test(output)
  )
    return { count, incomplete: false };
  return { count: 0, incomplete: true };
}
