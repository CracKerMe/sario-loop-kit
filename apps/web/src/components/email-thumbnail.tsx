import { cn } from "@loopkit/ui/lib/utils";
import { useEffect, useRef, useState } from "react";

/**
 * An email is laid out by the *client*, not by the card it is previewed in.
 * Squashing a 640px-wide document into a 320px box is not a smaller email — it
 * is a different one, reflowed text, wrapped buttons, collapsed tables — so a
 * squashed thumbnail lies about what will be sent.
 *
 * The fix is to render the document at a realistic width and then scale the
 * whole thing down: the layout stays exactly as a client would compute it, only
 * the pixels are smaller. That requires knowing the card's width, hence the
 * ResizeObserver — a CSS-only version cannot express `scale(container / 640)`.
 */
const VIRTUAL_WIDTH = 640;

export function useFitScale(virtualWidth = VIRTUAL_WIDTH) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      if (width > 0) {
        setScale(width / virtualWidth);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [virtualWidth]);

  return { ref, scale };
}

/**
 * Scaled email preview. `height` is the *visible* height in CSS pixels; the
 * iframe itself is made taller than that (`height / scale`) so the crop always
 * shows the top of the email at its true proportions.
 *
 * `scale === null` means "not measured yet" — the first paint shows a shimmer
 * instead of a zero-height frame, which would otherwise make every card jump
 * once the observer fires.
 */
export function EmailThumbnail({
  html,
  height = 172,
  fade = true,
  className,
}: {
  html: string;
  height?: number;
  fade?: boolean;
  className?: string;
}) {
  const { ref, scale } = useFitScale();

  return (
    <div
      ref={ref}
      style={{ height }}
      className={cn("relative overflow-hidden bg-white", className)}
    >
      {scale === null && <div className="absolute inset-0 animate-pulse bg-muted" />}
      <iframe
        title="Email preview"
        srcDoc={html}
        sandbox=""
        loading="lazy"
        scrolling="no"
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
        style={{
          width: VIRTUAL_WIDTH,
          height: scale ? Math.ceil(height / scale) : 0,
          transform: `scale(${scale ?? 0})`,
          opacity: scale === null ? 0 : 1,
        }}
      />
      {fade && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card/90 via-card/25 to-transparent" />
      )}
    </div>
  );
}
