import { agentName } from "./achievement-export";
import { PlatformIcon } from "./platform-icon";
import "./agent-label.css";

/** Brand color belongs to the icon; names always use the normal text color. */
export function AgentLabel({ provider, name, className = "", iconSize = 12 }: {
  provider: string;
  name?: string;
  className?: string;
  iconSize?: number;
}) {
  return (
    <span className={`agent-label ${className}`}>
      <PlatformIcon platform={provider} size={iconSize} />
      {name || agentName(provider)}
    </span>
  );
}
