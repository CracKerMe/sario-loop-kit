# Loopkit

Self-hostable lifecycle marketing engine built on a real workflow engine (`ts-workflow-engine-lite`).

Journeys are not a fixed set of marketing nodes — they **compile** into engine `WorkflowDefinition`s with durable waits, event wake-ups, retries, and DLQ.

## Stack

- **apps/server** — Hono API (ingestion, dashboard APIs, Resend webhooks)
- **apps/web** — TanStack Start dashboard + React Flow journey builder
- **packages/engine** — bootstrap, EventWaitIndex, contact-event wake-ups
- **packages/engine-storage** — Drizzle/Postgres `StorageProvider`
- **packages/timers** — Postgres external timers + poller (restart-safe waits)
- **packages/email** — EmailProvider / Resend / notification channel bridge
- **packages/journey** — graph types, `compile`/`decompile`, `validateGraph`, node whitelist
- **packages/core** — contacts, journeys, triggers, API keys, reports
- **packages/db** — Drizzle schema (engine tables + product tables)

## Quick start

```bash
pnpm install
pnpm db:start          # docker compose up -d postgres
cd packages/db && pnpm db:push
cd ../..
pnpm dev               # API :3000, web :3001
```

Open http://localhost:3001 → sign up (workspace + welcome email template are auto-provisioned) → **Journeys** → **New journey** → pick a template → publish → **API keys** → ingest a contact:

New-journey templates include a marketing sample **Welcome + A/B + Score + Hours** (welcome email → lead score → weighted A/B → path A nurture with business-hours gate + goal, path B sales tag + team notify).

```bash
curl -H "Authorization: Bearer lk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","properties":{"firstName":"Sam"}}' \
  http://localhost:3000/v1/contacts
```

Without `RESEND_API_KEY`, emails are logged by `ConsoleEmailProvider`.

## API surface

| Method   | Path                       | Auth               | Purpose                                      |
| -------- | -------------------------- | ------------------ | -------------------------------------------- |
| POST     | `/v1/contacts`             | API key / session  | Upsert contact + evaluate entry triggers     |
| POST     | `/v1/events`               | API key / session  | Record event, start journeys, wake waitEvent |
| GET      | `/v1/journeys`             | session            | List journeys                                |
| POST     | `/v1/journeys`             | session            | Create draft from graph                      |
| GET      | `/v1/journeys/:id`         | session            | Journey + latest graph + run counts          |
| PUT      | `/v1/journeys/:id/draft`   | session            | Save graph as a new version                  |
| POST     | `/v1/journeys/:id/publish` | session            | Server-side whitelist + compile + register   |
| GET      | `/v1/journeys/:id/runs`    | session            | Runs                                         |
| GET      | `/v1/ops/stats`            | session            | Dashboard stats                              |
| GET      | `/v1/ops/dlq`              | session            | Dead-letter queue                            |
| GET/POST | `/v1/email-templates`      | session            | Template CRUD                                |
| GET/POST | `/v1/api-keys`             | session            | Ingestion keys                               |
| GET/POST | `/v1/audiences`            | session            | Saved segments (CRUD)                        |
| POST     | `/v1/audiences/preview`    | session            | Live match count for an unsaved filter       |
| GET      | `/v1/audiences/:id`        | session            | Segment + counts + a page of members         |
| GET      | `/v1/audiences/:id/contacts` | session          | Paged members                                |
| GET/POST | `/v1/campaigns`            | session            | Broadcasts (CRUD)                            |
| POST     | `/v1/campaigns/:id/launch` | session            | Resolve audience → materialize → drain       |
| POST     | `/v1/campaigns/:id/resume` | session            | Re-drain (crash recovery / un-pause)         |
| POST     | `/v1/campaigns/:id/pause` \| `/cancel` | session  | Stop between batches                         |
| GET      | `/v1/campaigns/:id/recipients` | session        | Per-recipient send outcome                   |
| GET/POST | `/v1/suppressions`         | session            | Suppression list + manual block              |
| DELETE   | `/v1/suppressions/:id`     | session            | Lift a block (the only path that can)        |
| GET/POST | `/v1/public/unsubscribe`   | signed token       | Preference centre + RFC 8058 one-click       |
| POST     | `/v1/webhooks/resend`      | provider signature | Delivery events + engagement wake-ups        |

