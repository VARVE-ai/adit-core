import { parse, type AnyNode } from "acorn";
import { isDeepStrictEqual } from "node:util";

type Value = string | number | boolean | null | undefined | Value[] | { [key: string]: Value };
type Scope = Map<string, Value>;

export interface DecodedExecCall {
  executionIndex?: number;
  command: string;
  cwd?: string;
  output: string;
  exitCode?: number;
  running: boolean;
}

/**
 * Decode a small, data-only subset of desktop exec programs. Never evaluate
 * transcript JavaScript. Every shell call must be awaited and its result
 * printed before the next call, so output order proves the pairing. Comparing
 * the printed value also checks labels such as `repo` against loop bindings.
 * Unsupported programs fail closed instead of returning partial commands.
 */
export function decodeExecProgram(source: string, outputs: string[]): DecodedExecCall[] {
  if (source.length > 256_000 || outputs.length > 100) return [];
  const calls: DecodedExecCall[] = [];
  let cursor = 0;
  let pending: string | undefined;
  let budget = 10_000;
  let loop = false;
  const unsupported = (): never => { throw new Error("Unsupported exec transcript"); };
  const tick = () => { if (--budget < 0) unsupported(); };

  function object(value: Value): { [key: string]: Value } {
    if (!value || typeof value !== "object" || Array.isArray(value)) return unsupported();
    return value;
  }

  function bind(node: AnyNode, value: Value, scope: Scope): void {
    if (node.type === "Identifier") scope.set(node.name, value);
    else if (node.type === "ArrayPattern" && Array.isArray(value)) {
      node.elements.forEach((element, index) => {
        if (element) bind(element, value[index], scope);
      });
    } else unsupported();
  }

  function expression(node: AnyNode, scope: Scope): Value {
    tick();
    switch (node.type) {
      case "Literal":
        if (node.value === null || ["string", "number", "boolean"].includes(typeof node.value))
          return node.value as Value;
        return unsupported();
      case "Identifier":
        if (!scope.has(node.name)) return unsupported();
        return scope.get(node.name);
      case "ArrayExpression":
        return node.elements.map((element) => element ? expression(element, scope) : unsupported());
      case "ObjectExpression": {
        const result: { [key: string]: Value } = Object.create(null);
        for (const property of node.properties) {
          if (property.type === "SpreadElement") Object.assign(result, object(expression(property.argument, scope)));
          else {
            if (property.kind !== "init" || property.method || property.computed) return unsupported();
            const key = property.key.type === "Identifier" ? property.key.name : expression(property.key, scope);
            if (typeof key !== "string") return unsupported();
            result[key] = expression(property.value, scope);
          }
        }
        return result;
      }
      case "TemplateLiteral": {
        let result = node.quasis[0].value.cooked ?? unsupported();
        for (let index = 0; index < node.expressions.length; index++) {
          const value = expression(node.expressions[index], scope);
          if (typeof value !== "string" && typeof value !== "number") return unsupported();
          result += String(value) + (node.quasis[index + 1].value.cooked ?? unsupported());
        }
        return result;
      }
      case "BinaryExpression": {
        const left = expression(node.left, scope), right = expression(node.right, scope);
        if (node.operator === "===") return left === right;
        if (node.operator === "!==") return left !== right;
        if (node.operator === "+" && typeof left === "string" && typeof right === "string") return left + right;
        return unsupported();
      }
      case "LogicalExpression": {
        const left = expression(node.left, scope);
        if (node.operator === "||") return left || expression(node.right, scope);
        if (node.operator === "&&") return left && expression(node.right, scope);
        return unsupported();
      }
      case "UnaryExpression":
        if (node.operator === "!") return !expression(node.argument, scope);
        return unsupported();
      case "MemberExpression": {
        if (node.computed || node.property.type !== "Identifier") return unsupported();
        const value = object(expression(node.object, scope));
        return Object.hasOwn(value, node.property.name) ? value[node.property.name] : undefined;
      }
      case "AwaitExpression": {
        const call = node.argument;
        if (call.type !== "CallExpression" || !isMember(call.callee, "tools", "exec_command") ||
            scope.has("tools") || call.arguments.length !== 1 || pending !== undefined) return unsupported();
        const args = object(expression(call.arguments[0], scope));
        if (typeof args.cmd !== "string" || !args.cmd ||
            (args.workdir !== undefined && typeof args.workdir !== "string")) return unsupported();
        const printed = outputs[cursor++];
        if (printed === undefined) return unsupported();
        const decoded = decodeResult(printed);
        calls.push({ command: args.cmd, cwd: args.workdir as string | undefined,
          output: decoded.output, exitCode: decoded.exitCode, running: decoded.running });
        pending = printed;
        return decoded.value;
      }
      case "CallExpression": {
        if (node.arguments.length !== 1) return unsupported();
        if (isMember(node.callee, "JSON", "stringify") && !scope.has("JSON"))
          return JSON.stringify(expression(node.arguments[0], scope));
        if (node.callee.type !== "Identifier" || node.callee.name !== "text" || scope.has("text")) return unsupported();
        const value = expression(node.arguments[0], scope);
        if (pending === undefined) return unsupported();
        const rendered = typeof value === "string" ? value : JSON.stringify(value);
        if (rendered === undefined || !sameOutput(rendered, pending)) return unsupported();
        pending = undefined;
        return undefined;
      }
      default: return unsupported();
    }
  }

  function statement(node: AnyNode, scope: Scope): "break" | "stop" | undefined {
    tick();
    switch (node.type) {
      case "Program":
      case "BlockStatement": {
        const child = new Map(scope);
        for (const item of node.body) {
          const control = statement(item, child);
          if (control) return control;
        }
        return;
      }
      case "VariableDeclaration":
        if (node.kind !== "const") return unsupported();
        for (const declaration of node.declarations) {
          if (!declaration.init) return unsupported();
          bind(declaration.id, expression(declaration.init, scope), scope);
        }
        return;
      case "ExpressionStatement":
        expression(node.expression, scope);
        return;
      case "ForOfStatement": {
        loop = true;
        if (node.await || node.left.type !== "VariableDeclaration" || node.left.kind !== "const" ||
            node.left.declarations.length !== 1) return unsupported();
        const values = expression(node.right, scope);
        if (!Array.isArray(values) || values.length > 100) return unsupported();
        for (const value of values) {
          const child = new Map(scope);
          bind(node.left.declarations[0].id, value, child);
          const control = statement(node.body, child);
          if (control === "stop") return control;
          if (control === "break") break;
        }
        return;
      }
      case "IfStatement":
        if (expression(node.test, scope)) return statement(node.consequent, scope);
        if (node.alternate) return statement(node.alternate, scope);
        return;
      case "BreakStatement":
        if (node.label) return unsupported();
        return "break";
      case "ThrowStatement": return "stop";
      case "EmptyStatement": return;
      default: return unsupported();
    }
  }

  try {
    statement(parse(source, { ecmaVersion: "latest", sourceType: "module" }), new Map());
    if (pending !== undefined || cursor !== outputs.length) return [];
    return calls.map((call, index) => ({ ...call, executionIndex: loop || calls.length > 1 ? index : undefined }));
  } catch {
    return [];
  }
}

