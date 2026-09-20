import type { EmailDocJson, EmailNodeJson } from "./types";

/**
 * The community template gallery — the "Start with a community template"
 * option on the New template dialog.
 *
 * ## Why this is a separate module from `presets.ts`
 *
 * `EMAIL_DOC_PRESETS` is the editor's *starting-point* list: three entries
 * whose job is to get an empty canvas to something typeable, and one of which
 * (`blank`) is indexed positionally by `emptyEmailDoc()`. Growing that array
 * with a dozen finished designs would both change what "the presets" means to
 * every existing consumer and make the positional index a hazard. The gallery
 * has a different shape (category, tags, a preview subject line) and a
 * different audience, so it gets its own list.
 *
 * ## Why every template is text, button and divider only — no images
 *
 * The validator requires `emailImage.src` to be an absolute `http(s)` URL
 * (`validate.ts`), and a shipped template cannot supply one that will still
 * resolve in a year, from a customer's own workspace, without us hosting and
 * paying for the asset. A gallery of templates with broken hero images is
 * worse than none. Every design here therefore reaches for type scale,
 * section backgrounds and rules to carry the layout — which is also what
 * survives Outlook and image-blocking clients, where a great many recipients
 * read the first paint anyway.
 *
 * ## Why the copy is finished, not lorem ipsum
 *
 * The point of the gallery is to skip the blank page. A template whose body
 * reads "Your text here" three times has not skipped it. Each one is written
 * as a real, sendable email that a user edits down, with merge tags already
 * placed where personalisation belongs and an unsubscribe line in the footer
 * of every marketing-shaped template — the one link a bulk send legally needs
 * and the one most easily forgotten on a hand-built template. See
 * `UNSUBSCRIBE_HREF` for why that link is a placeholder rather than a tag.
 *
 * Every template here is covered by the same suites that cover the presets:
 * it must validate, render under the layout allow-list, and stay under the
 * Gmail clipping ceiling.
 */

export type CommunityTemplateCategory =
  | "onboarding"
  | "announcement"
  | "newsletter"
  | "transactional"
  | "lifecycle";

export interface CommunityEmailTemplate {
  id: string;
  /** Gallery card title. */
  label: string;
  /** One line under the title — what the template is for, not what it contains. */
  description: string;
  category: CommunityTemplateCategory;
  /** Prefilled subject line; the user edits it like any other field. */
  subject: string;
  /** Short filter/search terms shown as chips on the card. */
  tags: readonly string[];
  doc: EmailDocJson;
}

export const COMMUNITY_TEMPLATE_CATEGORIES: readonly {
  id: CommunityTemplateCategory;
  label: string;
  description: string;
}[] = [
  {
    id: "onboarding",
    label: "Onboarding",
    description: "Welcome, activation and first-run emails.",
  },
  {
    id: "announcement",
    label: "Announcements",
    description: "Launches, changelogs and company news.",
  },
  { id: "newsletter", label: "Newsletter", description: "Recurring digests and roundups." },
  {
    id: "transactional",
    label: "Transactional",
    description: "Receipts, confirmations and account notices.",
  },
  {
    id: "lifecycle",
    label: "Lifecycle",
    description: "Re-engagement, trial and renewal nudges.",
  },
] as const;

/* -- builders ---------------------------------------------------------------
 *
 * These exist so the documents below read as layout rather than as JSON. They
 * emit exactly the node shapes `types.ts` permits — nothing here can introduce
 * a block the validator would reject, because there is no escape hatch for a
 * free-form node.
 */

type Inline = EmailNodeJson;

