import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { t, systemMessage } from "./i18n";
import "./paged-list.css";

export type ListPage<T> = { items: T[]; total: number; nextOffset: number | null; nextCursor?: string | null };
type PageRequest<P> = (offset: number, cursor: string | undefined, signal: AbortSignal) => Promise<P>;

/** One request at a time; reset requests invalidate pages from the previous scope. */
export function usePagedList<T, P extends ListPage<T>>({ request, itemKey, enabled = true, onFirstPage, refreshInterval }: {
  request: PageRequest<P>;
  itemKey: (item: T) => string;
  enabled?: boolean;
  onFirstPage?: (page: P) => void;
  refreshInterval?: number;
}) {
  const [data, setData] = useState<P>();
  const [loading, setLoading] = useState(enabled), [refreshing, setRefreshing] = useState(false), [error, setError] = useState("");
  const state = useRef<P>(), pending = useRef<AbortController | null>(null), serial = useRef(0);
  const callbacks = useRef({ itemKey, onFirstPage });
  callbacks.current = { itemKey, onFirstPage };
  const scrollRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async (mode: "reset" | "more" | "refresh") => {
    if (!enabled || (mode !== "reset" && pending.current)) return;
    const old = state.current;
    if (mode === "more" && old?.nextOffset == null) return;
    pending.current?.abort();
    const controller = new AbortController(), current = ++serial.current;
    pending.current = controller;
    if (mode === "refresh") setRefreshing(true); else setLoading(true);
    setError("");
    if (mode === "reset") {
      state.current = undefined; setData(undefined);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
    try {
      let page = await request(mode === "more" ? old!.nextOffset! : 0, mode === "more" ? old?.nextCursor || undefined : undefined, controller.signal);
      let items = mode === "more" ? [...old!.items, ...page.items] : page.items;
      // Keep already visible rows when refreshing, still requesting only 50 per page.
      while (mode === "refresh" && items.length < (old?.items.length || 0) && page.nextOffset != null) {
        if (controller.signal.aborted || current !== serial.current) return;
        const next = await request(page.nextOffset, page.nextCursor || undefined, controller.signal);
        if (!next.items.length) { page = next; break; }
        items = [...items, ...next.items]; page = next;
      }
      if (controller.signal.aborted || current !== serial.current) return;
      const seen = new Set<string>();
      items = items.filter(item => { const key = callbacks.current.itemKey(item); if (seen.has(key)) return false; seen.add(key); return true; });
      const result = { ...page, items };
      state.current = result; setData(result);
      if (mode === "reset") callbacks.current.onFirstPage?.(result);
    } catch (e) {
      if (!controller.signal.aborted && current === serial.current) setError(String(e));
    } finally {
      if (current === serial.current) {
        pending.current = null; setLoading(false); setRefreshing(false);
      }
    }
  }, [request, enabled]);
  useEffect(() => {
    if (enabled) void load("reset");
    return () => { serial.current++; pending.current?.abort(); pending.current = null; };
  }, [load, enabled]);
  useEffect(() => {
    if (!enabled || !refreshInterval || error) return;
    const timer = setInterval(() => void load("refresh"), refreshInterval);
    return () => clearInterval(timer);
  }, [enabled, refreshInterval, error, load]);
  const loadMore = useCallback(() => { void load("more"); }, [load]);
  const retry = () => { void load(state.current?.nextOffset != null ? "more" : "reset"); };
  return { data, loading, refreshing, error, scrollRef, loadMore, retry };
}

export function ListLoadMore({ pagination }: { pagination: {
  data?: { nextOffset: number | null }; loading: boolean; refreshing: boolean; error: string;
  scrollRef: { readonly current: HTMLElement | null }; loadMore: () => void; retry: () => void;
} }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { data, loading, refreshing, error, scrollRef, loadMore, retry } = pagination;
  useEffect(() => {
    if (loading || refreshing || error || data?.nextOffset == null || !sentinel.current) return;
    let active = true;
    const observer = new IntersectionObserver(entries => {
      if (active && entries.some(entry => entry.isIntersecting)) loadMore();
    }, { root: scrollRef.current, rootMargin: "0px 0px 120px 0px" });
    observer.observe(sentinel.current);
    return () => { active = false; observer.disconnect(); };
  }, [data, loading, refreshing, error, scrollRef, loadMore]);
  return <div ref={sentinel} className="list-load-more">
    {error ? <><span role="alert">{systemMessage(error)}</span><button onClick={retry}>{t("重试")}</button></> : loading ? <span role="status"><Loader2 className="spin" size={14} />{t("正在加载…")}</span> : null}
  </div>;
}
