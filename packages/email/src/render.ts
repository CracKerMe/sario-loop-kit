/**
 * Strict `{{var}}` template renderer for email bodies. Deliberately NOT
 * the engine's own {{}} + ${} interpolation (NotificationManager.
 * renderTemplate) — that evaluates `${...}` through the sandbox on every
 * render, which is both slow for a 20-40KB marketing HTML body and a
 * footgun (any literal `${` in the template's CSS or a customer's pasted
 * copy becomes code). This renderer does dotted-path substitution only,
 * no eval, HTML-escapes by default.
 */

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]!);
}

function getPath(data: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function toDisplayString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Renders `{{path.to.value}}` (HTML-escaped) and `{{{path.to.value}}}`
 * (raw, unescaped — for template-authored HTML fragments) against `data`.
 * An unresolved path is left as-is (matches the engine's own
 * renderTemplate behavior for {{}} substitution) rather than throwing, so
 * a typo in a template doesn't take down a send — it just renders visibly
 * wrong, which shows up immediately in a preview.
 */
export function renderTemplate(template: string, data: Record<string, unknown>): string {
  // Triple-brace (raw) first — its inner group would otherwise be matched
  // by the double-brace pattern one brace short.
  const withRaw = template.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (match, path: string) => {
    const value = getPath(data, path);
    return value === undefined ? match : toDisplayString(value);
  });

  return withRaw.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path: string) => {
    const value = getPath(data, path);
    return value === undefined ? match : escapeHtml(toDisplayString(value));
  });
}
