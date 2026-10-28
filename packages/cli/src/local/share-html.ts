import type { ShareSnapshot } from "@varveai/adit-core";

type Renderer = { renderShareHtml(snapshot: ShareSnapshot): string };
let renderer: Promise<Renderer> | undefined;

export async function renderShareHtml(snapshot: ShareSnapshot): Promise<string> {
  renderer ??= import(new URL("../../local-assets/share/render.mjs", import.meta.url).href)
    .catch(error => { renderer = undefined; throw error; });
  return (await renderer).renderShareHtml(snapshot);
}
