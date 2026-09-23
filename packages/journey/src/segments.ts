/**
 * Canonical SegmentFilter AST — the single type definition shared by
 * journey trigger entry filters, audiences, and `@loopkit/core`'s SQL
 * compiler. The journey package owns the types (it sits under core);
 * core owns evaluation (`compileSegmentFilter` / `validateSegmentFilter`).
 *
 * This is the audience-style AST (`kind: "condition" | "event"`, `op` groups),
 * NOT a property-only expression tree. Journey trigger `filter` is frozen
 * from the shared segment editor and evaluated against the contact at entry.
 */

export type SegmentOperator =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "not_exists";

/** Scalar a condition can carry. Arrays only for `in`/`not_in`. */
export type SegmentValue = string | number | boolean | string[] | number[] | null;

export interface SegmentCondition {
  kind: "condition";
  /**
   * `email` | `userId` | `subscribed` | `createdAt` | `updatedAt` |
   * `unsubscribedAt` | `property.<key>` (top-level JSON key).
   */
  field: string;
  operator: SegmentOperator;
  value?: SegmentValue;
}

export interface SegmentEventCondition {
  kind: "event";
  /** The `contact_event.name`, e.g. "email.opened", "order.placed". */
  name: string;
  /** Restrict to events in the last N days. Omitted = all time. */
  withinDays?: number;
  /**
   * `true` = the event must have occurred; `false` = it must NOT have
   * (a "no events at all" contact satisfies the negative form).
   */
  occurred: boolean;
  /** Minimum occurrences. Only meaningful with `occurred: true`. */
  minCount?: number;
}

export interface SegmentGroup {
  op: "and" | "or";
  children: SegmentFilter[];
}

export interface SegmentNot {
  op: "not";
  child: SegmentFilter;
}

export type SegmentFilter = SegmentCondition | SegmentEventCondition | SegmentGroup | SegmentNot;
