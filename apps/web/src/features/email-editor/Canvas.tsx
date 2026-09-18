import { EditorContent, type Editor } from "@tiptap/react";
import { cn } from "@loopkit/ui/lib/utils";

/**
 * The 600px-wide email column. The blocks carry their own inline styles from
 * the editing DOM, so the canvas only needs to constrain the width and give
 * the editable area a sensible min-height.
 */
export function Canvas({ editor, className }: { editor: Editor; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[600px] overflow-hidden bg-card", className)}>
      <EditorContent editor={editor} />
    </div>
  );
}
