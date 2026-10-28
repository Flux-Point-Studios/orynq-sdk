import { MemoryGuardLog, type GuardEvent, type GuardEventSink } from "../../src/index.js";

// A contract sink over `log` that also collects each appended event.
export function record(events: GuardEvent[] = [], log = new MemoryGuardLog()): GuardEventSink {
  return (event, previous) => {
    const head = log.append(event, previous);
    events.push(event);
    return head;
  };
}
