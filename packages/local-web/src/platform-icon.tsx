import { SquareTerminal } from "lucide-react";
import { agentBrands } from "./agent-brands.generated";

export function platformBrand(platform: string | null | undefined) {
  if (!platform) return null;
  return agentBrands.find(({ match }) => new RegExp(match, "i").test(platform)) ?? null;
}

/** Retained for the Cloud composition chart's existing color selection. */
export function isDarkBrandHex(hex: string): boolean {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.35;
}

// Keep this renderer and generated catalog identical in Core and Cloud.
// Static LobeHub assets work with both React versions, without a CDN request.
export function PlatformIcon({ platform, className, size = 24 }: {
  platform: string | null | undefined;
  className?: string;
  size?: number;
}) {
  const brand = platformBrand(platform);
  if (!brand?.variant) return <SquareTerminal className={className} size={size} aria-label={brand?.title ?? "Agent"} />;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={brand.key === "codex" ? "Codex" : brand.title}
      fill="currentColor"
      style={{ color: "hsl(var(--foreground))" }}
    >
      <use href={`/agent-icons.svg#${brand.key}`} />
    </svg>
  );
}
