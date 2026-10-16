export interface RuntimeReport {
  schemaVersion: 1;
  source: "cli" | "hooks";
  version: string;
  checkedAt: string;
  projectId: string;
  platforms: string[];
  components: Array<{
    name: "cli" | "hooks" | "agent";
    version: string | null;
    evidence: "running" | "installed" | "unknown";
  }>;
  checks: Array<{ name: string; ok: boolean | null; detail: string }>;
}

export interface UpgradeNotice {
  needsAttention: boolean;
  state: string;
  currentVersion: string | null;
  latest: {
    version: string;
    summary: string;
    upgradeInstructions: string;
  } | null;
  impacts: Array<{ fixedIn: string; description: string }>;
}

export function formatUpgradeNotice(notice: UpgradeNotice): string | null {
  if (!notice.needsAttention || !notice.latest) return null;
  return [
    `ADIT upgrade: ${notice.currentVersion ?? "unknown"} -> ${notice.latest.version} (${notice.state})`,
    notice.latest.summary,
    ...notice.impacts.map((impact) => impact.description),
    notice.latest.upgradeInstructions,
    "Run 'adit upgrade', then 'adit cloud sync' to confirm the upgrade.",
  ]
    .filter(Boolean)
    .join("\n");
}
