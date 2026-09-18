import { EMAIL_DOC_PRESETS, renderEmailDoc } from "@loopkit/email-doc";
import { emailTemplate, workspace } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createEmailTemplate,
  EmailDocValidationError,
  getEmailTemplate,
  previewEmailDoc,
  renderTemplateDoc,
  updateEmailTemplate,
} from "../emailTemplates";
import { resetTables, testDb } from "./testDb";

const db = testDb();

const announcement = EMAIL_DOC_PRESETS[0]!.doc;

describe("email templates with a visual-editor document", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  });

  it("renders the document server-side and stores both doc and html", async () => {
    const template = await createEmailTemplate(db, {
      workspaceId: "ws-1",
      name: "Announcement",
      subject: "Hi {{contact.firstName}}",
      doc: announcement,
    });

    expect(template.source).toBe("tiptap");
    expect(template.doc).toMatchObject({ type: "doc" });
    // The stored HTML is the renderer's output, not anything the caller sent.
    expect(template.html).toBe(renderEmailDoc(announcement));
    expect(template.html).toContain('role="presentation"');
    // A plain-text alternative is derived, because a multipart/alternative
    // with a real text part measurably helps deliverability.
    expect(template.textBody).toBeTruthy();
    expect(template.textBody).toContain("Something new just shipped");
  });

  it("ignores a client-supplied html when a doc is present", async () => {
    // Otherwise the renderer's layout guarantee — inline styles only, no
    // flex/grid, tables for layout — would be bypassable by posting both.
    const template = await createEmailTemplate(db, {
      workspaceId: "ws-1",
      name: "Sneaky",
      subject: "s",
      doc: announcement,
      html: '<div style="display:flex">hand-rolled</div>',
    });

    expect(template.html).not.toContain("hand-rolled");
    expect(template.html).not.toContain("display:flex");
    expect(template.source).toBe("tiptap");
  });

  it("keeps the raw-HTML path working, unchanged", async () => {
    const template = await createEmailTemplate(db, {
      workspaceId: "ws-1",
      name: "Legacy",
      subject: "s",
      html: "<p>Hi {{firstName}}</p>",
    });

    expect(template.source).toBe("html");
    expect(template.doc).toBeNull();
    expect(template.html).toBe("<p>Hi {{firstName}}</p>");
    expect(template.textBody).toBeNull();
  });

  it("rejects a document that is structurally invalid, and writes nothing", async () => {
    await expect(
      createEmailTemplate(db, {
        workspaceId: "ws-1",
        name: "Bad",
        subject: "s",
        doc: {
          type: "doc",
          content: [{ type: "emailSection", content: [{ type: "blockquote" }] }],
        },
      }),
    ).rejects.toBeInstanceOf(EmailDocValidationError);

    const rows = await db.select().from(emailTemplate);
    expect(rows).toHaveLength(0);
  });

  it("rejects a document whose attribute values are unsafe even though the schema is fine", async () => {
    // ProseMirror's schema has no opinion about a URL's scheme — this is
    // exactly the gap the zod pass in @loopkit/email-doc exists to close.
    await expect(
      createEmailTemplate(db, {
        workspaceId: "ws-1",
        name: "XSS",
        subject: "s",
        doc: {
          type: "doc",
          content: [
            {
              type: "emailSection",
              content: [
                {
                  type: "emailButton",
                  attrs: { href: "javascript:alert(1)" },
                  content: [{ type: "text", text: "Click" }],
                },
              ],
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(EmailDocValidationError);
  });

  it("requires either a doc or a non-empty html", async () => {
    await expect(
      createEmailTemplate(db, { workspaceId: "ws-1", name: "Empty", subject: "s" }),
    ).rejects.toThrow(/either `doc` or a non-empty `html`/);

    await expect(
      createEmailTemplate(db, { workspaceId: "ws-1", name: "Empty", subject: "s", html: "   " }),
    ).rejects.toThrow(/either `doc` or a non-empty `html`/);
  });

  it("re-renders on update and preserves the other fields", async () => {
    const created = await createEmailTemplate(db, {
      workspaceId: "ws-1",
      name: "Announcement",
      subject: "first",
      doc: announcement,
      fromName: "Acme",
    });

    const updated = await updateEmailTemplate(db, "ws-1", created.id, {
      subject: "second",
      doc: EMAIL_DOC_PRESETS[1]!.doc,
    });

    expect(updated?.subject).toBe("second");
    expect(updated?.fromName).toBe("Acme");
    expect(updated?.html).toBe(renderEmailDoc(EMAIL_DOC_PRESETS[1]!.doc));
    expect(updated?.source).toBe("tiptap");
  });

  it("does not touch the rendered html when only the subject changes", async () => {
    const created = await createEmailTemplate(db, {
      workspaceId: "ws-1",
      name: "Announcement",
      subject: "first",
      doc: announcement,
    });
    const originalHtml = created.html;

    const updated = await updateEmailTemplate(db, "ws-1", created.id, { subject: "renamed" });

    expect(updated?.html).toBe(originalHtml);
    expect(updated?.doc).toMatchObject({ type: "doc" });
  });

  it("converts an html-authored template to editor-managed on its first doc save", async () => {
    const created = await createEmailTemplate(db, {
      workspaceId: "ws-1",
      name: "Legacy",
      subject: "s",
      html: "<p>old</p>",
    });
    expect(created.source).toBe("html");

    const updated = await updateEmailTemplate(db, "ws-1", created.id, { doc: announcement });

    expect(updated?.source).toBe("tiptap");
    expect(updated?.html).toBe(renderEmailDoc(announcement));
  });

  it("keeps the last rendered html when the document is detached", async () => {
    const created = await createEmailTemplate(db, {
      workspaceId: "ws-1",
      name: "Announcement",
      subject: "s",
      doc: announcement,
    });

    const detached = await updateEmailTemplate(db, "ws-1", created.id, { doc: null });

    // The template keeps sending exactly what it last sent rather than
    // silently becoming empty.
    expect(detached?.source).toBe("html");
    expect(detached?.doc).toBeNull();
    expect(detached?.html).toBe(created.html);
  });

  it("returns null from update for a template in another workspace", async () => {
    await db.insert(workspace).values({ id: "ws-2", name: "other", slug: "ws-2" });
    const created = await createEmailTemplate(db, {
      workspaceId: "ws-1",
      name: "Mine",
      subject: "s",
      doc: announcement,
    });

    expect(await updateEmailTemplate(db, "ws-2", created.id, { doc: announcement })).toBeNull();
    expect(await getEmailTemplate(db, "ws-2", created.id)).toBeNull();
    const still = await getEmailTemplate(db, "ws-1", created.id);
    expect(still?.source).toBe("tiptap");
  });

  it("previews through the same pipeline the save uses", async () => {
    const preview = previewEmailDoc(announcement);
    expect(preview.html).toContain('role="presentation"');
    expect(preview.mergeTags).toContain("contact.firstName");
    expect(preview.textBody).toContain("Something new just shipped");
  });

  it("exposes the merge tags a document depends on", () => {
    const { mergeTags } = renderTemplateDoc(announcement);
    expect(mergeTags).toEqual(["contact.firstName"]);
  });

  it("round-trips the stored document without loss", async () => {
    const created = await createEmailTemplate(db, {
      workspaceId: "ws-1",
      name: "Round trip",
      subject: "s",
      doc: announcement,
    });
    const reloaded = await getEmailTemplate(db, "ws-1", created.id);
    // Re-rendering what was read back must equal what was first written, or
    // the editor would drift a template a little every time it is opened.
    expect(renderEmailDoc(reloaded?.doc)).toBe(created.html);
  });

  it("marks the derived html as editor-managed in the database, not just in the response", async () => {
    const created = await createEmailTemplate(db, {
      workspaceId: "ws-1",
      name: "Announcement",
      subject: "s",
      doc: announcement,
    });
    const [row] = await db.select().from(emailTemplate).where(eq(emailTemplate.id, created.id));
    expect(row?.source).toBe("tiptap");
    expect(row?.doc).not.toBeNull();
  });
});
