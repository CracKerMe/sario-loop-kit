/**
 * Pure parsing / serialization helpers for contact import & export.
 *
 * No IO and no dependencies — the browser bundle imports this module
 * directly (vite tree-shakes it out of @loopkit/core's server-only
 * surface), and the unit tests run without a database.
 *
 * Design contract shared by every format:
 *  - `email` is the identity column; rows without a valid email fail
 *    individually and are reported in `errors` instead of failing the
 *    whole file (line-level errors, never all-or-nothing).
 *  - Unknown columns / object keys land in `properties` (the same merge
 *    semantics as `upsertContact`).
 *  - Scalar-looking strings ("42", "true", "null") are coerced to their
 *    JSON type, but zero-padded numeric strings ("007") are preserved
 *    verbatim — they are almost always identifiers, not numbers.
 */

export type ContactImportRow = {
  email: string;
  userId?: string;
  properties?: Record<string, unknown>;
  subscribed?: boolean;
};

export type ContactParseError = {
  /** 1-based source line (CSV) or item index (JSON). */
  line: number;
  message: string;
  raw?: string;
};

export type ContactParseResult = {
  rows: ContactImportRow[];
  errors: ContactParseError[];
};

/** Pragmatic email shape: something@something.tld, no spaces. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim());
}

/**
 * Scalar-string coercion: "42" → 42, "1.5" → 1.5, "true" → true,
 * "null" → null — but "007" stays "007" (String(Number("007")) !== "007"),
 * "1e5" stays "1e5" (no dot, String(Number()) rewrites it), because
 * zero-padded / scientific-looking cells are far more likely identifiers
 * than numbers. Everything unparseable stays a string.
 */
export function coerceScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value) && String(Number(value)) === value) {
    return Number(value);
  }
  return raw;
}

/**
 * RFC 4180 CSV parser: comma-delimited, double-quoted fields with `""`
 * escapes, CR/LF/CRLF record separators. Tolerates an unterminated quote
 * by consuming to end-of-input rather than throwing — real spreadsheets
 * occasionally ship truncated files and a partial row still beats a
 * hard failure for a 10k-row import.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;

  const endField = () => {
    row.push(fieldWasQuoted ? field : field.trim());
    field = "";
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      fieldWasQuoted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  // Drop trailing fully-empty rows (blank lines), keep interior ones as "" cells.
  return rows.filter((r, idx) => !(idx === rows.length - 1 && r.every((c) => c === "")));
}

const EMAIL_HEADERS = new Set(["email", "e-mail", "mail", "email_address", "emailaddress"]);
const USER_ID_HEADERS = new Set(["user_id", "userid", "external_id", "externalid", "id"]);
const SUBSCRIBED_HEADERS = new Set(["subscribed", "subscribe", "opted_in", "optin"]);

function parseSubscribedCell(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;
  return undefined;
}

/**
 * Converts CSV text (with a header row) into contact rows. Column
 * detection is case/space-insensitive on a small alias list; every other
 * column becomes a property. Cells are scalar-coerced (see coerceScalar).
 */
export function contactsFromCsv(text: string): ContactParseResult {
  const result: ContactParseResult = { rows: [], errors: [] };
  const table = parseCsv(text);
  if (table.length === 0) {
    result.errors.push({ line: 0, message: "File is empty." });
    return result;
  }

  const headers = table[0]!.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
  const emailIdx = headers.findIndex((h) => EMAIL_HEADERS.has(h));
  if (emailIdx === -1) {
    result.errors.push({
      line: 1,
      message: `Missing an "email" column. Found: ${headers.join(", ") || "(none)"}.`,
    });
    return result;
  }
  const userIdIdx = headers.findIndex((h) => USER_ID_HEADERS.has(h));
  const subscribedIdx = headers.findIndex((h) => SUBSCRIBED_HEADERS.has(h));
  const propertyCols = headers
    .map((h, idx) => ({ header: h, idx }))
    .filter(({ idx }) => idx !== emailIdx && idx !== userIdIdx && idx !== subscribedIdx);

  for (let i = 1; i < table.length; i++) {
    const cells = table[i]!;
    const lineNo = i + 1;
    if (cells.every((c) => c.trim() === "")) continue; // blank line

    const email = (cells[emailIdx] ?? "").trim();
    if (!email) {
      result.errors.push({ line: lineNo, message: "Missing email value.", raw: cells.join(",") });
      continue;
    }
    if (!isValidEmail(email)) {
      result.errors.push({
        line: lineNo,
        message: `Invalid email "${email}".`,
        raw: cells.join(","),
      });
      continue;
    }

    const row: ContactImportRow = { email, properties: {} };
    if (userIdIdx !== -1 && cells[userIdIdx]?.trim()) row.userId = cells[userIdIdx]!.trim();
    if (subscribedIdx !== -1 && cells[subscribedIdx]?.trim()) {
      const parsed = parseSubscribedCell(cells[subscribedIdx]!);
      if (parsed === undefined) {
        result.errors.push({
          line: lineNo,
          message: `Unrecognized subscribed value "${cells[subscribedIdx]!}" (use true/false).`,
          raw: cells.join(","),
        });
        continue;
      }
      row.subscribed = parsed;
    }
    for (const { header, idx } of propertyCols) {
      if (!header) continue;
      const cell = cells[idx] ?? "";
      if (cell.trim() === "") continue;
      row.properties![header] = coerceScalar(cell);
    }
    result.rows.push(row);
  }
  return result;
}

