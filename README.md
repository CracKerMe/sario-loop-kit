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
| POST     | `/v1/webhooks/resend`      | provider signature | Delivery events + engagement wake-ups        |

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

1. **Storage conformance** — `pnpm --filter @loopkit/engine-storage test` (Memory vs Drizzle + 10k stress)
2. **Timer restart** — `pnpm --filter @loopkit/timers test` (kill mid-wait, no duplicate timer)
3. **End-to-end** — publish a journey, POST a contact, observe `journey_run` + email + timer rows

## Scripts

- `pnpm dev` — web + server
- `pnpm check-types` — monorepo TypeScript
- `pnpm db:push` / `pnpm db:studio`
- `pnpm --filter @loopkit/<pkg> test`
