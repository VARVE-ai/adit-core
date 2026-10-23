import { renderToStaticMarkup } from "react-dom/server";
import type { ShareSnapshot } from "../../core/src/local-history/sharing-types";
import { SharedSessionView } from "./publication-ui";
import { validateShareSnapshot } from "./share-snapshot";
import { platformBrand } from "./platform-icon";
import publicationStyles from "./publications.css?inline";
import sessionStyles from "./sessions.css?inline";
import labelStyles from "./agent-label.css?inline";
import exportStyles from "./share-html.css?inline";
import agentIcons from "../public/agent-icons.svg?raw";

/** Only the already reviewed, public snapshot may enter the exported document. */
export function renderShareHtml(snapshot: ShareSnapshot): string {
  if (!validateShareSnapshot(snapshot)) throw new Error("Unsupported shared session format");
  const brand = platformBrand(snapshot.provider);
  const symbol = brand && agentIcons.match(new RegExp(`<symbol\\b[^>]*id="${brand.key}"[^>]*>[\\s\\S]*?</symbol>`))?.[0];
  const body = renderToStaticMarkup(<SharedSessionView snapshot={snapshot} />)
    .replaceAll('href="/agent-icons.svg#', 'href="#');
  const title = renderToStaticMarkup(<title>{`${snapshot.title} · ADIT`}</title>);
  // No runtime scripts, remote styles/fonts/images, or original session data.
  // All shared content is rendered expanded, without interactive controls.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">${title}
<style>${publicationStyles}\n${sessionStyles}\n${labelStyles}\n${exportStyles}</style></head>
<body>${symbol ? `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" style="position:absolute">${symbol}</svg>` : ""}<main>${body}</main></body></html>`;
}
