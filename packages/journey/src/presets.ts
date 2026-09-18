import type { JourneyGraph } from "./types";

/**
 * Marketing starter: welcome drip + A/B experiment + lead score + business-hours gate.
 *
 * contact_created
 *   → email welcome
 *   → score +10
 *   → abSplit (A/B 50/50)
 *      A → email variant A → score +5 → delay 1d → timeWindow weekdays 9–18
 *            false → delay 1h → loop back to timeWindow
 *            true  → email tips → goal activated → exit
 *      B → email variant B → updateContact (sales-ready tags) → notify team → exit
 */
export function welcomeAbScoreHoursGraph(): JourneyGraph {
  return {
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 420, y: 20 },
        data: { trigger: { kind: "contact_created" } },
      },
      {
        id: "email_welcome",
        type: "email",
        position: { x: 420, y: 140 },
        data: {
          templateId: "welcome-template",
          subject: "Welcome aboard",
          preheader: "Here's what to do first",
        },
      },
      {
        id: "score_signup",
        type: "score",
        position: { x: 420, y: 260 },
        data: { property: "score", value: 10, op: "add" },
      },
      {
        id: "ab_onboarding",
        type: "abSplit",
        position: { x: 420, y: 380 },
        data: {
          variants: [
            { name: "A", weight: 50 },
            { name: "B", weight: 50 },
          ],
        },
      },
      // Path A — nurture + business hours
      {
        id: "email_variant_a",
        type: "email",
        position: { x: 160, y: 520 },
        data: {
          templateId: "path-a-template",
          subject: "Path A: your first week plan",
          preheader: "A gentle day-by-day checklist",
        },
      },
      {
        id: "score_path_a",
        type: "score",
        position: { x: 160, y: 640 },
        data: { property: "score", value: 5, op: "add" },
      },
      {
        id: "delay_1d",
        type: "delay",
        position: { x: 160, y: 760 },
        data: { mode: "duration", ms: 86_400_000, value: 1, unit: "days" },
      },
      {
        id: "window_business",
        type: "timeWindow",
        position: { x: 160, y: 880 },
        data: {
          days: [1, 2, 3, 4, 5],
          startHour: 9,
          endHour: 18,
          label: "Business hours",
        },
      },
      {
        id: "delay_retry",
        type: "delay",
        position: { x: 40, y: 1020 },
        data: { mode: "duration", ms: 3_600_000, value: 1, unit: "hours" },
      },
      {
        id: "email_tips",
        type: "email",
        position: { x: 280, y: 1020 },
        data: {
          templateId: "tips-template",
          subject: "Getting started tips",
          preheader: "Three things power users do on day one",
        },
      },
      {
        id: "goal_activated",
        type: "goal",
        position: { x: 280, y: 1140 },
        data: { name: "activated", value: 1 },
      },
      {
        id: "exit_a",
        type: "exit",
        position: { x: 280, y: 1260 },
        data: { reason: "path-a-activated" },
      },
      // Path B — high-touch sales ping
      {
        id: "email_variant_b",
        type: "email",
        position: { x: 680, y: 520 },
        data: {
          templateId: "path-b-template",
          subject: "Path B: want a guided setup?",
          preheader: "Book 15 minutes with our team",
        },
      },
      {
        id: "update_tag_sales",
        type: "updateContact",
        position: { x: 680, y: 640 },
        data: {
          set: { lifecycle: "sales-ready" },
          addTags: ["ab-b", "high-touch"],
        },
      },
      {
        id: "notify_sales",
        type: "notify",
        position: { x: 680, y: 760 },
        data: {
          url: "https://hooks.example.com/loopkit-sales",
          subject: "High-touch welcome lead",
          message:
            "New signup on path B: {{ contact.email }} (journey {{ journeyId }}). Reach out today.",
          method: "POST",
        },
      },
      {
        id: "exit_b",
        type: "exit",
        position: { x: 680, y: 880 },
        data: { reason: "path-b-sales-handoff" },
      },
    ],
    edges: [
      { id: "e_t_welcome", source: "trigger", target: "email_welcome" },
      { id: "e_welcome_score", source: "email_welcome", target: "score_signup" },
      { id: "e_score_ab", source: "score_signup", target: "ab_onboarding" },

      { id: "e_ab_a", source: "ab_onboarding", target: "email_variant_a", sourceHandle: "A" },
      { id: "e_a_score", source: "email_variant_a", target: "score_path_a" },
      { id: "e_a_delay", source: "score_path_a", target: "delay_1d" },
      { id: "e_delay_window", source: "delay_1d", target: "window_business" },
      {
        id: "e_window_retry",
        source: "window_business",
        target: "delay_retry",
        sourceHandle: "false",
      },
      { id: "e_retry_window", source: "delay_retry", target: "window_business" },
      {
        id: "e_window_tips",
        source: "window_business",
        target: "email_tips",
        sourceHandle: "true",
      },
      { id: "e_tips_goal", source: "email_tips", target: "goal_activated" },
      { id: "e_goal_exit", source: "goal_activated", target: "exit_a" },

      { id: "e_ab_b", source: "ab_onboarding", target: "email_variant_b", sourceHandle: "B" },
      { id: "e_b_update", source: "email_variant_b", target: "update_tag_sales" },
      { id: "e_b_notify", source: "update_tag_sales", target: "notify_sales" },
      { id: "e_b_exit", source: "notify_sales", target: "exit_b" },
    ],
  };
}