/** Normalizes one JSON array element (string email, or contact object). */
function rowFromJsonValue(value: unknown, line: number, errors: ContactParseError[]) {
  if (typeof value === "string") {
    const email = value.trim();
    if (!isValidEmail(email)) {
      errors.push({ line, message: `Invalid email "${email}".`, raw: value });
      return null;
    }
    return { email, properties: {} } satisfies ContactImportRow;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push({
      line,
      message: "Expected an object or an email string.",
      raw: JSON.stringify(value),
    });
    return null;
  }

  const obj = value as Record<string, unknown>;
  const rawEmail = obj.email ?? obj.Email ?? obj.EMAIL;
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
  if (!email) {
    errors.push({ line, message: "Missing email field.", raw: JSON.stringify(value) });
    return null;
  }
  if (!isValidEmail(email)) {
    errors.push({ line, message: `Invalid email "${email}".`, raw: JSON.stringify(value) });
    return null;
  }

  const row: ContactImportRow = { email, properties: {} };
  const rawUserId = obj.userId ?? obj.user_id ?? obj.id;
  if (typeof rawUserId === "string" && rawUserId.trim()) row.userId = rawUserId.trim();

  const rawSubscribed = obj.subscribed ?? obj.Subscribed;
  if (typeof rawSubscribed === "boolean") {
    row.subscribed = rawSubscribed;
  } else if (typeof rawSubscribed === "string" && rawSubscribed.trim()) {
    const parsed = parseSubscribedCell(rawSubscribed);
    if (parsed === undefined) {
      errors.push({
        line,
        message: `Unrecognized subscribed value "${rawSubscribed}" (use true/false).`,
        raw: JSON.stringify(value),
      });
      return null;
    }
    row.subscribed = parsed;
  }

  if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    row.properties = { ...(obj.properties as Record<string, unknown>) };
  }
  for (const [key, val] of Object.entries(obj)) {
    if (
      [
        "email",
        "Email",
        "EMAIL",
        "userId",
        "user_id",
        "id",
        "subscribed",
        "Subscribed",
        "properties",
      ].includes(key)
    )
      continue;
    row.properties![key] = val;
  }
  return row;
}

/**
 * Parses pasted JSON. Accepts a bare array, a `{ contacts: [...] }` /
 * `{ rows: [...] }` wrapper, or a single contact object / email string.
 */
export function contactsFromJson(text: string): ContactParseResult {
  const result: ContactParseResult = { rows: [], errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    result.errors.push({
      line: 0,
      message: `Invalid JSON: ${e instanceof Error ? e.message : "parse error"}.`,
    });
    return result;
  }

  if (!Array.isArray(parsed)) {
    const wrapper = parsed as Record<string, unknown> | null;
    if (wrapper && typeof wrapper === "object" && Array.isArray(wrapper.contacts)) {
      parsed = wrapper.contacts;
    } else if (wrapper && typeof wrapper === "object" && Array.isArray(wrapper.rows)) {
      parsed = wrapper.rows;
    } else {
      parsed = [parsed]; // single object / string
    }
  }

  (parsed as unknown[]).forEach((value, idx) => {
    const row = rowFromJsonValue(value, idx + 1, result.errors);
    if (row) result.rows.push(row);
  });
  return result;
}

/** Escapes one CSV cell per RFC 4180 (quote-wrapping when required). */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export type CsvExportContact = {
  email: string;
  userId?: string | null;
  subscribed?: boolean;
  properties?: Record<string, unknown> | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

function iso(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * Serializes contacts to CSV: fixed identity columns first, then every
 * property key seen across the set (first-seen order). Nested objects /
 * arrays are JSON-encoded into their cell.
 */
export function contactsToCsv(contacts: CsvExportContact[]): string {
  const propertyKeys: string[] = [];
  const seen = new Set<string>();
  for (const c of contacts) {
    for (const key of Object.keys(c.properties ?? {})) {
      if (!seen.has(key)) {
        seen.add(key);
        propertyKeys.push(key);
      }
    }
  }

  const header = ["email", "user_id", "subscribed", "created_at", "updated_at", ...propertyKeys];
  const lines = [header.map(csvCell).join(",")];
  for (const c of contacts) {
    const cells = [
      c.email,
      c.userId ?? "",
      String(c.subscribed ?? true),
      iso(c.createdAt),
      iso(c.updatedAt),
      ...propertyKeys.map((key) => {
        const value = c.properties?.[key];
        if (value === undefined || value === null) return "";
        return typeof value === "object" ? JSON.stringify(value) : String(value);
      }),
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\r\n");
}
