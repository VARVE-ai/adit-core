import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { OverviewData } from "../../core/src/local-history/analytics";
import type { AchievementsData } from "../../core/src/local-history/achievements";
import { achievementName, badgeSvg, svgUrl } from "./achievement-export";
import { defaultProfilePreferences, profileBadgePairs, profileSvg } from "./profile-export";
import { getLanguage, t } from "./i18n";

type Badge = { id: string; label: string; src: string; width: number };

// Keep whole badges in source order, using later smaller badges when one cannot fit.
export function fitOverviewBadges<T extends { width: number }>(badges: T[], available: number) {
  let used = 0;
  return badges.filter((badge) => {
    const next = used + (used ? 6 : 0) + badge.width;
    if (badge.width <= 0 || next > available) return false;
    used = next;
    return true;
  });
}
function badge(id: string, label: string, source: string): Badge {
  return {
    id, label, src: svgUrl(source),
    // Both shared plain renderers produce a 20px-high SVG with an explicit width.
    width: Number(source.match(/^<svg\b[^>]*\bwidth="([\d.]+)"/)?.[1] || 0),
  };
}
export function OverviewBadges({ workspace, data, api, refresh, onProfileCards }: {
  workspace: { id: string; name: string; achievements?: { unread: number } };
  data?: OverviewData;
  api: <T = any>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
  refresh: string;
  onProfileCards?: () => void;
}) {
  const [achievements, setAchievements] = useState<AchievementsData>();
  const container = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const language = getLanguage();
  useEffect(() => {
    const controller = new AbortController();
    void api<AchievementsData>(`/achievements?workspaceId=${encodeURIComponent(workspace.id)}`, "GET", undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) setAchievements(result); })
      .catch(() => { if (!controller.signal.aborted) setAchievements(undefined); });
    return () => controller.abort();
  }, [workspace.id, workspace.achievements?.unread, refresh]);
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const measure = () => setAvailable(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const badges = useMemo(() => {
    const preferences = defaultProfilePreferences();
    const items = data?.profile && data.scope.workspaceId === workspace.id
      ? profileBadgePairs.map(([plain]) => badge(plain, plain.slice(6), profileSvg(data, workspace.name, preferences, plain)))
      : [];
    if (achievements?.workspaceId === workspace.id && achievements.status === "ready") {
      for (const item of achievements.items.filter(item => item.tier > 0)) {
        items.push(badge(`achievement-${item.key}`, achievementName(item.key), badgeSvg(achievements, {
          ...item,
          options: { ...item.options, showValue: true, showDate: false, showAgent: false, showPrompt: false },
        }, "plain")));
      }
    }
    return items;
  }, [data, achievements, workspace.id, workspace.name, language]);
  return (
    <div className="overview-badge-row">
      <div className="overview-badge-list" ref={container}>
        {fitOverviewBadges(badges, available).map(item => (
          <img key={item.id} className="overview-badge" src={item.src} alt={item.label} width={item.width} height={20} />
        ))}
      </div>
      <div className="overview-badge-actions">
        <button onClick={onProfileCards}>{t("看看所有样式")}</button>
      </div>
    </div>
  );
}
