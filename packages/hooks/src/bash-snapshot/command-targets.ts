import { dirname, isAbsolute, relative, resolve } from "node:path";

const MAX_TARGETS = 512;
const MAX_COMMAND_LENGTH = 256 * 1024;
type Values = string[];
type Bindings = Map<string, Values>;
interface Token { text: string; literal?: boolean }

export function repositoryTargets(targets: string[], repositoryPath: string): string[] {
  return [...new Set(targets.map((target) => relative(repositoryPath, target).replace(/\\/gu, "/")))]
    .filter((target) => target && target !== ".." && !target.startsWith("../") && !isAbsolute(target)
      && !target.split("/").some((part) => part === ".git" || part === ".adit"));
}

export function commandWriteTargets(command: string, initialCwd: string): string[] {
  if (!command || command.length > MAX_COMMAND_LENGTH) return [];
  const targets = new Set<string>();
  const bodies = new Map<string, string>();
  let bodyIndex = 0;
  const rememberBody = (body: string): string => {
    const key = "__adit_inline_body_" + bodyIndex++;
    bodies.set(key, body);
    return key;
  };
  const shell = command.replace(/@(['"])\r?\n([\s\S]*?)\r?\n\1@/gu,
    (_match, _quote: string, body: string) => rememberBody(body))
    .replace(/<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\r?\n([\s\S]*?)\r?\n\2(?=\s|$)/gu,
      (_match, _quote: string, _delimiter: string, body: string) => " " + rememberBody(body));
  const bindings: Bindings = new Map();
  const generatedScripts = new Map<string, string>();
  const directoryStack: string[] = [];
  let cwd = initialCwd;
  let pipedBody: string | undefined;
  const add = (values: Values) => {
    for (const value of values) {
      if (targets.size >= MAX_TARGETS) break;
      if (!value || /[\r\n\0*$?<>|]/u.test(value) || value === "." || value === "..") continue;
      targets.add(resolve(cwd, value));
    }
  };
  for (const segment of shellSegments(shell)) {
    const words = shellWords(segment.text);
    if (!words.length) continue;
    const executable = (words[0] ?? "").replace(/\\/gu, "/").split("/").at(-1)?.toLowerCase();
    const valueOf = (word: string | undefined): Values => {
      if (!word) return [];
      if (word.startsWith("$")) return bindings.get(word.slice(1)) ?? [];
      return [word];
    };
    const assignment = segment.text.match(/^\s*\$([\w]+)\s*=\s*([\s\S]+)$/u);
    if (assignment) {
      const assignedWords = shellWords(assignment[2]);
      const values = /^join-path$/iu.test(assignedWords[0] ?? "")
        ? combine(valueOf(assignedWords[1]), valueOf(assignedWords[2]), "/")
        : expression(lex(assignment[2]), 0, bindings).values;
      bindings.set(assignment[1], values);
    }
    if (executable === "pop-location") {
      const restored = directoryStack.pop();
      if (!restored) break;
      cwd = restored;
      continue;
    }
    if (["cd", "set-location", "push-location"].includes(executable ?? "")) {
      const pathIndex = /^-(?:literalpath|path)$/iu.test(words[1] ?? "") ? 2 : 1;
      const values = valueOf(words[pathIndex]);
      if (values.length !== 1 || /[$*?]/u.test(values[0])) break;
      if (executable === "push-location") directoryStack.push(cwd);
      cwd = resolve(cwd, executable === "cd" ? values[0] : normalizePowerShellPath(values[0]));
      continue;
    }
    const bodyKey = words.find((word) => bodies.has(word));
    const body = bodyKey ? bodies.get(bodyKey) : undefined;
    const inputBody = body ?? pipedBody;
    for (const destination of redirections(segment.text)) {
      if (destination?.startsWith("&") || /^(?:\/dev\/null|nul)$/iu.test(destination ?? "")) continue;
      const paths = valueOf(destination);
      add(paths);
      if (inputBody) for (const path of paths) generatedScripts.set(resolve(cwd, path), inputBody);
    }
    if (/^(?:set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|rename-item)$/u.test(executable ?? "")) {
      const positional: string[] = [];
      const named = new Map<string, string>();
      for (let index = 1; index < words.length; index++) {
        const word = words[index];
        if (word.startsWith("-")) {
          if (/^-(?:force|recurse|append|noNewline|confirm|whatif)$/iu.test(word)) continue;
          if (words[index + 1]) named.set(word.toLowerCase(), words[++index]);
        } else positional.push(word);
      }
      const source = valueOf(named.get("-literalpath") ?? named.get("-path") ?? named.get("-filepath") ?? positional[0]).map(normalizePowerShellPath);
      const destination = valueOf(named.get("-destination") ?? named.get("-newname") ?? positional[1]).map(normalizePowerShellPath);
      if (executable !== "copy-item") add(source);
      if (executable === "rename-item") add(source.flatMap((path) => destination.map((name) => resolve(cwd, dirname(path), name))));
      else if (["copy-item", "move-item"].includes(executable!)) add(destination);
      if (inputBody && executable === "set-content") for (const path of source) generatedScripts.set(resolve(cwd, path), inputBody);
    }
    if (["rm", "touch", "tee", "cp", "mv"].includes(executable ?? "")) {
      const paths = words.slice(1).filter((word) => !word.startsWith("-"));
      add((executable === "cp" ? paths.slice(-1) : paths).flatMap(valueOf));
    }
    if (executable === "sed" && words.some((word) => /^-i/u.test(word))) add(valueOf(words.at(-1)));
    if (/^(?:python[\d.]*|node|nodejs)(?:\.exe)?$/u.test(executable ?? "")) {
      const inlineIndex = words.findIndex((word) => ["-c", "-e", "--eval"].includes(word));
      const script = inlineIndex >= 0 ? words[inlineIndex + 1] : inputBody;
      if (script) scriptTargets(script, new Map(), add);
      else {
        const scriptPath = words.slice(1).find((word) => !word.startsWith("-"));
        const generated = scriptPath ? generatedScripts.get(resolve(cwd, scriptPath)) : undefined;
        if (generated) scriptTargets(generated, new Map(), add);
      }
    }
    if (/^(?:apply_patch|patch)$/u.test(executable ?? "")) {
      const patch = inputBody ?? words.slice(1).join("\n");
      for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu)) add([match[1].trim()]);
      const strip = Number(words.find((word) => /^-p\d+$/u.test(word))?.slice(2) ?? 0);
      for (const match of patch.matchAll(/^(?:---|\+\+\+) ([^\t\r\n]+)/gmu)) {
        if (match[1] !== "/dev/null") add([match[1].split("/").slice(strip).join("/")]);
      }
    }
    if (/^\s*\[(?:System\.)?IO\.File\]::/iu.test(segment.text)) scriptTargets(segment.text.replace(/\[(?:System\.)?IO\.File\]::/giu, "fs."), bindings, add);
    pipedBody = segment.separator === "|" ? inputBody : undefined;
  }
  return [...targets];
}