function text(value: string, marks?: EmailNodeJson["marks"]): Inline {
  return marks ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function bold(value: string): Inline {
  return text(value, [{ type: "bold" }]);
}

function link(value: string, href: string): Inline {
  return text(value, [{ type: "link", attrs: { href } }]);
}

function muted(value: string): Inline {
  return text(value, [{ type: "textStyle", attrs: { color: "#71717a" } }]);
}

function tag(path: string): Inline {
  return { type: "emailMergeTag", attrs: { path } };
}

function heading(level: 1 | 2 | 3, content: Inline[], align: "left" | "center" = "left") {
  return { type: "emailHeading", attrs: { level, align }, content };
}

function paragraph(content: Inline[], align: "left" | "center" = "left") {
  return { type: "emailParagraph", attrs: { align }, content };
}

/** Body copy as a plain string — the common case. */
function p(value: string, align: "left" | "center" = "left") {
  return paragraph([text(value)], align);
}

function button(
  label: string,
  href: string,
  variant: "primary" | "secondary" = "primary",
  align: "left" | "center" = "left",
) {
  return {
    type: "emailButton",
    attrs: { href, variant, align },
    content: [text(label)],
  };
}

function divider(variant: "solid" | "dashed" = "solid", color?: string) {
  return { type: "emailDivider", attrs: { variant, color: color ?? null } };
}

function section(
  content: EmailNodeJson[],
  attrs: { backgroundColor?: string; paddingY?: "none" | "sm" | "md" | "lg" } = {},
) {
  return {
    type: "emailSection",
    attrs: { backgroundColor: attrs.backgroundColor ?? null, paddingY: attrs.paddingY ?? "md" },
    content,
  };
}

function doc(content: EmailNodeJson[]): EmailDocJson {
  return { type: "doc", content };
}

/**
 * The unsubscribe link in every marketing-shaped footer below.
 *
 * It is a **placeholder the user replaces**, not a merge tag, and that is a
 * deliberate choice against the more obvious `{{contact.unsubscribeUrl}}`.
 * Today the one-click unsubscribe link is built at send time and attached as
 * the `List-Unsubscribe` *header* only (see `buildUnsubscribe` in
 * @loopkit/email's `channel.ts`); it is never added to `renderData`, and
 * @loopkit/email's `renderTemplate` leaves an unresolved path as literal
 * text. A `{{contact.unsubscribeUrl}}` href would therefore ship a visibly
 * broken link in every template in this gallery — the failure mode a shipped
 * template can least afford. When a body-level unsubscribe tag exists, this
 * one constant is the only place that needs to change.
 */
const UNSUBSCRIBE_HREF = "https://example.com/unsubscribe";

/** The footer every marketing-shaped template ends with. */
function marketingFooter(sender: string) {
  return section(
    [
      divider("solid", "#e4e4e7"),
      paragraph(
        [
          muted(`You are receiving this because you signed up for ${sender}. `),
          link("Unsubscribe", UNSUBSCRIBE_HREF),
          muted(" at any time."),
        ],
        "center",
      ),
    ],
    { paddingY: "sm" },
  );
}

/* -- templates -------------------------------------------------------------- */

export const COMMUNITY_EMAIL_TEMPLATES: readonly CommunityEmailTemplate[] = [
  {
    id: "welcome-warm",
    label: "Warm welcome",
    description: "A personal first email that names one thing to do next.",
    category: "onboarding",
    subject: "Welcome aboard 👋",
    tags: ["welcome", "signup", "activation"],
    doc: doc([
      section([
        heading(1, [text("Welcome aboard, "), tag("contact.firstName"), text("!")]),
        p(
          "Thanks for signing up. You now have everything you need to get started — and this email has exactly one thing in it, so you can act on it in under a minute.",
        ),
        paragraph([
          bold("Start here: "),
          text("create your first project. Everything else follows from it."),
        ]),
        button("Create your first project", "https://example.com/get-started"),
      ]),
      section(
        [
          heading(3, [text("If you get stuck")]),
          paragraph([
            text("Reply to this email — it reaches a real person. Or browse the "),
            link("getting started guide", "https://example.com/docs"),
            text("."),
          ]),
        ],
        { backgroundColor: "#f4f4f5" },
      ),
      marketingFooter("our product"),
    ]),
  },

  {
    id: "onboarding-checklist",
    label: "Setup checklist",
    description: "Three numbered steps with one call to action at the end.",
    category: "onboarding",
    subject: "3 steps to get the most out of your account",
    tags: ["checklist", "activation", "steps"],
    doc: doc([
      section([
        heading(1, [text("Let's finish setting you up")]),
        p(
          "You're most of the way there. These three steps take about five minutes together, and they are what turn an empty account into a useful one.",
        ),
      ]),
      section(
        [
          heading(3, [text("1. Import your contacts")]),
          p("Bring in a CSV or connect your existing tool. Nothing sends until you say so."),
          divider("dashed", "#d4d4d8"),
          heading(3, [text("2. Verify your sending domain")]),
          p("This is the single biggest lever on whether your email reaches the inbox."),
          divider("dashed", "#d4d4d8"),
          heading(3, [text("3. Send yourself a test")]),
          p("See exactly what your recipients will see, in your own mailbox, before anyone else."),
        ],
        { backgroundColor: "#fafafa" },
      ),
      section([button("Open my checklist", "https://example.com/checklist", "primary", "center")], {
        paddingY: "sm",
      }),
      marketingFooter("our product"),
    ]),
  },

  {
    id: "getting-started",
    label: "Getting started guide",
    description: "A numbered walkthrough that activates new users in one sitting.",
    category: "onboarding",
    subject: "Let's get you started",
    tags: ["onboarding", "activation", "guide"],
    doc: doc([
      section([
        heading(1, [text("Let's get you started, "), tag("contact.firstName")]),
        p(
          "You've got the account — now here are the three things that turn it into something you actually use.",
        ),
      ]),
      section(
        [
          paragraph([bold("1 · Set up your workspace")]),
          p(
            "Give it a name, invite your team, and connect the tools you already use. Takes about two minutes.",
          ),
          divider("dashed", "#d4d4d8"),
          paragraph([bold("2 · Create your first project")]),
          p(
            "Pick a template or start blank. The first project is where everything clicks — you'll see how the pieces fit together.",
          ),
          divider("dashed", "#d4d4d8"),
          paragraph([bold("3 · Invite a teammate")]),
          p(
            "Sharing the workspace early means you're not the only one who knows where things are when you need help.",
          ),
        ],
        { backgroundColor: "#fafafa" },
      ),
      section([button("Open my workspace", "https://example.com/workspace", "primary", "center")], {
        paddingY: "sm",
      }),
      section(
        [
          paragraph([
            muted("Stuck? "),
            link("Reply to this email", "mailto:support@example.com"),
            muted(" and a real person will help."),
          ]),
        ],
        { paddingY: "sm" },
      ),
      marketingFooter("our product"),
    ]),
  },

  {
    id: "product-launch",
    label: "Product launch",
    description: "Centred hero, a short case for the change, one button.",
    category: "announcement",
    subject: "Introducing something we think you'll like",
    tags: ["launch", "feature", "hero"],
    doc: doc([
      section(
        [
          paragraph([muted("NEW")], "center"),
          heading(1, [text("A faster way to do the thing you do most")], "center"),
          paragraph(
            [
              text(
                "We rebuilt the part of the product you spend the most time in. It is quicker, it is clearer, and it is already live in your account.",
              ),
            ],
            "center",
          ),
          button("See what's new", "https://example.com/whats-new", "primary", "center"),
        ],
        { paddingY: "lg" },
      ),
      section([
        heading(2, [text("What changed")]),
        paragraph([bold("Faster. "), text("The screens you open every day now load instantly.")]),
        paragraph([
          bold("Clearer. "),
          text("Fewer settings, better defaults, and nothing hidden behind a menu."),
        ]),
        paragraph([
          bold("Yours. "),
          text("Everything you had before is still there, exactly where you left it."),
        ]),
      ]),
      section(
        [
          paragraph(
            [
              text("Questions about the update? "),
              link("Read the full changelog", "https://example.com/changelog"),
              text(" or just reply to this email."),
            ],
            "center",
          ),
        ],
        { backgroundColor: "#f4f4f5", paddingY: "sm" },
      ),
      marketingFooter("our product"),
    ]),
  },

  {
    id: "feature-update",
    label: "Changelog update",
    description: "A tidy list of shipped changes for regular product notes.",
    category: "announcement",
    subject: "What we shipped this month",
    tags: ["changelog", "release notes", "monthly"],
    doc: doc([
      section([
        heading(2, [text("This month at a glance")]),
        paragraph([
          text("Hi "),
          tag("contact.firstName"),
          text(", here is everything that landed since the last note — shortest first."),
        ]),
      ]),
      section([
        divider("solid", "#e4e4e7"),
        heading(3, [text("Bulk editing")]),
        p("Select multiple records and change them in one action instead of one at a time."),
        divider("solid", "#e4e4e7"),
        heading(3, [text("Saved views")]),
        p("Any filter you use twice can now be saved, named and shared with your team."),
        divider("solid", "#e4e4e7"),
        heading(3, [text("Faster exports")]),
        p("Large exports now stream in the background and email you when they're ready."),
        divider("solid", "#e4e4e7"),
      ]),
      section([button("See the full changelog", "https://example.com/changelog", "secondary")], {
        paddingY: "sm",
      }),
      marketingFooter("our product"),
    ]),
  },

  {
    id: "event-invite",
    label: "Event invitation",
    description: "Date, time and place stated plainly, with an RSVP button.",
    category: "announcement",
    subject: "You're invited: a live walkthrough",
    tags: ["event", "webinar", "invite", "rsvp"],
    doc: doc([
      section([
        heading(1, [text("You're invited")]),
        paragraph([
          text("Hi "),
          tag("contact.firstName"),
          text(
            ", we're running a live 30-minute walkthrough followed by open questions. No slides.",
          ),
        ]),
      ]),
      section(
        [
          paragraph([bold("When: "), text("Thursday, 3 April · 15:00–15:30 UTC")]),
          paragraph([bold("Where: "), text("Online — the link arrives when you register.")]),
          paragraph([bold("Cost: "), text("Free. A recording goes to everyone who registers.")]),
        ],
        { backgroundColor: "#f4f4f5" },
      ),
      section([button("Save my seat", "https://example.com/register")]),
      section([
        paragraph([
          muted("Can't make that time? Register anyway and we'll send you the recording."),
        ]),
      ]),
      marketingFooter("our events"),
    ]),
  },

  {
    id: "holiday-promo",
    label: "Holiday promotion",
    description: "A seasonal offer with a bold headline and a clear call to action.",
    category: "announcement",
    subject: "A little something for the season",
    tags: ["promo", "sale", "seasonal"],
    doc: doc([
      section(
        [
          paragraph([muted("SEASONAL OFFER")], "center"),
          heading(1, [text("A little something for the season")], "center"),
          paragraph(
            [
              text("Hi "),
              tag("contact.firstName"),
              text(", we're marking the occasion with something we think you'll enjoy."),
            ],
            "center",
          ),
        ],
        { backgroundColor: "#18181b", paddingY: "lg" },
      ),
      section(
        [
          paragraph([bold("The offer: "), text("20% off any plan, this week only.")]),
          paragraph([bold("The code: "), text("SEASON20 — apply it at checkout.")]),
          paragraph([
            bold("The fine print: "),
            text("Works on new subscriptions and upgrades. Expires Sunday at midnight."),
          ]),
        ],
        { backgroundColor: "#fafafa" },
      ),
      section([button("Shop now", "https://example.com/shop", "primary", "center")]),
      section(
        [
          paragraph(
            [
              muted("Not your thing? "),
              link("Unsubscribe", UNSUBSCRIBE_HREF),
              muted(" — no pressure."),
            ],
            "center",
          ),
        ],
        { paddingY: "sm" },
      ),
    ]),
  },

  {
    id: "monthly-roundup",
    label: "Monthly roundup",
    description: "Three curated reads with summaries, built for monthly reuse.",
    category: "newsletter",
    subject: "Your monthly roundup",
    tags: ["digest", "monthly", "blog"],
    doc: doc([
      section(
        [
          paragraph([muted("MONTHLY ROUNDUP")], "center"),
          heading(1, [text("Three things worth your time this month")], "center"),
        ],
        { backgroundColor: "#18181b", paddingY: "lg" },
      ),
      section([
        paragraph([
          text("Hi "),
          tag("contact.firstName"),
          text(", the month in review — three reads we think you'll find useful."),
        ]),
      ]),
      section([
        heading(3, [link("The first article headline", "https://example.com/article-1")]),
        p(
          "A couple of sentences on why this matters. Focus on what the reader gets, not what the piece covers.",
        ),
        divider("solid", "#e4e4e7"),
        heading(3, [link("The second article headline", "https://example.com/article-2")]),
        p(
          "Keep each summary roughly the same length — a roundup reads as scannable because the blocks are even.",
        ),
        divider("solid", "#e4e4e7"),
        heading(3, [link("The third article headline", "https://example.com/article-3")]),
        p("End on the lightest item. It is the one people forward to a friend."),
      ]),
      section(
        [
          paragraph(
            [
              text("Want to see more? "),
              link("Visit our blog", "https://example.com/blog"),
              text(" for the full archive."),
            ],
            "center",
          ),
        ],
        { backgroundColor: "#f4f4f5", paddingY: "sm" },
      ),
      marketingFooter("our newsletter"),
    ]),
  },

  {
    id: "newsletter-digest",
    label: "Newsletter digest",
    description: "A short intro plus three linked stories. Built to be reused weekly.",
    category: "newsletter",
    subject: "Your weekly digest",
    tags: ["digest", "weekly", "roundup"],
    doc: doc([
      section(
        [
          paragraph([muted("THE WEEKLY")], "center"),
          heading(1, [text("Three things worth your time")], "center"),
        ],
        { backgroundColor: "#18181b", paddingY: "lg" },
      ),
      section([
        paragraph([
          text("Hi "),
          tag("contact.firstName"),
          text(", a short one this week — three reads, no filler."),
        ]),
      ]),
      section([
        heading(3, [link("The first story headline goes here", "https://example.com/story-1")]),
        p(
          "Two sentences on why this is worth clicking. Say what the reader gets out of it, not what the article is about.",
        ),
        divider("solid", "#e4e4e7"),
        heading(3, [link("The second story headline goes here", "https://example.com/story-2")]),
        p(
          "Keep each summary the same length — a digest reads as scannable because the blocks are even, not because the copy is short.",
        ),
        divider("solid", "#e4e4e7"),
        heading(3, [link("The third story headline goes here", "https://example.com/story-3")]),
        p("End on the lightest item. It is the one people forward."),
      ]),
      section(
        [
          paragraph(
            [
              text("Was this useful? "),
              link("Tell us what to cover next", "https://example.com/feedback"),
              text("."),
            ],
            "center",
          ),
        ],
        { backgroundColor: "#f4f4f5", paddingY: "sm" },
      ),
      marketingFooter("the weekly digest"),
    ]),
  },

  {
    id: "receipt",
    label: "Receipt",
    description: "A clean transactional receipt with an itemised summary.",
    category: "transactional",
    subject: "Your receipt",
    tags: ["receipt", "payment", "billing"],
    doc: doc([
      section([
        heading(2, [text("Thanks for your payment")]),
        paragraph([
          text("Hi "),
          tag("contact.firstName"),
          text(", this is your receipt. Nothing further is needed."),
        ]),
      ]),
      section(
        [
          paragraph([bold("Order "), text("#10482")]),
          paragraph([bold("Date "), text("3 April 2026")]),
          divider("solid", "#e4e4e7"),
          paragraph([text("Pro plan · monthly")]),
          paragraph([text("Additional seats × 3")]),
          divider("solid", "#e4e4e7"),
          paragraph([bold("Total charged "), text("USD 96.00")]),
          paragraph([muted("Charged to the card ending 4242.")]),
        ],
        { backgroundColor: "#fafafa" },
      ),
      section([button("View invoice", "https://example.com/invoice", "secondary")], {
        paddingY: "sm",
      }),
      section([
        paragraph([
          muted("Questions about this charge? Reply to this email and we'll look into it."),
        ]),
      ]),
    ]),
  },

  {
    id: "order-confirmation",
    label: "Order confirmation",
    description: "A clean order summary with item details and delivery estimate.",
    category: "transactional",
    subject: "Order confirmed ✓",
    tags: ["order", "receipt", "ecommerce"],
    doc: doc([
      section([
        heading(2, [text("Order confirmed")]),
        paragraph([
          text("Hi "),
          tag("contact.firstName"),
          text(", thanks — we've got your order and it's being prepared."),
        ]),
      ]),
      section(
        [
          paragraph([bold("Order #"), text("10482")]),
          paragraph([bold("Placed "), text("3 April 2026")]),
          divider("solid", "#e4e4e7"),
          paragraph([text("Pro plan · annual")]),
          paragraph([muted("USD 96.00")]),
          divider("solid", "#e4e4e7"),
          paragraph([text("Additional seats × 3")]),
          paragraph([muted("USD 36.00")]),
          divider("solid", "#e4e4e7"),
          paragraph([bold("Total "), text("USD 132.00")]),
          paragraph([muted("Estimated delivery: 5–7 business days.")]),
        ],
        { backgroundColor: "#fafafa" },
      ),
      section([button("View order details", "https://example.com/order", "secondary")], {
        paddingY: "sm",
      }),
      section([
        paragraph([
          muted("Questions about this order? "),
          link("Contact support", "mailto:support@example.com"),
          muted(" and we'll sort it out."),
        ]),
      ]),
    ]),
  },

  {
    id: "shipping-update",
    label: "Shipping update",
    description: "Tracking information with a direct link to follow the delivery.",
    category: "transactional",
    subject: "Your order is on its way",
    tags: ["shipping", "tracking", "delivery"],
    doc: doc([
      section([
        heading(2, [text("Your order is on its way")]),
        paragraph([
          text("Hi "),
          tag("contact.firstName"),
          text(", your order has shipped and is heading your way."),
        ]),
      ]),
      section(
        [
          paragraph([bold("Order #"), text("10482")]),
          paragraph([bold("Carrier "), text("USPS")]),
          paragraph([bold("Tracking "), text("9400111899223100012345")]),
          divider("solid", "#e4e4e7"),
          paragraph([bold("Estimated delivery "), text("Friday, 10 April")]),
        ],
        { backgroundColor: "#fafafa" },
      ),
      section([button("Track my package", "https://example.com/track")]),
      section([
        paragraph([
          muted("Need to change something? "),
          link("Edit your order", "https://example.com/order"),
          muted(" before it ships."),
        ]),
      ]),
    ]),
  },

  {
    id: "password-reset",
    label: "Password reset",
    description: "A single-purpose security email with an expiry note.",
    category: "transactional",
    subject: "Reset your password",
    tags: ["security", "password", "account"],
    doc: doc([
      section([
        heading(2, [text("Reset your password")]),
        p(
          "We received a request to reset the password for your account. Use the button below to choose a new one.",
        ),
        button("Choose a new password", "https://example.com/reset"),
        paragraph([muted("This link expires in 60 minutes and can be used once.")]),
      ]),
      section(
        [
          paragraph([
            bold("Didn't request this? "),
            text(
              "You can ignore this email — your password stays as it is, and the link above will expire on its own.",
            ),
          ]),
        ],
        { backgroundColor: "#f4f4f5", paddingY: "sm" },
      ),
    ]),
  },

  {
    id: "trial-ending",
    label: "Trial ending",
    description: "A deadline, what happens next, and one decision to make.",
    category: "lifecycle",
    subject: "Your trial ends in 3 days",
    tags: ["trial", "conversion", "billing"],
    doc: doc([
      section([
        heading(1, [text("Your trial ends in 3 days")]),
        paragraph([
          text("Hi "),
          tag("contact.firstName"),
          text(", here's exactly what happens on Friday so there are no surprises."),
        ]),
      ]),
      section(
        [
          paragraph([
            bold("If you upgrade: "),
            text("nothing changes. Your data, settings and team stay exactly as they are."),
          ]),
          paragraph([
            bold("If you don't: "),
            text(
              "your account moves to read-only. We keep your data for 90 days, so you can come back at any point.",
            ),
          ]),
        ],
        { backgroundColor: "#fafafa" },
      ),
      section([
        button("Choose a plan", "https://example.com/pricing"),
        paragraph([
          muted("Not sure which plan fits? Reply to this email and we'll tell you honestly."),
        ]),
      ]),
      marketingFooter("our product"),
    ]),
  },

  {
    id: "win-back",
    label: "Win-back",
    description: "A short, low-pressure note to contacts who have gone quiet.",
    category: "lifecycle",
    subject: "Still useful to you?",
    tags: ["re-engagement", "churn", "dormant"],
    doc: doc([
      section([
        heading(2, [text("Still useful to you?")]),
        paragraph([
          text("Hi "),
          tag("contact.firstName"),
          text(
            ", we noticed it's been a while. No pitch here — just one question, and either answer is fine.",
          ),
        ]),
        p(
          "If the product stopped fitting what you're doing, we'd genuinely like to know why. If you just got busy, everything is still where you left it.",
        ),
        button("Pick up where I left off", "https://example.com/login"),
      ]),
      section(
        [
          paragraph(
            [
              text("Prefer fewer emails from us? "),
              link("Unsubscribe", UNSUBSCRIBE_HREF),
              text(" — no hard feelings."),
            ],
            "center",
          ),
        ],
        { backgroundColor: "#f4f4f5", paddingY: "sm" },
      ),
    ]),
  },

  {
    id: "survey-request",
    label: "Feedback request",
    description: "One question, one link, and a stated time cost.",
    category: "lifecycle",
    subject: "Two minutes, one question",
    tags: ["survey", "feedback", "nps"],
    doc: doc([
      section([
        heading(2, [text("Can we borrow two minutes?")]),
        paragraph([
          text("Hi "),
          tag("contact.firstName"),
          text(", we're planning what to build next and your answer genuinely changes the order."),
        ]),
        paragraph([
          bold("The question: "),
          text("what is the one thing you wish this did better?"),
        ]),
        button("Answer in one box", "https://example.com/survey"),
        paragraph([muted("Five questions, no account needed, two minutes at most.")]),
      ]),
      marketingFooter("our product"),
    ]),
  },

  {
    id: "plain-text-style",
    label: "Plain personal note",
    description: "Looks hand-typed. Often the highest reply rate of anything here.",
    category: "lifecycle",
    subject: "Quick question, {{contact.firstName}}",
    tags: ["plain", "personal", "reply"],
    doc: doc([
      section([
        paragraph([text("Hi "), tag("contact.firstName"), text(",")]),
        p(
          "I'm one of the people who builds this, and I send this email by hand to everyone in your first month.",
        ),
        p("One question: what were you hoping this would solve for you when you signed up?"),
        p(
          "Whatever you reply goes straight to me, and I read every one. Even a half-sentence helps.",
        ),
        p("Thanks,"),
        paragraph([text("Sam")]),
      ]),
      section(
        [
          paragraph([
            muted("Don't want these? "),
            link("Unsubscribe", UNSUBSCRIBE_HREF),
            muted("."),
          ]),
        ],
        { paddingY: "sm" },
      ),
    ]),
  },

  {
    id: "referral-invite",
    label: "Referral invite",
    description: "A personal invite that rewards both the sender and the recipient.",
    category: "lifecycle",
    subject: "{{contact.firstName}}, you've got a friend on the inside",
    tags: ["referral", "invite", "viral"],
    doc: doc([
      section([
        paragraph([muted("FROM A FRIEND")], "center"),
        heading(1, [text("You've been invited")], "center"),
        paragraph(
          [
            text("Hi "),
            tag("contact.firstName"),
            text(
              ", someone you know thinks you'd get a lot out of this — and they're willing to put a reward on it.",
            ),
          ],
          "center",
        ),
      ]),
      section(
        [
          paragraph([
            bold("The offer: "),
            text(
              "Both of you get one month free when you sign up. No credit card required to start.",
            ),
          ]),
          paragraph([
            bold("What you get: "),
            text(
              "Everything in the Pro plan — unlimited projects, priority support, and the full API.",
            ),
          ]),
          paragraph([
            bold("How it works: "),
            text("Click the button, create your account, and the credit is applied automatically."),
          ]),
        ],
        { backgroundColor: "#fafafa" },
      ),
      section([button("Accept my invite", "https://example.com/invite", "primary", "center")]),
      section(
        [
          paragraph(
            [
              muted("Not interested? "),
              link("Unsubscribe", UNSUBSCRIBE_HREF),
              muted(" — no hard feelings."),
            ],
            "center",
          ),
        ],
        { paddingY: "sm" },
      ),
    ]),
  },
] as const;

export function findCommunityTemplate(id: string): CommunityEmailTemplate | undefined {
  return COMMUNITY_EMAIL_TEMPLATES.find((template) => template.id === id);
}

export function communityTemplatesByCategory(
  category: CommunityTemplateCategory,
): CommunityEmailTemplate[] {
  return COMMUNITY_EMAIL_TEMPLATES.filter((template) => template.category === category);
}
