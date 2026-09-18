import { Button } from "@loopkit/ui/components/button";
import { Checkbox } from "@loopkit/ui/components/checkbox";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { Skeleton } from "@loopkit/ui/components/skeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  Code2Icon,
  DownloadIcon,
  FileSpreadsheetIcon,
  FilterIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  UploadIcon,
  UsersIcon,
  WebhookIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { PageHeader } from "@/components/page-header";
import { api, getApiBaseUrl, type ContactDto } from "@/lib/api";

export const Route = createFileRoute("/_auth/contacts/")({ component: ContactsPage });

const AVATAR_TONES = [
  "from-violet-500/70 to-indigo-500/70",
  "from-emerald-500/70 to-teal-500/70",
  "from-sky-500/70 to-blue-500/70",
  "from-amber-500/70 to-orange-500/70",
  "from-rose-500/70 to-pink-500/70",
];
type Status = "all" | "subscribed" | "unsubscribed";
type ImportRow = { email: string; userId?: string; properties?: Record<string, unknown> };
type ImportResult = { total: number; created: number; updated: number; failed: number };

const CONTACTS_EXAMPLE_CSV = `email,user_id,firstName,lastName,userGroup,source,plan
mei@northstar.io,u_001,Mei,Lin,Customers,Website,pro
aria@fieldnote.co,u_002,Aria,Kim,Trial users,Product signup,starter
`;

function Avatar({ email }: { email: string }) {
  const tone =
    AVATAR_TONES[
      [...email].reduce((sum, char) => sum + char.charCodeAt(0), 0) % AVATAR_TONES.length
    ];
  return (
    <span
      aria-hidden="true"
      className={`grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br ${tone} text-[11px] font-semibold text-white`}
    >
      {(email[0] ?? "?").toUpperCase()}
    </span>
  );
}

function parseCsv(text: string): ImportRow[] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      record.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record.push(cell);
      if (record.some((value) => value.trim())) records.push(record);
      record = [];
      cell = "";
    } else cell += char;
  }
  record.push(cell);
  if (record.some((value) => value.trim())) records.push(record);
  if (records.length < 2) return [];
  const headers = records[0].map((value) => value.trim().toLowerCase());
  const emailIndex = headers.indexOf("email");
  if (emailIndex < 0) throw new Error("CSV needs an email column.");
  return records.slice(1).map((values) => {
    const properties: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      const value = values[index]?.trim();
      if (value && header && !["email", "user_id", "userid"].includes(header))
        properties[header] = value;
    });
    const userId =
      values[headers.indexOf("user_id")]?.trim() || values[headers.indexOf("userid")]?.trim();
    return {
      email: values[emailIndex]?.trim() ?? "",
      ...(userId ? { userId } : {}),
      ...(Object.keys(properties).length ? { properties } : {}),
    };
  });
}

