import { open, realpath } from "node:fs/promises";
import { basename, join, relative, isAbsolute } from "node:path";
import { LocalStateError, type LocalWorkspace } from "@varveai/adit-core";

export type ReadmePreview = {
  title: string;
  repository: string | null;
  introduction: string[];
  sectionTitle: string | null;
  sectionItem: string | null;
  sectionTable?: string[][];
  leadBold?: boolean;
};
const plain = (text: string) =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
export async function readmePreview(
  workspace: LocalWorkspace,
  selectedRepository?: string,
): Promise<ReadmePreview> {
  if (
    selectedRepository &&
    !workspace.repositories.includes(selectedRepository)
  )
    throw new LocalStateError("Repository is not in this workspace", 400);
  for (const repository of selectedRepository
    ? [selectedRepository]
    : workspace.repositories) {
    for (const name of ["README.md", "readme.md", "Readme.md"]) {
      let file;
      try {
        const root = await realpath(repository),
          target = await realpath(join(root, name));
        const rel = relative(root, target);
        if (
          isAbsolute(rel) ||
          rel === ".." ||
          rel.startsWith("..\\") ||
          rel.startsWith("../")
        )
          continue;
        file = await open(target, "r");
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 256 * 1024) continue;
        const content = (await file.readFile("utf8"))
          .replace(/\r/g, "")
          .replace(/```[\s\S]*?```/g, "");
        const title = /^#\s+(.+)$/m.exec(content)?.[1];
        const intro = content.split(/^##\s/m)[0].replace(/^#\s+.+$/m, "");
        const section = /^##\s+(.+)\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(
          content,
        );
        const sectionBody = section?.[2].trim() || "";
        const table = sectionBody.startsWith("|")
          ? sectionBody
              .split("\n")
              .filter(
                (line) => line.startsWith("|") && !/^\|[\s:|\-]+\|$/.test(line),
              )
              .slice(0, 8)
              .map((line) => line.split("|").slice(1, -1).map(plain))
          : undefined;
        return {
          title: plain(title || basename(repository)),
          repository: basename(repository),
          introduction: intro
            .split(/\n\s*\n/)
            .map(plain)
            .filter(Boolean)
            .slice(0, 2)
            .map((p) => p.slice(0, 1600)),
          leadBold: /^\s*\*\*/.test(intro),
          sectionTitle: section ? plain(section[1]) : null,
          sectionTable: table,
          sectionItem:
            section && !table
              ? plain(
                sectionBody
                    .split(/\n(?=\d+\.\s|[-*]\s)/)[0]
                    .replace(/^\s*(?:\d+\.|[-*])\s*/, ""),
                ).slice(0, 1000) || null
              : null,
        };
      } catch {
        /* Try the next local README. */
      } finally {
        await file?.close();
      }
    }
  }
  return {
    title: workspace.name,
    repository: null,
    introduction: [],
    sectionTitle: null,
    sectionItem: null,
  };
}
