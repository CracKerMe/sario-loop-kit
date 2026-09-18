import { describe, expect, it } from "vitest";

import { EventWaitIndex } from "../eventWaitIndex";

describe("EventWaitIndex", () => {
  it("indexes waits by event type and instance", () => {
    const index = new EventWaitIndex();
    index.add({ instanceId: "i1", nodeId: "n1", eventType: "loopkit.event.order.placed" });
    index.add({ instanceId: "i2", nodeId: "n1", eventType: "loopkit.event.order.placed" });
    index.add({ instanceId: "i1", nodeId: "n2", eventType: "loopkit.event.email.opened" });

    expect(index.instancesWaitingFor("loopkit.event.order.placed").sort()).toEqual(["i1", "i2"]);
    expect(index.instancesWaitingFor("loopkit.event.email.opened")).toEqual(["i1"]);
    expect(index.instancesWaitingFor("loopkit.event.missing")).toEqual([]);
  });

  it("removes a wait and drops empty type buckets", () => {
    const index = new EventWaitIndex();
    index.add({ instanceId: "i1", nodeId: "n1", eventType: "loopkit.event.a" });
    index.remove("i1", "n1");
    expect(index.instancesWaitingFor("loopkit.event.a")).toEqual([]);
    expect(index.size()).toBe(0);
  });

  it("reindexes when the same instance+node changes event type", () => {
    const index = new EventWaitIndex();
    index.add({ instanceId: "i1", nodeId: "n1", eventType: "loopkit.event.a" });
    index.add({ instanceId: "i1", nodeId: "n1", eventType: "loopkit.event.b" });
    expect(index.instancesWaitingFor("loopkit.event.a")).toEqual([]);
    expect(index.instancesWaitingFor("loopkit.event.b")).toEqual(["i1"]);
  });
});
