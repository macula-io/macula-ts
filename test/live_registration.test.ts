import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// serve() and subscribe() return before the station has registered anything: ADVERTISE and SUBSCRIBE
// are never acknowledged. A live test that calls or publishes right after them races the station and
// fails only when the station is slow. So live tests reach serve() and subscribe() only through
// test/live_registration.ts, whose helpers wait for the station, or say why nothing needs to wait.
// This test finds a direct .serve( or .subscribe( call in a live test file, so a forgotten wait fails
// in the offline suite instead of in a live run.

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const DIRECT_REGISTRATION = /\.(serve|subscribe)\s*\(/;

// The source with every comment and every string, template or character literal's contents replaced
// by spaces, newlines kept, so line numbers still match and a mention in a comment or a test name isn't
// taken for a call. A template's ${...} counts as part of the literal.
function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") out += blank(source.charAt(i++));
    } else if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) out += blank(source.charAt(i++));
      out += "  ";
      i += 2;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") out += blank(source.charAt(i++));
        if (i < source.length) out += blank(source.charAt(i++));
      }
      if (i < source.length) out += source[i++];
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function directRegistrationLines(source: string): number[] {
  return codeOnly(source)
    .split("\n")
    .flatMap((line, index) => (DIRECT_REGISTRATION.test(line) ? [index + 1] : []));
}

describe("live tests reach serve() and subscribe() only through test/live_registration.ts", () => {
  it("no src/*.live.test.ts calls .serve( or .subscribe( directly", () => {
    const found = readdirSync(SRC_DIR)
      .filter((file) => file.endsWith(".live.test.ts"))
      .sort()
      .flatMap((file) => directRegistrationLines(readFileSync(join(SRC_DIR, file), "utf8")).map((line) => `src/${file}:${line}`));
    expect(found).toEqual([]);
  });

  it("finds a direct call in code, and not a mention in a comment, a string or a test name", () => {
    const sample = [
      "// provider.serve(procedure, handler) in a line comment",
      "/* session.subscribe(topic, handler)",
      "   in a block comment */",
      'it("session.serve() in a test name", async () => {',
      "  const note = `session.subscribe(${topic})`;",
      '  const url = "https://example.invalid//path"; stopServing = await provider.serve(procedure, handler);',
      "  await pool.subscribe(undefined, topic, handler);",
      "});",
    ].join("\n");
    expect(directRegistrationLines(sample)).toEqual([6, 7]);
  });
});
