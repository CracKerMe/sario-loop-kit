/**
 * Per-workspace send limiter — P2.5 发送限速.
 *
 * One process-wide instance (single-instance deployment, see the advisory
 * lock in apps/server) sits between the email channel and the provider and
 * caps how hard a workspace can push outbound mail, so one tenant's 10k
 * campaign cannot exhaust the Resend connection budget or trip ISP bulk
 * thresholds for everyone else.
 *
 * Two independent, queueing limits per workspace:
 *
 *  - **concurrency** — a FIFO semaphore on in-flight `provider.send` calls.
 *    Excess acquires WAIT, they never fail: a rejected send at this layer
 *    would be recorded as `email_send.failed`, and the engine's retry would
 *    then hit the idempotency key and never re-send — a silently lost email.
 *    Queueing is also the pacing mechanism: the campaign drain fans out
 *    100-instance batches without awaiting the actual sends, so this is
 *    what turns "fan out instantly" into "at most N on the wire".
 *
 *  - **perMinute** — a token bucket smoothing the *starts* of provider
 *    calls (ISP/Resend rate limits are per-window, not per-connection).
 *    Tokens refill continuously at perMinute/60000 per ms with a bucket
 *    capacity of perMinute, so a burst up to the full minute's budget is
 *    allowed and sustained throughput converges to perMinute.
 *
 * Deliberately NOT here (kept simple on purpose):
 *  - No persistence: quotas are process-local config, not workspace data.
 *    Restarting resets counters, which is harmless — the limits exist to
 *    protect a downstream API, not to enforce billing.
 *  - No fairness across workspaces: each workspace's queue is independent,
 *    so ws-b is never blocked behind ws-a's backlog (verified by tests).
 */

export interface WorkspaceSendLimits {
  /** Max in-flight provider sends for one workspace. 0 or unset = unlimited. */
  concurrency?: number;
  /** Max provider send STARTS per rolling minute. 0 or unset = unlimited. */
  perMinute?: number;
}

export interface WorkspaceSendLimiterConfig {
  /** Applied to every workspace without a specific override. */
  defaults?: WorkspaceSendLimits;
  /** Per-workspace limits that win over `defaults`. */
  overrides?: Record<string, WorkspaceSendLimits>;
}

export interface WorkspaceLimiterStat {
  inFlight: number;
  queued: number;
  /** Tokens available in the rate bucket (absent when rate limiting is off). */
  tokens?: number;
}

export interface WorkspaceSendLimiterStats {
  workspaces: Record<string, WorkspaceLimiterStat>;
}

/**
 * The release function returned by acquire() MUST be called exactly once
 * when the send attempt ends — success, failure, or throw.
 */
export type SendSlotRelease = () => void;

export interface SendLimiter {
  /**
   * Resolves when the caller may call the provider. Resolution order is
   * FIFO per workspace (no barging: a queued acquire never overtakes an
   * earlier one just because a token freed up).
   */
  acquire(workspaceId: string): Promise<SendSlotRelease>;
  stats(): WorkspaceSendLimiterStats;
}

interface WorkspaceState {
  limits: Required<WorkspaceSendLimits>;
  inFlight: number;
  queue: Array<{ resolve: (release: SendSlotRelease) => void }>;
  /** Token bucket: fractional tokens, refilled lazily on each acquire. */
  tokens: number;
  lastRefillAt: number;
  /**
   * Scheduled wakeup for rate-gated waiters. Without it, a queue blocked
   * ONLY by the token bucket would sleep forever: drains happen on
   * release(), but when nothing is in flight there is no release to
   * happen — the bucket refills with time, so the waiters need a timer.
   */
  pumpTimer?: NodeJS.Timeout;
}