function download(filename: string, contents: string, type = "text/csv;charset=utf-8") {
  const data = filename === "contacts-example.csv" ? CONTACTS_EXAMPLE_CSV : contents;
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ContactsPage() {
  const [contacts, setContacts] = useState<ContactDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [firstName, setFirstName] = useState("");
  const [company, setCompany] = useState("");
  const [plan, setPlan] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.contacts({ query: query.trim() || undefined, status });
      setContacts(res.contacts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load contacts");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query, status]);
  useEffect(() => setSelected([]), [contacts]);
  const allSelected =
    contacts.length > 0 && contacts.every((contact) => selected.includes(contact.id));
  const subscribedCount = contacts.filter((contact) => contact.subscribed).length;
  const apiBase = getApiBaseUrl();
  const handleFile = async (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Choose a .csv file");
      return;
    }
    try {
      const parsed = parseCsv(await file.text());
      if (!parsed.length) throw new Error("No data rows found.");
      if (parsed.length > 500) throw new Error("Import up to 500 contacts at a time.");
      setRows(parsed);
      setImportResult(null);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not read CSV");
    }
  };
  const importRows = async () => {
    if (!rows.length) return;
    setImporting(true);
    try {
      const result = await api.importContacts({ rows });
      setImportResult(result);
      toast.success(`Imported ${result.created + result.updated} contacts`);
      await load();
    } catch {
      toast.error("Import failed. Please try again.");
    } finally {
      setImporting(false);
    }
  };
  const resetCreateForm = () => {
    setEmail("");
    setUserId("");
    setFirstName("");
    setCompany("");
    setPlan("");
  };
  const createContact = async () => {
    if (!email.trim()) return;
    setCreating(true);
    try {
      const properties = Object.fromEntries(
        [
          ["first_name", firstName],
          ["company", company],
          ["plan", plan],
        ]
          .filter(([, value]) => value.trim())
          .map(([key, value]) => [key, value.trim()]),
      );
      await api.createContact({
        email: email.trim(),
        ...(userId.trim() ? { userId: userId.trim() } : {}),
        ...(Object.keys(properties).length ? { properties } : {}),
      });
      toast.success("Contact added");
      setCreateOpen(false);
      resetCreateForm();
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not add contact");
    } finally {
      setCreating(false);
    }
  };
  const bulk = async (action: "unsubscribe" | "resubscribe") => {
    if (!selected.length) return;
    try {
      await api.bulkUpdateContacts({ action, ids: selected });
      toast.success(`${selected.length} contacts updated`);
      await load();
    } catch {
      toast.error("Bulk update failed");
    }
  };
  const exportContacts = async (format: "csv" | "json") => {
    const params = new URLSearchParams({ format });
    if (query.trim()) params.set("query", query.trim());
    if (status !== "all") params.set("status", status);
    try {
      const res = await fetch(`${apiBase}/v1/contacts/export?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error();
      download(
        `contacts-${new Date().toISOString().slice(0, 10)}.${format}`,
        await res.text(),
        format === "json" ? "application/json" : "text/csv;charset=utf-8",
      );
      toast.success(`${format.toUpperCase()} export downloaded`);
    } catch {
      toast.error("Export failed");
    }
  };

  return (
    <div className="lk-fade-up mx-auto w-full max-w-6xl px-4 py-6 md:px-7">
      <PageHeader
        title="Contacts"
        description={
          <>
            {contacts.length} shown · {subscribedCount} subscribed
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setIntegrationsOpen(true)}>
              <WebhookIcon data-icon="inline-start" />
              Integrations
            </Button>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <UploadIcon data-icon="inline-start" />
              Import contacts
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              Add contact
            </Button>
          </>
        }
      />
      <section className="mb-5 grid gap-3 rounded-xl border border-border bg-card p-3 shadow-sm md:grid-cols-[minmax(0,1fr)_auto_auto]">
        <div className="relative">
          <SearchIcon className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search email or contact fields…"
            className="h-9 pl-9"
            aria-label="Search contacts"
          />
        </div>
        <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-xs text-muted-foreground">
          <FilterIcon className="size-3.5" />
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as Status)}
            className="bg-transparent text-foreground outline-none"
          >
            <option value="all">All statuses</option>
            <option value="subscribed">Subscribed</option>
            <option value="unsubscribed">Unsubscribed</option>
          </select>
        </label>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => void exportContacts("csv")}>
            <DownloadIcon data-icon="inline-start" />
            CSV
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void exportContacts("json")}>
            JSON
          </Button>
        </div>
      </section>
      {selected.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
          <span className="font-medium">{selected.length} selected</span>
          <Button size="xs" variant="outline" onClick={() => void bulk("unsubscribe")}>
            Unsubscribe
          </Button>
          <Button size="xs" variant="outline" onClick={() => void bulk("resubscribe")}>
            Resubscribe
          </Button>
          <button
            type="button"
            className="ml-auto text-muted-foreground hover:text-foreground"
            onClick={() => setSelected([])}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {loading && (
        <div className="grid gap-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      )}
      {!loading && contacts.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto_auto] items-center border-b border-border bg-muted/25 px-3 py-2 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            <Checkbox
              checked={allSelected}
              onCheckedChange={(checked) =>
                setSelected(checked ? contacts.map((contact) => contact.id) : [])
              }
              aria-label="Select all contacts"
            />
            <span>Contact</span>
            <span className="pr-8">Status</span>
            <span />
          </div>
          {contacts.map((contact) => (
            <div
              key={contact.id}
              className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto_auto] items-center border-b border-border/60 px-3 last:border-0 hover:bg-muted/30"
            >
              <Checkbox
                checked={selected.includes(contact.id)}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    checked ? [...current, contact.id] : current.filter((id) => id !== contact.id),
                  )
                }
                aria-label={`Select ${contact.email}`}
              />
              <Link
                to="/contacts/$contactId"
                params={{ contactId: contact.id }}
                className="group flex min-w-0 items-center gap-3 py-3"
              >
                <Avatar email={contact.email} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{contact.email}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {Object.entries(contact.properties)
                      .slice(0, 2)
                      .map(([key, value]) => `${key}: ${String(value)}`)
                      .join(" · ") || "No custom fields"}
                  </div>
                </div>
              </Link>
              <span
                className={`mr-4 hidden rounded-sm px-1.5 py-0.5 text-[10px] font-medium sm:inline-flex ${contact.subscribed ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}
              >
                {contact.subscribed ? "Subscribed" : "Unsubscribed"}
              </span>
              <Link
                to="/contacts/$contactId"
                params={{ contactId: contact.id }}
                aria-label={`Open ${contact.email}`}
                className="p-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRightIcon className="size-4" />
              </Link>
            </div>
          ))}
        </div>
      )}
      {!loading && contacts.length === 0 && (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <UsersIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
          <h2 className="text-sm font-medium">
            {query ? "No contacts match this search" : "Your contact list is empty"}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
            {query
              ? "Try a different email, property, or subscription status."
              : "Add one contact at a time, import a CSV, or connect your application through the API."}
          </p>
          {!query && (
            <div className="mt-4 flex justify-center gap-2">
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <PlusIcon data-icon="inline-start" />
                Add contact
              </Button>
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                <UploadIcon data-icon="inline-start" />
                Upload CSV
              </Button>
            </div>
          )}
        </div>
      )}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Add contact"
        description="Add one contact now. You can add more custom fields later from an import or your API."
      >
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createContact();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="contact-email">Email</Label>
            <Input
              id="contact-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="aria@example.com"
              autoComplete="email"
              required
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="contact-user-id">
              User ID <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="contact-user-id"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="usr_123"
            />
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="contact-first-name">First name</Label>
              <Input
                id="contact-first-name"
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
                placeholder="Aria"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="contact-company">Company</Label>
              <Input
                id="contact-company"
                value={company}
                onChange={(event) => setCompany(event.target.value)}
                placeholder="Fieldnote"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="contact-plan">Plan</Label>
            <Input
              id="contact-plan"
              value={plan}
              onChange={(event) => setPlan(event.target.value)}
              placeholder="starter"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !email.trim()}>
              {creating && <Loader2Icon className="animate-spin" data-icon="inline-start" />}Add
              contact
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import contacts"
        description="CSV files up to 500 rows. Existing email addresses will be updated."
      >
        <div className="space-y-4">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(event) => void handleFile(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="flex w-full flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-5 py-7 text-center transition-colors hover:border-primary/50 hover:bg-primary/5"
          >
            <FileSpreadsheetIcon className="mb-2 size-6 text-primary" />
            <span className="text-sm font-medium">Choose a CSV file</span>
            <span className="mt-1 text-xs text-muted-foreground">
              Required: email · Optional: user_id and any custom columns
            </span>
          </button>
          <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
            <div>
              <div className="text-xs font-medium">Need a starting point?</div>
              <div className="text-[11px] text-muted-foreground">
                Download a file with example contact fields.
              </div>
            </div>
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                download(
                  "contacts-example.csv",
                  "email,user_id,first_name,company,plan\nmei@northstar.io,u_001,Mei,Northstar,pro\naria@fieldnote.co,u_002,Aria,Fieldnote,starter\n",
                )
              }
            >
              Example CSV
            </Button>
          </div>
          {rows.length > 0 && (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCircle2Icon className="size-4" />
                {rows.length} contacts ready to import
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {rows
                  .slice(0, 3)
                  .map((row) => row.email)
                  .join(" · ")}
                {rows.length > 3 ? " …" : ""}
              </p>
            </div>
          )}
          {importResult && (
            <div className="text-xs text-muted-foreground">
              Created {importResult.created}, updated {importResult.updated}
              {importResult.failed ? `, ${importResult.failed} failed` : ""}.
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              Close
            </Button>
            <Button disabled={!rows.length || importing} onClick={() => void importRows()}>
              {importing && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {importing ? "Importing" : `Import ${rows.length || ""} contacts`}
            </Button>
          </div>
        </div>
      </Dialog>
      <Dialog
        open={integrationsOpen}
        onClose={() => setIntegrationsOpen(false)}
        title="Bring contacts in automatically"
        description="Use the same contact model across CSV, your API, and event-driven webhooks."
        className="max-w-2xl"
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border p-4">
            <Code2Icon className="mb-3 size-5 text-primary" />
            <h3 className="text-sm font-semibold">Application API</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Create a scoped API key, then upsert contacts from your backend or product.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-[10px] leading-5 text-muted-foreground">
              POST {apiBase}/v1/contacts{"\n"}Authorization: Bearer YOUR_KEY{"\n\n"}
              {'{ "email": "mei@example.com", "properties": { "plan": "pro" } }'}
            </pre>
            <Link
              to="/api-keys"
              className="mt-3 inline-flex text-xs font-medium text-primary hover:underline"
            >
              Manage API keys →
            </Link>
          </div>
          <div className="rounded-xl border border-border p-4">
            <WebhookIcon className="mb-3 size-5 text-primary" />
            <h3 className="text-sm font-semibold">Webhook events</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Send product activity to wake journeys and keep each contact’s history current.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-[10px] leading-5 text-muted-foreground">
              POST {apiBase}/v1/events{"\n"}Authorization: Bearer YOUR_KEY{"\n\n"}
              {'{ "email": "mei@example.com", "name": "trial_started" }'}
            </pre>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Use an idempotency key when your sender retries deliveries.
            </p>
          </div>
        </div>
        <div className="mt-4 rounded-lg bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
          Contacts API keys use least-privilege scopes: <code>contacts:write</code> for imports and{" "}
          <code>events:write</code> for signals.
        </div>
      </Dialog>
    </div>
  );
}

export { Avatar };