function normalizePowerShellPath(path: string): string {
  return path.replace(/\\/gu, "/");
}

function shellSegments(command: string): Array<{ text: string; separator: string }> {
  const segments: Array<{ text: string; separator: string }> = [];
  let start = 0;
  let quote = "";
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote && command[index - 1] !== "\\") quote = "";
    } else if (char === "'" || char === '"') quote = char;
    else if (char === ";" || char === "\n" || char === "|" || (char === "&" && command[index + 1] === "&")) {
      segments.push({ text: command.slice(start, index), separator: char });
      if (command[index + 1] === char && (char === "&" || char === "|")) index++;
      start = index + 1;
    }
  }
  segments.push({ text: command.slice(start), separator: "" });
  return segments;
}

function shellWords(text: string): string[] {
  return [...text.matchAll(/(?:"(?:\\"|[^"])*"|'[^']*'|[^\s"'])+/gu)]
    .map((match) => match[0].replace(/^(['"])([\s\S]*)\1$/u, "$2"));
}

function redirections(text: string): string[] {
  const paths: string[] = [];
  let quote = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote && text[index - 1] !== "\\") quote = "";
    } else if (char === "'" || char === '"') quote = char;
    else if (char === ">") {
      if (text[index + 1] === ">") index++;
      const target = shellWords(text.slice(index + 1))[0];
      if (target) paths.push(target);
    }
  }
  return paths;
}