export function createWorkspaceSendLimiter(config: WorkspaceSendLimiterConfig = {}): SendLimiter {
  const overrides = config.overrides ?? {};
  const states = new Map<string, WorkspaceState>();

  const limitsFor = (workspaceId: string): Required<WorkspaceSendLimits> => {
    const merged = { ...config.defaults, ...overrides[workspaceId] };
    return {
      concurrency: Math.max(0, merged.concurrency ?? 0),
      perMinute: Math.max(0, merged.perMinute ?? 0),
    };
  };

  const stateFor = (workspaceId: string): WorkspaceState => {
    let state = states.get(workspaceId);
    if (!state) {
      state = {
        limits: limitsFor(workspaceId),
        inFlight: 0,
        queue: [],
        // A fresh bucket starts FULL: the workspace gets its whole first
        // minute's budget up front (burst allowance), then refills
        // continuously. Starting at zero would park the very first send
        // behind an artificial wait.
        tokens: Math.max(0, limitsFor(workspaceId).perMinute),
        lastRefillAt: Date.now(),
      };
      // An unlimited workspace (no concurrency AND no rate) still gets a
      // state entry so stats() can report inFlight — but its acquire path
      // short-circuits below, so the entry stays cheap.
      states.set(workspaceId, state);
    }
    return state;
  };

  function refill(state: WorkspaceState): void {
    if (state.limits.perMinute === 0) return;
    const now = Date.now();
    const ratePerMs = state.limits.perMinute / 60_000;
    state.tokens = Math.min(
      state.limits.perMinute,
      state.tokens + (now - state.lastRefillAt) * ratePerMs,
    );
    state.lastRefillAt = now;
  }

  function hasCapacity(state: WorkspaceState): boolean {
    if (state.limits.concurrency > 0 && state.inFlight >= state.limits.concurrency) return false;
    if (state.limits.perMinute > 0 && state.tokens < 1) return false;
    return true;
  }

  function take(state: WorkspaceState, workspaceId: string): void {
    state.inFlight += 1;
    if (state.limits.perMinute > 0) state.tokens -= 1;
    void workspaceId;
  }

  function drain(state: WorkspaceState, workspaceId: string): void {
    // Wake waiters strictly in FIFO order; stop at the first one that
    // cannot proceed (its successors share the same bucket/semaphore, so
    // they cannot proceed either).
    while (state.queue.length > 0 && hasCapacity(state)) {
      const next = state.queue.shift()!;
      take(state, workspaceId);
      next.resolve(() => release(state, workspaceId));
    }
    if (state.queue.length === 0) {
      if (state.pumpTimer) {
        clearTimeout(state.pumpTimer);
        state.pumpTimer = undefined;
      }
      return;
    }
    // Waiters remain — they are gated by the rate bucket (concurrency
    // waiters would have been woken above or by a future release).
    if (state.limits.perMinute > 0 && !state.pumpTimer) {
      const ratePerMs = state.limits.perMinute / 60_000;
      const waitMs = Math.max(1, Math.ceil((1 - state.tokens) / ratePerMs) + 5);
      const timer = setTimeout(() => {
        state.pumpTimer = undefined;
        refill(state);
        drain(state, workspaceId);
      }, waitMs);
      timer.unref?.();
      state.pumpTimer = timer;
    }
  }

  function release(state: WorkspaceState, workspaceId: string): void {
    state.inFlight = Math.max(0, state.inFlight - 1);
    drain(state, workspaceId);
  }

  return {
    async acquire(workspaceId: string): Promise<SendSlotRelease> {
      const state = stateFor(workspaceId);
      // Fully unlimited workspace: still count inFlight for stats, never wait.
      if (state.limits.concurrency === 0 && state.limits.perMinute === 0) {
        state.inFlight += 1;
        return () => release(state, workspaceId);
      }

      refill(state);
      if (hasCapacity(state)) {
        take(state, workspaceId);
        return () => release(state, workspaceId);
      }

      return new Promise((resolve) => {
        state.queue.push({ resolve });
        // Nobody may be in flight (blocked purely by the rate bucket), so
        // no future release() exists to drain the queue — kick one now;
        // drain() schedules the refill timer when waiters remain.
        drain(state, workspaceId);
      });
    },

    stats(): WorkspaceSendLimiterStats {
      const workspaces: Record<string, WorkspaceLimiterStat> = {};
      for (const [id, state] of states) {
        refill(state);
        workspaces[id] = {
          inFlight: state.inFlight,
          queued: state.queue.length,
          ...(state.limits.perMinute > 0 ? { tokens: Math.floor(state.tokens) } : {}),
        };
      }
      return { workspaces };
    },
  };
}

/**
 * Parses the server env into limiter config. Absent/invalid vars mean
 * "that dimension off", not an error — the limiter degrades to counting.
 */
export function sendLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceSendLimiterConfig {
  const parse = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const defaults: WorkspaceSendLimits = {};
  const concurrency = parse(env.SEND_MAX_CONCURRENT_PER_WORKSPACE);
  const perMinute = parse(env.SEND_PER_MINUTE_PER_WORKSPACE);
  if (concurrency) defaults.concurrency = concurrency;
  if (perMinute) defaults.perMinute = perMinute;
  return Object.keys(defaults).length > 0 ? { defaults } : {};
}
