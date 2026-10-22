import type {
  InspectionData,
  InspectionFinding,
  InspectionStatus,
} from "../../core/src/local-history/inspection";

export type InspectionApi = <T = any>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;

export const inspectionSessionKey = (
  item: Pick<InspectionFinding, "provider" | "sessionId">,
) => JSON.stringify([item.provider, item.sessionId]);

// Refresh just requested pages. Even large candidate sets need not be downloaded in full.
export async function readInspectionResults(
  api: InspectionApi,
  endpoint: string,
  status: InspectionStatus,
  rule: string,
  signal: AbortSignal,
  offset = 0,
): Promise<InspectionData> {
  signal.throwIfAborted();
  const pages = await Promise.all(
    Array.from({ length: offset / 50 + 1 }, (_, page) =>
      api<InspectionData>(
        `${endpoint}&status=${status}&offset=${page * 50}&rule=${encodeURIComponent(rule)}`,
        "GET",
        undefined,
        signal,
      ),
    ),
  );
  signal.throwIfAborted();
  return {
    ...pages.at(-1)!,
    items: [
      ...new Map(
        pages.flatMap((page) => page.items).map((item) => [item.id, item]),
      ).values(),
    ],
    ...(pages[0].sessions
      ? {
          sessions: [
            ...new Map(
              pages
                .flatMap((page) => page.sessions || [])
                .map((session) => [inspectionSessionKey(session), session]),
            ).values(),
          ],
        }
      : {}),
  };
}