function lex(text: string): Token[] {
  return [...text.matchAll(/#[^\n]*|\/\/[^\n]*|(?:r)?"""[\s\S]*?"""|(?:r)?'''[\s\S]*?'''|(?:r)?"(?:\\.|[^"\\])*"|(?:r)?'(?:\\.|[^'\\])*'|[\w$]+|[^\s]/gu)]
    .filter((match) => !match[0].startsWith("#") && !match[0].startsWith("//"))
    .map((match) => {
      const literal = match[0].match(/^(r)?("""|'''|['"])([\s\S]*)\2$/u);
      return literal ? { text: literal[1] ? literal[3] : literal[3].replace(/\\([\\'"])/gu, "$1"), literal: true } : { text: match[0] };
    });
}

function combine(left: Values, right: Values, separator: string): Values {
  const values: Values = [];
  for (const base of left) {
    for (const part of right) {
      if (values.length >= MAX_TARGETS) return values;
      values.push(base + separator + part);
    }
  }
  return values;
}

function expression(tokens: Token[], start: number, bindings: Bindings, depth = 0): { values: Values; end: number } {
  if (depth > 32) return { values: [], end: tokens.length };
  let index = start;
  const token = tokens[index++];
  if (!token) return { values: [], end: index };
  let values: Values = token.literal ? [token.text] : bindings.get(token.text.replace(/^\$/u, "")) ?? [];
  let name = token.text;
  if (!token.literal && tokens[index]?.text === "." && tokens[index + 2]?.text === "(" && ["Path", "join", "resolve"].includes(tokens[index + 1].text)) {
    name += "." + tokens[index + 1].text;
    index += 2;
  }
  if (!token.literal && tokens[index]?.text === "(") {
    const args: Values[] = [];
    index++;
    while (index < tokens.length && tokens[index].text !== ")") {
      const argument = expression(tokens, index, bindings, depth + 1);
      args.push(argument.values);
      index = argument.end;
      if (tokens[index]?.text !== ",") break;
      index++;
    }
    if (tokens[index]?.text === ")") index++;
    if (["Path", "pathlib.Path"].includes(name)) values = args[0] ?? [];
    else if (["path.join", "path.resolve", "join", "resolve", "os.path.join"].includes(name)) {
      values = args.reduce((result, argument, offset) => offset === 0 ? argument : combine(result, argument, "/"), [] as Values);
    } else values = [];
  } else if (!token.literal && (token.text === "[" || token.text === "(")) {
    values = [];
    const close = token.text === "[" ? "]" : ")";
    while (index < tokens.length && tokens[index].text !== close) {
      const element = expression(tokens, index, bindings, depth + 1);
      values.push(...element.values);
      index = element.end;
      if (tokens[index]?.text !== ",") break;
      index++;
    }
    if (tokens[index]?.text === close) index++;
  }
  while (["/", "+"].includes(tokens[index]?.text ?? "")) {
    const separator = tokens[index++].text === "/" ? "/" : "";
    const right = expression(tokens, index, bindings, depth + 1);
    values = combine(values, right.values, separator);
    index = right.end;
  }
  return { values: values.slice(0, MAX_TARGETS), end: index };
}

function bindLoop(tokens: Token[], start: number, bindings: Bindings): void {
  const names: string[] = [];
  let index = start + 1;
  while (index < tokens.length && names.length < 8 && /^[\w]+$/u.test(tokens[index].text)) {
    names.push(tokens[index++].text);
    if (tokens[index]?.text !== ",") break;
    index++;
  }
  if (tokens[index++]?.text !== "in") return;
  const columns: Values[] = names.map(() => []);
  if (tokens[index]?.text === "{") {
    let depth = 0;
    for (; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.literal && depth === 1 && tokens[index + 1]?.text === ":") columns[0]?.push(token.text);
      if (!token.literal && ["{", "[", "("].includes(token.text)) depth++;
      if (!token.literal && ["}", "]", ")"].includes(token.text) && --depth === 0) break;
    }
  } else if (names.length > 1 && tokens[index]?.text === "[") {
    index++;
    while (tokens[index]?.text === "(") {
      index++;
      for (const column of columns) {
        const value = expression(tokens, index, bindings);
        column.push(...value.values);
        index = value.end;
        if (tokens[index]?.text === ",") index++;
      }
      if (tokens[index++]?.text !== ")") break;
      if (tokens[index]?.text === ",") index++;
    }
  } else columns[0] = expression(tokens, index, bindings).values;
  names.forEach((name, column) => bindings.set(name, columns[column].slice(0, MAX_TARGETS)));
}

function scriptTargets(body: string, bindings: Bindings, add: (values: Values) => void): void {
  const tokens = lex(body);
  const pathBindings = new Set<string>();
  const isPath = (index: number): boolean => tokens[index]?.text === "Path"
    || (tokens[index]?.text === "pathlib" && tokens[index + 2]?.text === "Path")
    || pathBindings.has(tokens[index]?.text ?? "");
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.literal) continue;
    if (/^[\w$]+$/u.test(token.text) && tokens[index + 1]?.text === "=" && tokens[index + 2]?.text !== "=") {
      const assigned = expression(tokens, index + 2, bindings);
      const readsContent = tokens[assigned.end]?.text === "." && ["read_text", "read_bytes"].includes(tokens[assigned.end + 1]?.text ?? "");
      bindings.set(token.text.replace(/^\$/u, ""), readsContent ? [] : assigned.values);
      if (isPath(index + 2) && !readsContent) pathBindings.add(token.text);
      else pathBindings.delete(token.text);
    }
    if (token.text === "for") bindLoop(tokens, index, bindings);
    const receiver = expression(tokens, index, bindings);
    if (isPath(index) && tokens[receiver.end]?.text === "." && /^(?:write_text|write_bytes|unlink|rename|replace)$/u.test(tokens[receiver.end + 1]?.text ?? "") && tokens[receiver.end + 2]?.text === "(") {
      add(receiver.values);
      if (["rename", "replace"].includes(tokens[receiver.end + 1].text)) add(expression(tokens, receiver.end + 3, bindings).values);
    }
    if (/^(?:writeFileSync|writeFile|appendFileSync|appendFile|WriteAllText|WriteAllLines|AppendAllText|unlinkSync|unlink|remove|renameSync|rename|copyFileSync|copyFile)$/u.test(token.text) && tokens[index + 1]?.text === "(") {
      const first = expression(tokens, index + 2, bindings);
      if (!/^copyFile/u.test(token.text)) add(first.values);
      if (/^(?:rename|copyFile)/u.test(token.text) && tokens[first.end]?.text === ",") add(expression(tokens, first.end + 1, bindings).values);
    }
    if (token.text === "open" && tokens[index + 1]?.text === "(") {
      const path = expression(tokens, index + 2, bindings);
      const mode = tokens[path.end + 1];
      if (tokens[path.end]?.text === "," && mode?.literal && /[wax+]/u.test(mode.text)) add(path.values);
    }
  }
}
