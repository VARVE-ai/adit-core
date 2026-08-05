export const RELIABLE_EVENT_ACK_TIMEOUT_MS = 10_000;

export interface InFlightReliableEventBatch {
  batchId: string;
  eventIds: string[];
  sentAt: number;
}

export function trimRelayEventQueue<T>(input: {
  queue: T[];
  maxSize: number;
  isReliable: (event: T) => boolean;
}): number {
  let remainingToDrop = Math.max(input.queue.length - input.maxSize, 0);
  let dropped = 0;

  for (let index = 0; index < input.queue.length && remainingToDrop > 0;) {
    if (input.isReliable(input.queue[index]!)) {
      index += 1;
      continue;
    }
    input.queue.splice(index, 1);
    remainingToDrop -= 1;
    dropped += 1;
  }

  return dropped;
}

export function reliableEventsForRetry<T extends { eventId?: string }>(input: {
  queue: T[];
  batch: InFlightReliableEventBatch;
  now?: number;
  timeoutMs?: number;
}): T[] {
  const now = input.now ?? Date.now();
  const timeoutMs = input.timeoutMs ?? RELIABLE_EVENT_ACK_TIMEOUT_MS;
  if (now - input.batch.sentAt < timeoutMs) return [];

  const queuedById = new Map(
    input.queue.flatMap((event) => event.eventId ? [[event.eventId, event] as const] : []),
  );
  return input.batch.eventIds.flatMap((eventId) => {
    const event = queuedById.get(eventId);
    return event ? [event] : [];
  });
}