## Campaigns vs journeys

They are different products that share one sending path.

- A **journey** is a graph per contact, compiled to an engine workflow; the workflow *is* the state machine.
- A **campaign** is one email to a saved **audience**, compiled to a **one-node** workflow where each *recipient* becomes an engine instance.

That second choice is the important one: a campaign inherits the journey path's exactly-once send (`email_send`'s unique `(workspaceId, idempotencyKey)` index, keyed `(campaignId, recipientId)`), its retry policy and its DLQ, instead of reimplementing them. The recipient rows in `campaign_recipient` are the queue — which is why `resume` after a crash is a recovery rather than a re-send gamble.

An audience is a stored SegmentFilter AST evaluated to SQL by `@loopkit/core`'s `segments.ts`. Two details worth knowing:

- Property **equality** compiles to jsonb containment (`properties @> '{"plan":"pro"}'`), which uses the existing `contact_props_gin` index. Substring/ordering on a property cannot use it, and is an honest sequential scan.
- Numeric property comparisons are gated on `jsonb_typeof(...) = 'number'`, so one contact with `seats: "unknown"` doesn't turn a whole segment into a 500.

A campaign **freezes its filter at launch**. Editing the saved segment afterwards cannot change who an in-flight broadcast goes to — otherwise the campaign's own report would be a lie.

## Compliance

Sending is blocked by two independent mechanisms, and they are not redundant:

| | Scope | Reversible | Survives contact deletion |
| --- | --- | --- | --- |
| `contact.subscribed` | identity | yes, from the preference centre | no |
| `suppression` row | address | only by an operator (except `unsubscribe`) | yes |

`suppression` exists because a hard bounce or spam complaint is a fact about the *mailbox*, not a preference, and because `contact` rows are disposable: a list re-import brings a bounced address back as a fresh, subscribed contact. The send path (`packages/email/src/channel.ts`) checks both; the delivery webhook writes both.

The public unsubscribe endpoint can only ever lift an `unsubscribe`-reason block. Clearing a bounce or complaint requires a session and an explicit action in the dashboard — a link in an old email must not be able to put a complained address back into the sending pool.

