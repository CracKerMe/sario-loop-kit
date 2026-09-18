import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { createFileRoute } from "@tanstack/react-router";
import { FilterIcon, Loader2Icon, PencilIcon, PlusIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { PageHeader } from "@/components/page-header";
import { AudienceFilterBuilder } from "@/features/audiences/AudienceFilterBuilder";
import {
  emptyFieldRow,
  parseRows,
  rowsToFilter,
  type GroupMode,
  type Row,
} from "@/features/audiences/filter";
import { api, type AudienceWithCountsDto } from "@/lib/api";

export const Route = createFileRoute("/_auth/audiences/")({
  component: AudiencesPage,
});

function AudiencesPage() {
  const [audiences, setAudiences] = useState<AudienceWithCountsDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AudienceWithCountsDto | null>(null);
  /** Set when a saved filter uses nesting the flat builder can't represent. */
  const [editBlocked, setEditBlocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [rows, setRows] = useState<Row[]>([emptyFieldRow()]);
  const [mode, setMode] = useState<GroupMode>("and");

  const load = async () => {
    try {
      const res = await api.audiences();
      setAudiences(res.audiences);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load audiences");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const resetForm = () => {
    setName("");
    setRows([emptyFieldRow()]);
    setMode("and");
    setEditBlocked(false);
  };

  const openCreate = () => {
    resetForm();
    setCreating(true);
  };

  const openEdit = (audience: AudienceWithCountsDto) => {
    const parsed = parseRows(audience.filter);
    setName(audience.name);
    if (!parsed) {
      // Refusing to edit is the point: flattening a nested filter would
      // silently change who the segment contains.
      setRows([]);
      setEditBlocked(true);
    } else {
      setRows(parsed.rows);
      setMode(parsed.mode);
      setEditBlocked(false);
    }
    setEditing(audience);
  };

  const submit = async () => {
    const filter = rowsToFilter(rows, mode);
    if (!filter) {
      toast.error("Add at least one complete condition");
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        await api.updateAudience(editing.id, { name, filter });
        toast.success("Audience updated");
        setEditing(null);
      } else {
        await api.createAudience({ name, filter });
        toast.success("Audience created");
        setCreating(false);
      }
      resetForm();
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (audience: AudienceWithCountsDto) => {
    if (!confirm(`Delete "${audience.name}"? Campaigns already sent keep their own copy.`)) return;
    try {
      await api.deleteAudience(audience.id);
      toast.success("Audience deleted");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const dialogOpen = creating || editing !== null;
  const closeDialog = () => {
    setCreating(false);
    setEditing(null);
    resetForm();
  };

  return (
    <div className="lk-fade-up mx-auto w-full max-w-5xl px-4 py-6">
      <PageHeader
        title="Audiences"
        description="Saved segments, evaluated live against contacts, properties and events"
        actions={
          <Button size="sm" onClick={openCreate}>
            <PlusIcon data-icon="inline-start" />
            New audience
          </Button>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && (
        <div className="grid gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      )}

      {!loading && audiences.length === 0 && (
        <div className="rounded-xl border border-dashed px-6 py-16 text-center">
          <span className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
            <FilterIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="text-sm font-medium">No audiences yet</div>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            An audience is a saved query over your contacts — properties, subscription state and
            everything they have done. Campaigns send to one.
          </p>
          <Button size="sm" className="mt-4" onClick={openCreate}>
            <PlusIcon data-icon="inline-start" />
            New audience
          </Button>
        </div>
      )}

      {!loading && audiences.length > 0 && (
        <div className="grid gap-3">
          {audiences.map((audience) => {
            const excluded = audience.memberCount - audience.sendableCount;
            return (
              <div
                key={audience.id}
                className="flex items-start gap-3 rounded-xl border border-border bg-card p-3 shadow-sm transition-colors duration-200 hover:border-primary/40"
              >
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <UsersIcon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{audience.name}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {audience.summary}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs">
                    <span className="text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {audience.memberCount.toLocaleString()}
                      </span>{" "}
                      match
                    </span>
                    <span className="text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {audience.sendableCount.toLocaleString()}
                      </span>{" "}
                      mailable
                    </span>
                    {excluded > 0 && (
                      <span className="text-muted-foreground">
                        {excluded.toLocaleString()} excluded (unsubscribed or suppressed)
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${audience.name}`}
                    onClick={() => openEdit(audience)}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${audience.name}`}
                    onClick={() => void remove(audience)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        title={editing ? "Edit audience" : "New audience"}
        description={
          editBlocked
            ? "This audience uses an advanced filter and can only be renamed here."
            : "Conditions are combined with AND or OR. Property keys are top-level keys on a contact."
        }
      >
        {editBlocked ? (
          <div className="grid gap-3">
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              Editing would flatten this filter's grouped or negated conditions and change who it
              matches, so the builder will not touch them. Rename it below, or create a new audience
              to replace it.
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="aud-name-blocked" className="text-sm font-medium">
                Name
              </label>
              <Input id="aud-name-blocked" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Button
              disabled={submitting}
              onClick={async () => {
                if (!editing) return;
                setSubmitting(true);
                try {
                  await api.updateAudience(editing.id, { name });
                  toast.success("Audience renamed");
                  closeDialog();
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Rename failed");
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              {submitting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              Save name
            </Button>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <AudienceFilterBuilder
              name={name}
              onNameChange={setName}
              rows={rows}
              onRowsChange={setRows}
              mode={mode}
              onModeChange={setMode}
            />
            <Button type="submit" disabled={submitting || name.trim().length === 0}>
              {submitting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              {editing ? "Save changes" : "Create audience"}
            </Button>
          </form>
        )}
      </Dialog>
    </div>
  );
}
