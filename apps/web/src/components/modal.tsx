import { cn } from "@loopkit/ui/lib/utils";
import { AlertTriangleIcon, XIcon } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
};

/** A body-mounted modal for flows that must escape local stacking contexts. */
function Modal({ open, onClose, title, description, children, className }: ModalProps) {
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className={cn(
          "lk-fade-up relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl",
          className,
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 p-5 pb-0">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

type ConfirmOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type ConfirmRequest = ConfirmOptions & {
  resolve: (confirmed: boolean) => void;
};

type ModalContextValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const ModalContext = React.createContext<ModalContextValue | null>(null);

function ModalProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null);

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setRequest({ ...options, resolve });
      }),
    [],
  );

  const close = React.useCallback((confirmed: boolean) => {
    setRequest((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);

  return (
    <ModalContext.Provider value={{ confirm }}>
      {children}
      <Modal
        open={request !== null}
        onClose={() => close(false)}
        title={request?.title ?? "Confirm action"}
      >
        <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          {request?.destructive && (
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          )}
          <p>{request?.description}</p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => close(false)}
          >
            {request?.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            className={cn(
              "inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium text-primary-foreground transition-colors",
              request?.destructive
                ? "bg-destructive hover:bg-destructive/90"
                : "bg-primary hover:bg-primary/90",
            )}
            onClick={() => close(true)}
          >
            {request?.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </Modal>
    </ModalContext.Provider>
  );
}

function useModal() {
  const context = React.useContext(ModalContext);
  if (!context) throw new Error("useModal must be used within ModalProvider");
  return context;
}

export { Modal, ModalProvider, useModal };