function isMember(node: AnyNode, owner: string, name: string): boolean {
  return node.type === "MemberExpression" && !node.computed &&
    node.object.type === "Identifier" && node.object.name === owner &&
    node.property.type === "Identifier" && node.property.name === name;
}

function sameOutput(left: string, right: string): boolean {
  if (left.trim() === right.trim()) return true;
  try { return isDeepStrictEqual(JSON.parse(left), JSON.parse(right)); }
  catch { return false; }
}

function decodeResult(printed: string): {
  value: Value; output: string; exitCode?: number; running: boolean;
} {
  let value: Record<string, Value> | undefined;
  try {
    const parsed = JSON.parse(printed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed;
  } catch { /* Plain text from text(result.output). */ }
  if (value && "wall_time_seconds" in value && ("exit_code" in value || "session_id" in value)) {
    if (typeof value.output !== "string") throw new Error("Missing shell output");
    // Labels printed alongside the result are not fields returned by exec_command.
    const native: Record<string, Value> = {};
    for (const key of ["chunk_id", "wall_time_seconds", "exit_code", "session_id", "original_token_count", "output"])
      if (Object.hasOwn(value, key)) native[key] = value[key];
    return { value: native, output: value.output,
      exitCode: typeof value.exit_code === "number" ? value.exit_code : undefined,
      running: value.session_id !== undefined && value.exit_code == null };
  }
  return { value: { output: printed }, output: printed, running: false };
}
