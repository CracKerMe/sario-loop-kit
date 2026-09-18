import { describe, expect, it } from "vitest";

import {
  coerceScalar,
  contactsFromCsv,
  contactsFromJson,
  contactsToCsv,
  isValidEmail,
  parseCsv,
} from "../contactsImport";

describe("parseCsv", () => {
  it("parses plain rows", () => {
    expect(parseCsv("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles LF-only line endings and a trailing newline", () => {
    expect(parseCsv("a,b\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("honors quoted fields with commas, escaped quotes and newlines", () => {
    expect(parseCsv('"x,1","say ""hi""","line\nbreak"')).toEqual([
      ["x,1", 'say "hi"', "line\nbreak"],
    ]);
  });

  it("keeps interior empty cells and drops trailing blank lines", () => {
    expect(parseCsv("a,,c\n\n")).toEqual([["a", "", "c"]]);
  });

  it("tolerates an unterminated quoted field instead of throwing", () => {
    expect(parseCsv('a,"unclosed')).toEqual([["a", "unclosed"]]);
  });
});

describe("coerceScalar", () => {
  it("converts plain numbers, booleans and null", () => {
    expect(coerceScalar("42")).toBe(42);
    expect(coerceScalar(" 1.5 ")).toBe(1.5);
    expect(coerceScalar("true")).toBe(true);
    expect(coerceScalar("null")).toBeNull();
  });

  it("keeps zero-padded and scientific-looking strings verbatim", () => {
    expect(coerceScalar("007")).toBe("007");
    expect(coerceScalar("1e5")).toBe("1e5");
    expect(coerceScalar("+8613800000000")).toBe("+8613800000000");
  });

  it("keeps arbitrary text untouched", () => {
    expect(coerceScalar("hello world")).toBe("hello world");
  });
});

describe("isValidEmail", () => {
  it("accepts normal addresses and rejects junk", () => {
    expect(isValidEmail("a.b+c@sub.example.co")).toBe(true);
    expect(isValidEmail("no-tld@host")).toBe(false);
    expect(isValidEmail("spaces in@mail.com")).toBe(false);
    expect(isValidEmail("@missing-local.com")).toBe(false);
  });
});

describe("contactsFromCsv", () => {
  it("maps the email column and folds other columns into properties", () => {
    const res = contactsFromCsv("Email,Name,Age\r\nsam@example.com,Sam,30");
    expect(res.errors).toEqual([]);
    expect(res.rows).toEqual([{ email: "sam@example.com", properties: { name: "Sam", age: 30 } }]);
  });

  it("recognizes user_id and subscribed alias columns", () => {
    const res = contactsFromCsv("email,user_id,Subscribed\r\na@b.co,u-1,false");
    expect(res.rows).toEqual([
      { email: "a@b.co", userId: "u-1", subscribed: false, properties: {} },
    ]);
  });

  it("fails the whole file when there is no email column", () => {
    const res = contactsFromCsv("name\r\nSam");
    expect(res.rows).toEqual([]);
    expect(res.errors[0]!.message).toContain('Missing an "email" column');
  });

  it("reports invalid rows line-by-line without dropping valid ones", () => {
    const res = contactsFromCsv("email\r\nok@x.co\r\nbroken-at\r\n\r\nalso-ok@x.co");
    expect(res.rows.map((r) => r.email)).toEqual(["ok@x.co", "also-ok@x.co"]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.line).toBe(3);
  });

  it("rejects unrecognized subscribed values", () => {
    const res = contactsFromCsv("email,subscribed\r\na@b.co,maybe");
    expect(res.rows).toEqual([]);
    expect(res.errors[0]!.message).toContain("Unrecognized subscribed");
  });

  it("unquotes CSV-escaped property values", () => {
    const res = contactsFromCsv('email,note\r\na@b.co,"has, comma and ""quotes"""');
    expect(res.rows[0]!.properties).toEqual({ note: 'has, comma and "quotes"' });
  });
});

describe("contactsFromJson", () => {
  it("accepts a bare array of objects and folds extra keys into properties", () => {
    const res = contactsFromJson('[{"email":"a@b.co","plan":"pro","n":2}]');
    expect(res.errors).toEqual([]);
    expect(res.rows).toEqual([{ email: "a@b.co", properties: { plan: "pro", n: 2 } }]);
  });

  it("unwraps { contacts: [...] } and accepts bare email strings", () => {
    const res = contactsFromJson('{"contacts":["a@b.co","c@d.co"]}');
    expect(res.rows.map((r) => r.email)).toEqual(["a@b.co", "c@d.co"]);
  });

  it("honors explicit properties, userId and subscribed", () => {
    const res = contactsFromJson(
      '[{"email":"a@b.co","user_id":"u1","subscribed":false,"properties":{"k":1},"extra":"x"}]',
    );
    expect(res.rows).toEqual([
      {
        email: "a@b.co",
        userId: "u1",
        subscribed: false,
        properties: { k: 1, extra: "x" },
      },
    ]);
  });

  it("supports a single object and single email string", () => {
    expect(contactsFromJson('{"email":"a@b.co"}').rows).toEqual([
      { email: "a@b.co", properties: {} },
    ]);
    expect(contactsFromJson('"a@b.co"').rows).toEqual([{ email: "a@b.co", properties: {} }]);
  });

  it("collects per-item errors and reports invalid JSON syntax", () => {
    const res = contactsFromJson('[{"email":"a@b.co"},{"nope":1},"bad-email"]');
    expect(res.rows).toHaveLength(1);
    expect(res.errors).toHaveLength(2);
    expect(contactsFromJson("{oops").errors[0]!.message).toContain("Invalid JSON");
  });
});

describe("contactsToCsv", () => {
  it("emits fixed columns first, then the union of property keys", () => {
    const csv = contactsToCsv([
      {
        email: "a@b.co",
        userId: "u1",
        subscribed: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-02T00:00:00Z"),
        properties: { plan: "pro", age: 30 },
      },
      { email: "c@d.co", subscribed: false, properties: { plan: "free", note: "x,y" } },
    ]);
    const rows = csv.split("\r\n");
    expect(rows[0]).toBe("email,user_id,subscribed,created_at,updated_at,plan,age,note");
    expect(rows[1]).toBe(
      "a@b.co,u1,true,2026-01-01T00:00:00.000Z,2026-01-02T00:00:00.000Z,pro,30,",
    );
    expect(rows[2]).toBe('c@d.co,,false,,,free,,"x,y"');
  });

  it("JSON-encodes nested property values and skips nulls", () => {
    const csv = contactsToCsv([{ email: "a@b.co", properties: { tags: ["a", "b"], empty: null } }]);
    // The JSON cell contains commas and quotes, so it must be RFC 4180 escaped.
    expect(csv.split("\r\n")[1]).toBe('a@b.co,,true,,,"[""a"",""b""]",');
  });

  it("round-trips through parseCsv for quoted content", () => {
    const csv = contactsToCsv([{ email: "a@b.co", properties: { note: 'He said "hi", twice' } }]);
    const table = parseCsv(csv);
    expect(table[1]).toEqual(["a@b.co", "", "true", "", "", 'He said "hi", twice']);
  });
});
