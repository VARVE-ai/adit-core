const VALUE_OPTIONS = new Set([
  "-c", "--config",
  "--enable", "--disable",
  "-m", "--model",
  "-p", "--profile",
  "-s", "--sandbox",
  "-a", "--ask-for-approval",
  "-C", "--cd",
  "--add-dir",
  "--local-provider",
  "--remote", "--remote-auth-token-env",
]);

const SESSION_SELECTION_OPTIONS = new Set([
  "--last", "--all", "--include-non-interactive",
]);

export function codexRestartArgs(args: readonly string[]): string[] {
  const retained: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;

    const option = arg.split("=", 1)[0];
    if (SESSION_SELECTION_OPTIONS.has(option)) continue;
    if (option === "--image" || arg.startsWith("-i")) {
      if (arg === "--image" || arg === "-i") index += 1;
      continue;
    }

    retained.push(arg);
    if (VALUE_OPTIONS.has(arg) && index + 1 < args.length) {
      retained.push(args[index + 1]);
      index += 1;
    }
  }
  return retained;
}
