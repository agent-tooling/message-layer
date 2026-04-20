import type { DomainEvent, EventType } from "./types.js";

export type EventListener = (event: DomainEvent) => unknown;

export interface EventBus {
  publish(event: DomainEvent): void;
  subscribe(listener: EventListener, filter?: EventBusFilter): () => void;
}

export type EventBusFilter = {
  orgId?: string;
  streamId?: string | null;
  types?: ReadonlyArray<EventType>;
};

/**
 * Small in-process fan-out for domain events.
 *
 * The bus is intentionally non-blocking for publishers: listener errors are
 * caught and forwarded to an optional logger so that a broken plugin can
 * never corrupt a core transaction or break a request that already
 * committed its SQL work.
 */
export class InProcessEventBus implements EventBus {
  private listeners = new Set<{ fn: EventListener; filter: EventBusFilter | undefined }>();

  constructor(private readonly logger: (message: string) => void = () => {}) {}

  publish(event: DomainEvent): void {
    for (const entry of this.listeners) {
      if (!matches(entry.filter, event)) continue;
      try {
        const out = entry.fn(event);
        if (out && typeof (out as Promise<unknown>).catch === "function") {
          (out as Promise<unknown>).catch((error) => {
            this.logger(`[event-bus] listener error: ${(error as Error).message}`);
          });
        }
      } catch (error) {
        this.logger(`[event-bus] listener error: ${(error as Error).message}`);
      }
    }
  }

  subscribe(listener: EventListener, filter?: EventBusFilter): () => void {
    const entry = { fn: listener, filter };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function matches(filter: EventBusFilter | undefined, event: DomainEvent): boolean {
  if (!filter) return true;
  if (filter.orgId && filter.orgId !== event.orgId) return false;
  if (filter.streamId !== undefined && filter.streamId !== event.streamId) return false;
  if (filter.types && !filter.types.includes(event.type)) return false;
  return true;
}
