import type { StorageProvider } from "ts-workflow-engine-lite";

interface WaitEntry {
  instanceId: string;
  nodeId: string;
  eventType: string;
}

/**
 * In-memory correlation index for engine event waits. The engine's event
 * nodes only resume when an eventBus emit carries a matching instanceId
 * (requireInstanceIdMatch is hardcoded true), and looking that up via
 * loadAllEventWaitingStates() on every POST /v1/events would be a full
 * table scan. Single-process safe: timers already use SKIP LOCKED for
 * horizontal scale of the poller, but this index is process-local by design
 * (see plan stage 7).
 */
export class EventWaitIndex {
  /** `${instanceId}\0${nodeId}` -> wait entry */
  #byKey = new Map<string, WaitEntry>();
  /** eventType -> keys */
  #byType = new Map<string, Set<string>>();

  #key(instanceId: string, nodeId: string): string {
    return `${instanceId}\0${nodeId}`;
  }

  add(state: { instanceId: string; nodeId: string; eventType: string }): void {
    const key = this.#key(state.instanceId, state.nodeId);
    const entry: WaitEntry = {
      instanceId: state.instanceId,
      nodeId: state.nodeId,
      eventType: state.eventType,
    };
    const previous = this.#byKey.get(key);
    if (previous && previous.eventType !== state.eventType) {
      this.#byType.get(previous.eventType)?.delete(key);
    }
    this.#byKey.set(key, entry);
    let set = this.#byType.get(state.eventType);
    if (!set) {
      set = new Set();
      this.#byType.set(state.eventType, set);
    }
    set.add(key);
  }

  remove(instanceId: string, nodeId: string): void {
    const key = this.#key(instanceId, nodeId);
    const previous = this.#byKey.get(key);
    if (!previous) return;
    this.#byKey.delete(key);
    this.#byType.get(previous.eventType)?.delete(key);
  }

  /** Distinct instanceIds currently waiting for `eventType`. */
  instancesWaitingFor(eventType: string): string[] {
    const keys = this.#byType.get(eventType);
    if (!keys || keys.size === 0) return [];
    const out = new Set<string>();
    for (const key of keys) {
      const entry = this.#byKey.get(key);
      if (entry) out.add(entry.instanceId);
    }
    return [...out];
  }

  size(): number {
    return this.#byKey.size;
  }

  async loadFromStorage(storage: StorageProvider): Promise<number> {
    const states = await storage.loadAllEventWaitingStates();
    for (const state of states) {
      this.add(state);
    }
    return states.length;
  }
}
