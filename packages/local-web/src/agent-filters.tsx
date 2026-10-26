import { AgentLabel } from "./agent-label";
import { OverflowFilters } from "./overflow-filters";
import { t } from "./i18n";

export function AgentFilters({ providers, value, onChange }: {
  providers: { id: string; name: string; count?: number }[];
  value: string;
  onChange: (provider: string) => void;
}) {
  return <OverflowFilters className="agent-filters"
    items={providers.map(p => ({ id: p.id, count: p.count, label: <AgentLabel provider={p.id} name={p.name} iconSize={11} /> }))}
    value={value} onChange={onChange} allValue="all" allLabel={t("全部 Agent")}
    label={t("筛选 Agent")} moreLabel={t("更多 Agent")} />;
}
