import { Button } from "@loopkit/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@loopkit/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@loopkit/ui/components/empty";
import { Label } from "@loopkit/ui/components/label";
import { CodeIcon, DownloadIcon, UploadIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { api, type JourneyDto } from "@/lib/api";

export function JourneyCodePanel() {
  const [journeys, setJourneys] = useState<JourneyDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<"json" | "yaml">("json");
  const [exporting, setExporting] = useState<string | null>(null);
  const [document, setDocument] = useState("");
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await api.journeys();
      setJourneys(res.journeys);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load journeys");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const exportJourney = async (id: string) => {
    setBusy(true);
    try {
      const res = await api.exportJourney(id, format);
      setExporting(id);
      setDocument(res.document);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };

  const download = (name: string, body: string) => {
    const blob = new Blob([body], {
      type: format === "yaml" ? "text/yaml" : "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "journey"}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importDoc = async () => {
    if (!document.trim()) return;
    setBusy(true);
    try {
      const res = await api.importJourney(document.trim());
      toast.success(`Imported journey "${res.name}"`);
      setImporting(false);
      setDocument("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CodeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Journey as code
            </CardTitle>
            <CardDescription>
              Export a published graph as JSON/YAML, or import a document to create a draft journey.
              Compile path is unchanged.
            </CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            <select
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
              value={format}
              onChange={(e) => setFormat(e.target.value as "json" | "yaml")}
              aria-label="Export format"
            >
              <option value="json">json</option>
              <option value="yaml">yaml</option>
            </select>
            <Button size="sm" onClick={() => setImporting(true)}>
              <UploadIcon className="size-3.5" aria-hidden="true" />
              Import
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-xs text-muted-foreground">Loading journeys…</div>
          ) : error ? (
            <div className="text-xs text-rose-600">{error}</div>
          ) : journeys.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No journeys</EmptyTitle>
                <EmptyDescription>
                  Publish a journey first, then export it here for version control.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-2">
              {journeys.map((journey) => (
                <div
                  key={journey.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                >
                  <div>
                    <div className="text-sm font-medium">{journey.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {journey.status} · v{journey.publishedVersion ?? "—"}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void exportJourney(journey.id)}
                  >
                    <DownloadIcon className="size-3.5" aria-hidden="true" />
                    Export
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!exporting}
        onClose={() => setExporting(null)}
        title="Exported journey"
        description={`Document in ${format}. Copy it into git or paste into Import.`}
      >
        <div className="grid gap-3">
          <textarea
            readOnly
            className="min-h-64 w-full rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-xs"
            value={document}
          />
          <Button
            onClick={() => {
              const name = journeys.find((j) => j.id === exporting)?.name || "journey";
              download(name, document);
            }}
          >
            <DownloadIcon className="size-3.5" aria-hidden="true" />
            Download {format}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={importing}
        onClose={() => setImporting(false)}
        title="Import journey document"
        description="Paste a JSON or YAML export. Creates a draft journey you can edit and publish."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="import-doc">Document</Label>
            <textarea
              id="import-doc"
              className="min-h-48 rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-xs"
              value={document}
              onChange={(e) => setDocument(e.target.value)}
              placeholder='{"name":"Welcome","graph":{...}}'
            />
          </div>
          <Button onClick={() => void importDoc()} disabled={busy || !document.trim()}>
            {busy ? "Importing…" : "Import journey"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
