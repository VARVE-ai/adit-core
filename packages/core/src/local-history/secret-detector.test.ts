import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  SECRET_RULES,
  scanSecrets,
  redactSecrets,
  redactSecretWindow,
  redactSecretValue,
  scanSecretField,
} from "./secret-detector.js";
const material = (n: number) =>
  Array.from({ length: Math.ceil(n / 64) }, (_, i) =>
    createHash("sha256").update(`synthetic-inspection-${i}`).digest("hex"),
  )
    .join("")
    .slice(0, n);
const examples: Record<string, string> = {
  "anthropic-key": "sk-ant-" + material(56),
  "openai-key": "sk-svcacct-" + material(56),
  "github-pat": "ghp_" + material(36),
  "gitlab-pat": "glpat-" + material(26),
  "npm-token": "npm_" + material(36),
  "pypi-token": "pypi-AgEIcHlwaS5vcmcC" + material(90),
  "huggingface-token": "hf_" + material(36),
  "aws-access-key": "AKIA" + material(16).toUpperCase(),
  "google-api-key": "AIza" + material(35),
  "slack-token": "xoxb-" + material(24),
  "stripe-secret": "sk_live_" + material(36),
  "sendgrid-key": "SG." + material(22) + "." + material(43),
  "private-key-block":
    "-----BEGIN PRIVATE KEY-----\n" +
    material(64) +
    "\n-----END PRIVATE KEY-----",
  "basic-auth-url": "https://user:synthetic-password@host.test/path",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signatureForTesting",
  "high-entropy-assignment": "API_KEY=" + material(40),
};
it.each(Object.keys(examples))(
  "detects and masks %s without exposing its suffix",
  (rule) => {
    const text = examples[rule],
      found = scanSecrets(text).find((m) => m.rule === rule)!;
    expect(found).toBeDefined();
    expect(redactSecrets(text)).not.toContain(
      text.slice(found.start, found.end),
    );
    expect(found.masked.endsWith("••••••••")).toBe(true);
  },
);
it("keeps thirteen fast rules, excludes placeholder shapes and suppresses candidate overlap", () => {
  expect(SECRET_RULES.filter((r) => r.confidence === "definite")).toHaveLength(
    13,
  );
  expect(SECRET_RULES).toHaveLength(16);
  expect(scanSecrets(examples.jwt, true)).toEqual([]);
  for (const s of [
    "sk-ant-" + "a".repeat(45),
    "ghp_" + "A1b2".repeat(9),
    "AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----",
  ])
    expect(scanSecrets(s)).toEqual([]);
  expect(scanSecrets("API_KEY=" + examples["anthropic-key"])).toHaveLength(1);
});
it("masks complete values before extracting windows and preserves UTF-16 positions", () => {
  const key = examples["anthropic-key"],
    full = "中文😀\r\nAPI_KEY=" + key + "\r\nend";
  const match = scanSecrets(full)[0];
  expect(full.slice(match.start, match.end)).toBe(key);
  const snippet = redactSecretWindow(full, match.start + 8, match.start + 20);
  expect(snippet).toBe("sk-ant-••••••••");
  expect(redactSecretWindow("token=" + material(40), 8, 14)).toBe("••••••••");
  expect(redactSecretWindow(examples["private-key-block"], 10, 38)).toBe(
    "••••••••",
  );
  expect(
    JSON.stringify(
      redactSecretValue({ items: [{ title: key, body: "x " + key }] }),
    ),
  ).not.toContain(key);
});
it("locates a URL password even when it is also the username", () => {
  const value = "https://same:same@host.test";
  const m = scanSecrets(value)[0];
  expect(m.start).toBe(value.lastIndexOf("same"));
  expect(redactSecrets(value)).toBe("https://same:••••••••@host.test");
});
it("handles a large tool result and reuses its masks for each evidence window", () => {
  const line = "API_KEY=" + material(40),
    text = Array(12000).fill(line).join("\n");
  const scanned = scanSecretField(text);
  expect(scanned.matches).toHaveLength(12000);
  for (const m of scanned.matches)
    expect(scanned.window(m.start, m.end)).toBe("••••••••");
});
it("redacts credential-valued JSON properties without corrupting ordinary identifiers", () => {
  const value = material(40),
    data = redactSecretValue({
      id: value,
      api_key: value,
      token: examples.jwt,
      nested: { [examples["anthropic-key"]]: "value" },
    });
  expect(data.id).toBe(value);
  expect(data.api_key).toBe("••••••••");
  expect(data.token).not.toBe(examples.jwt);
  expect(JSON.stringify(data.nested)).not.toContain(examples["anthropic-key"]);
});
