import { EditorContent, type Editor } from "@tiptap/react";
import { cn } from "@loopkit/ui/lib/utils";

/**
 * The 600px-wide email column. The blocks carry their own inline styles from
 * the editing DOM, so the canvas only needs to constrain the width and give
 * the editable area a sensible min-height.
 */
export function Canvas({ editor, className }: { editor: Editor; className?: string }) {
  return (
    <div
      className={cn(
        "email-editor-paper mx-auto w-full max-w-[600px] overflow-hidden rounded-sm bg-white text-slate-900 shadow-[0_24px_52px_-26px_rgb(15_23_42_/_0.5)] ring-1 ring-black/5",
        className,
      )}
    >
      <EditorContent editor={editor} />
    </div>
  );
}
