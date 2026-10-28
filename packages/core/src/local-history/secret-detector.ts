/* Detection patterns and validation adapted from AgentsView (MIT).
 * Copyright (c) 2026 Kenn Software LLC
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
export const SECRET_RULES_VERSION = "adit-secrets-1";
export type SecretConfidence = "definite" | "candidate";
/** Coordinates are UTF-16 code units in the decoded field, never UTF-8 byte offsets. */
export interface SecretMatch {
  rule: string;
  confidence: SecretConfidence;
  start: number;
  end: number;
  masked: string;
}
type Rule = {
  id: string;
  label: string;
  pattern: RegExp;
  anchors: string[];
  prefix: number | ((s: string) => number);
  candidate?: boolean;
  validate?: (s: string) => boolean;
  group?: number;
};
function entropy(s: string) {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  return [...counts.values()].reduce(
    (h, n) => h - (n / s.length) * Math.log2(n / s.length),
    0,
  );
}
function shape(s: string): boolean {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  if (s.length >= 8 && [...counts.values()].some((n) => n * 4 >= s.length * 3))
    return false;
  for (let size = 2; size <= 6 && size * 3 <= s.length; size++)
    for (let phase = 0; phase < size; phase++) {
      const seed = s.slice(phase, phase + size);
      let covered = 0;
      for (let i = phase; i + size <= s.length; i += size)
        if (s.slice(i, i + size) === seed) covered += size;
      if (covered * 4 >= s.length * 3) return false;
    }
  let run = 1,
    direction = 0;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (Math.abs(d) !== 1) {
      run = 1;
      direction = 0;
    } else {
      run = direction === 0 || direction === d ? run + 1 : 2;
      direction = d;
      if (run >= 6) return false;
    }
  }
  return true;
}
const random = (s: string) => entropy(s) >= 3.5 && shape(s);
const tail = (s: string) => !/(.)\1{3}$/.test(s);
const prefixLength = (s: string) =>
  /^(?:sk-(?:ant|proj|svcacct|admin)-|github_pat_|ghp_|glpat-|npm_|pypi-AgEIcHlwaS5vcmcC|hf_|SG\.|[sr]k_live_|AIza|xox[baprs]-)/.exec(
    s,
  )?.[0].length || 0;
