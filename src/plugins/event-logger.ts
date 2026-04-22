import type { ServerPlugin } from "../plugins.js";

export type EventLoggerOptions = {
  /** Prefix prepended to every log line. Defaults to `"[event]"`. */
  prefix?: string;
};

export function eventLoggerPlugin(options: EventLoggerOptions = {}): ServerPlugin {
  const prefix = options.prefix ?? "[event]";
  let unsubscribe: (() => void) | undefined;
  return {
    name: "event-logger",
    setup(ctx) {
      unsubscribe = ctx.bus.subscribe((event) => {
        void ctx.logger(
          `${prefix} ${event.type} org=${event.orgId} streamSeq=${event.streamSeq ?? "-"}`,
        );
      });
    },
    dispose() {
      unsubscribe?.();
    },
  };
}

