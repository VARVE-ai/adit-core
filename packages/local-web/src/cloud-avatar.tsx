import { useState } from "react";
import { UserRound } from "lucide-react";

export function CloudAvatar({ account, image }: { account?: string; image?: string }) {
  const [failed, setFailed] = useState(false);
  const source = image && /^https?:\/\//i.test(image) ? image : undefined;
  return (
    <span className="cloud-avatar" aria-hidden="true">
      {source && !failed ? (
        <img src={source} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : account ? (
        Array.from(account)[0].toUpperCase()
      ) : (
        <UserRound size={14} />
      )}
    </span>
  );
}