Every send carries `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) whenever `PUBLIC_APP_URL`/`PUBLIC_API_URL` are configured.

## Journey graph

Source of truth is `journey_version.graph` (React Flow nodes/edges). Node ids are engine `TaskNode.id`s.

| Journey node    | Engine node                                       | Purpose                                                        |
| --------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| trigger         | — (startNode via first edge)                      | Entry: contact_created / event / property_changed / manual     |
| delay           | `wait` + `externalTimer.enabled`                  | Duration (min/h/d/w), absolute `until`, weekly slot helper     |
| email           | `notification` channel `loopkit-email`            | Templated email + subject/preheader/from/replyTo/UTM overrides |
| notify          | `http` POST                                       | Team webhook (Slack/Discord/飞书/Zapier)                       |
| branch / filter | `condition`                                       | Expression true/false                                          |
| split           | `router`                                          | Multi-route expression router                                  |
| abSplit         | `action` + `conditionalNext`                      | Deterministic weighted A/B buckets from contact id             |
| timeWindow      | `action` + `conditionalNext`                      | Day/hour gate at run time (business hours, weekdays)           |
| waitEvent       | `event` (`next` = event, `failureNext` = timeout) | Wait for lifecycle event                                       |
| webhook         | `http`                                            | Outbound HTTP with headers/timeout/retries                     |
| updateContact   | `action` (runtime handler)                        | Set properties / add / remove tags                             |
| score           | `action` (runtime handler)                        | Add or set a lead-score property                               |
| goal            | `action` (runtime handler)                        | Record `goal.*` contact event + lastGoal property              |
| exit            | terminal `action`                                 | End journey for the contact                                    |

Publish always runs `assertWhitelistedGraph()` then `compile()` on the server. Action-backed marketing nodes (`updateContact` / `score` / `goal`) receive DB handlers injected via `CompileOptions.actions` — the browser only runs `validateGraph()`.

## Verification gates (from the plan)

Tests never touch your development database. Each package has its own, and the helpers **throw** rather than fall back to the app's:

```bash
pnpm db:test:setup    # creates loopkit_test_* and pushes the schema (once, or after a schema change)
pnpm -w check-types   # all packages + apps/server + apps/web
pnpm -r test
```

| Gate | Command | What it proves |
| --- | --- | --- |
| Storage conformance | `pnpm --filter @loopkit/engine-storage test` | Memory vs Drizzle + 10k stress |
| Timer restart | `pnpm --filter @loopkit/timers test` | Kill mid-wait, no duplicate timer, no early fire |
| Segments | `pnpm --filter @loopkit/core test` | SegmentFilter → SQL correctness, incl. the non-numeric property guard |
| Campaigns | `pnpm --filter @loopkit/core test` | Materialize once, drain only pending, pause/resume mid-drain |
| Compliance | `pnpm --filter @loopkit/email test` | Zero sends to a suppressed address; the webhook writes the block |
| Campaign end to end | `pnpm --filter server test` | Real engine: interpolation resolves, one send per recipient, a re-drain sends nothing |
| Single instance | `pnpm --filter server test` | A second advisory-lock holder is refused |
| End-to-end (manual) | see Quick start | Publish a journey → `POST /v1/contacts` → observe `journey_run` + email + timer rows |

> Why per-package databases: `pnpm -r test` runs packages concurrently, and every helper's `resetTables()` issues `TRUNCATE ... CASCADE` over the engine tables. Sharing one database let `engine-storage`'s 10k-instance stress test wipe `wf_instance` while a `@loopkit/timers` instance was mid-wait — a fired timer with no instance to resume, which presents as "durable waits are broken" when nothing is broken.

## ⚠️ Deployment: one API server per database

**Loopkit is single-instance by design. Do not run more than one `server` container/process against the same database. Never `docker compose up --scale server=2`, never put it behind a multi-replica orchestrator.**

`ts-workflow-engine-lite` is intentionally a single-process engine. Its process-local components are load-bearing:

| Component | What breaks with two processes |
| --- | --- |
| `EventBus` | `waitEvent` wake-ups are delivered in-process — an event handled by process A never wakes an instance owned by process B |
| Leases / idempotency keys | Both processes hand the same `notification` node to the channel; the `email_send` unique index catches duplicates only after both have decided to send |
| Cron scheduling / timer poller | Both poll `timer` and fire the same wait — duplicate sends |
| Event de-duplication | Provider webhook replays are deduped per process |

Loopkit stores durable state in Postgres rather than the engine's file store, which removes the data-corruption failure mode but **not** the coordination one.

This is enforced, not just documented: `apps/server` takes a Postgres **session-level advisory lock** at startup (`src/instanceLock.ts`) and **exits non-zero if it cannot get it**. The lock is held by a dedicated connection, so it is released automatically if the process is killed — no TTL, no stale-lock cleanup.

```
[loopkit] FATAL: another API server already holds the single-instance lock for this database.
```

If you see that, stop the other instance or point this one at a different database. Both processes should share the same `DATABASE_URL` **only** when exactly one of them serves traffic.

Horizontal scaling needs cross-process coordination (event routing, distributed rate limiting, timer ownership) that the engine does not provide — that is a deliberate architectural decision for the self-hosted target, not an oversight. `LOOPKIT_ALLOW_MULTI_INSTANCE=true` bypasses the guard for one-off scripts and migration jobs; it must never be used for a second API server.

## Scripts

- `pnpm dev` — web + server
- `pnpm check-types` — monorepo TypeScript (all packages + server + web)
- `pnpm db:push` / `pnpm db:studio`
- `pnpm db:test:setup` — create/refresh the per-package test databases
- `pnpm -r test` — full suite (never touches the dev database)
- `pnpm --filter @loopkit/<pkg> test`

> `apps/web/src/routeTree.gen.ts` is generated and gitignored. `pnpm --filter web dev` (or `build`) writes it; run it once after a fresh clone, or after adding a route file, or `web`'s type-check will report the new route as unknown.