const material = (s: string) => s.slice(prefixLength(s));
const valid = (s: string) => tail(s) && random(material(s));
function pem(s: string) {
  let body = s
    .replace(/^-----BEGIN [A-Z ]*PRIVATE KEY-----/, "")
    .replace(/-----END [A-Z ]*PRIVATE KEY-----$/, "")
    .trimStart();
  if (/^[A-Za-z-]+:/.test(body))
    body = body
      .split(/\r?\n\r?\n/)
      .slice(1)
      .join("\n");
  body = body.replace(/\s/g, "");
  return (
    body.length >= 48 &&
    (body.match(/[A-Za-z0-9+/=]/g)?.length || 0) >= body.length * 0.99
  );
}
const rules: Rule[] = [
  {
    id: "anthropic-key",
    label: "Anthropic",
    pattern: /\bsk-ant-[0-9A-Za-z][0-9A-Za-z_-]{18,}/g,
    anchors: ["sk-ant-"],
    prefix: prefixLength,
    validate: valid,
  },
  {
    id: "openai-key",
    label: "OpenAI",
    pattern: /\bsk-(?:proj|svcacct|admin)-[0-9A-Za-z_-]{20,}(?![0-9A-Za-z_-])/g,
    anchors: ["sk-proj-", "sk-svcacct-", "sk-admin-"],
    prefix: prefixLength,
    validate: valid,
  },
  {
    id: "github-pat",
    label: "GitHub",
    pattern: /\b(?:ghp_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{40,})\b/g,
    anchors: ["ghp_", "github_pat_"],
    prefix: prefixLength,
    validate: (s) => random(material(s)),
  },
  {
    id: "gitlab-pat",
    label: "GitLab",
    pattern: /\bglpat-[0-9A-Za-z_-]{20,}(?![0-9A-Za-z_-])/g,
    anchors: ["glpat-"],
    prefix: 6,
    validate: valid,
  },
  {
    id: "npm-token",
    label: "npm",
    pattern: /\bnpm_[0-9A-Za-z]{36}\b/g,
    anchors: ["npm_"],
    prefix: 4,
    validate: (s) => tail(s) && shape(material(s)),
  },
  {
    id: "pypi-token",
    label: "PyPI",
    pattern: /\bpypi-AgEIcHlwaS5vcmcC[0-9A-Za-z_-]{69,}(?![0-9A-Za-z_-])/g,
    anchors: ["pypi-"],
    prefix: 5,
    validate: valid,
  },
  {
    id: "huggingface-token",
    label: "Hugging Face",
    pattern: /\bhf_[0-9A-Za-z]{30,}\b/g,
    anchors: ["hf_"],
    prefix: 3,
    validate: valid,
  },
  {
    id: "aws-access-key",
    label: "AWS",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    anchors: ["AKIA", "ASIA"],
    prefix: 4,
    validate: (s) => !/EXAMPL|IOSFODNN/.test(s) && shape(s.slice(4)),
  },
  {
    id: "google-api-key",
    label: "Google",
    pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
    anchors: ["AIza"],
    prefix: 4,
    validate: (s) => random(material(s)),
  },
  {
    id: "slack-token",
    label: "Slack",
    pattern: /\bxox[baprs]-[0-9A-Za-z]{10,}(?:-[0-9A-Za-z]+)*/g,
    anchors: ["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"],
    prefix: 5,
    validate: (s) => !s.endsWith("0123") && valid(s),
  },
  {
    id: "stripe-secret",
    label: "Stripe",
    pattern: /\b[sr]k_live_[0-9A-Za-z]{16,}\b/g,
    anchors: ["sk_live_", "rk_live_"],
    prefix: 8,
    validate: (s) => random(material(s)),
  },
  {
    id: "sendgrid-key",
    label: "SendGrid",
    pattern: /\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}(?![0-9A-Za-z_-])/g,
    anchors: ["SG."],
    prefix: 3,
    validate: (s) => {
      const [, a, b] = s.split(".");
      return shape(a) && tail(b) && random(b);
    },
  },
  {
    id: "private-key-block",
    label: "私钥文件",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    anchors: ["-----BEGIN"],
    prefix: 0,
    validate: pem,
  },
  {
    id: "basic-auth-url",
    label: "疑似：带密码的网址",
    pattern: /[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\s:/@]+:([^\s:/@]+)@[^\s/]+/g,
    group: 1,
    anchors: ["://"],
    prefix: 0,
    candidate: true,
  },
  {
    id: "jwt",
    label: "疑似：登录令牌",
    pattern: /\beyJ[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+/g,
    anchors: ["eyJ"],
    prefix: 3,
    candidate: true,
  },
  {
    id: "high-entropy-assignment",
    label: "疑似：像密钥的长串",
    pattern:
      /\b[a-z][a-z0-9_]{2,}["']?\s*[=:]\s*["']?([A-Za-z0-9+/_-]{20,}={0,2})["']?/gi,
    group: 1,
    anchors: ["=", ":"],
    prefix: 0,
    candidate: true,
    validate: (s) =>
      s.replace(/=+$/, "").length >= 20 && entropy(s.replace(/=+$/, "")) >= 3.5,
  },
];
export const SECRET_RULES = rules.map((r) => ({
  id: r.id,
  label: r.label,
  confidence: (r.candidate ? "candidate" : "definite") as SecretConfidence,
}));
function rawMatches(text: string, definiteOnly = false): SecretMatch[] {
  const out: SecretMatch[] = [];
  for (const r of rules) {
    if (
      (definiteOnly && r.candidate) ||
      !r.anchors.some((a) => text.includes(a))
    )
      continue;
    // Match indices avoid locating a captured password in the URL's username by accident.
    const re = new RegExp(r.pattern.source, r.pattern.flags + "d");
    for (const m of text.matchAll(re)) {
      const value = m[r.group || 0];
      if (r.validate && !r.validate(value)) continue;
      const [start, end] = m.indices![r.group || 0];
      const keep = typeof r.prefix === "number" ? r.prefix : r.prefix(value);
      out.push({
        rule: r.id,
        confidence: r.candidate ? "candidate" : "definite",
        start,
        end,
        masked: value.slice(0, keep) + "••••••••",
      });
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}
export function scanSecrets(text: string, definiteOnly = false): SecretMatch[] {
  return findings(rawMatches(text, definiteOnly));
}
function findings(all: SecretMatch[]) {
  const definite = all.filter((m) => m.confidence === "definite");
  let end = 0;
  const maxEnds = definite.map((m) => (end = Math.max(end, m.end)));
  let candidateEnd = -1,
    candidateStart = -1;
  return all.filter((m) => {
    if (m.confidence === "definite") return true;
    let lo = 0,
      hi = definite.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (definite[mid].start < m.end) lo = mid + 1;
      else hi = mid;
    }
    const overlap = lo > 0 && maxEnds[lo - 1] > m.start;
    const contained =
      candidateEnd > m.end ||
      (candidateEnd === m.end && candidateStart < m.start);
    if (m.end > candidateEnd) {
      candidateEnd = m.end;
      candidateStart = m.start;
    }
    return !overlap && !contained;
  });
}
function mergeSpans(matches: SecretMatch[]) {
  const spans: SecretMatch[] = [];
  for (const m of matches) {
    const last = spans.at(-1);
    if (last && m.start < last.end) {
      if (m.end > last.end) {
        last.end = m.end;
        last.masked = "••••••••";
      }
    } else spans.push({ ...m });
  }
  return spans;
}
function maskSpans(text: string, matches: SecretMatch[]): string {
  const spans = mergeSpans(matches);
  let out = "",
    end = 0;
  for (const s of spans) {
    out += text.slice(end, s.start) + s.masked;
    end = s.end;
  }
  return out + text.slice(end);
}
/** Scan each field once; cached windows avoid re-running every rule for every finding. */
export function scanSecretField(text: string, definiteOnly = false) {
  const raw = rawMatches(text, definiteOnly),
    spans = mergeSpans(definiteOnly ? rawMatches(text) : raw);
  return {
    matches: findings(raw),
    window(start: number, end: number) {
      start = Math.max(0, start);
      end = Math.min(text.length, end);
      let lo = 0,
        hi = spans.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (spans[mid].end <= start) lo = mid + 1;
        else hi = mid;
      }
      const first = lo;
      while (lo < spans.length && spans[lo].start < end) {
        start = Math.min(start, spans[lo].start);
        end = Math.max(end, spans[lo].end);
        lo++;
      }
      return maskSpans(
        text.slice(start, end),
        spans
          .slice(first, lo)
          .map((m) => ({ ...m, start: m.start - start, end: m.end - start })),
      );
    },
  };
}
export function redactSecrets(text: string): string {
  return maskSpans(text, rawMatches(text));
}
export function redactSecretWindow(
  text: string,
  start: number,
  end: number,
): string {
  const matches = rawMatches(text);
  start = Math.max(0, start);
  end = Math.min(text.length, end);
  for (const m of matches)
    if (m.start < end && m.end > start) {
      start = Math.min(start, m.start);
      end = Math.max(end, m.end);
    }
  return maskSpans(
    text.slice(start, end),
    matches
      .filter((m) => m.start >= start && m.end <= end)
      .map((m) => ({ ...m, start: m.start - start, end: m.end - start })),
  );
}
/** Apply at public history output boundaries, while internal evidence stays intact. */
export function redactSecretValue<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactSecretValue) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        const prefix = k + "=";
        const masked =
          typeof v === "string" &&
          /(?:api.?key|token|password|secret|authorization|credential)/i.test(k)
            ? redactSecrets(prefix + v).slice(prefix.length)
            : redactSecretValue(v);
        return [redactSecrets(k), masked];
      }),
    ) as T;
  return value;
}
