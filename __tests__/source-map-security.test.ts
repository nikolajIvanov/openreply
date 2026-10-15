import { readFileSync } from "node:fs";
import { SourceMapConsumer, SourceNode, type RawSourceMap } from "source-map-js";
import { describe, expect, it } from "vitest";

const basicMap = {
  version: 3,
  sources: ["example.ts"],
  sourcesContent: ["output"],
  names: [],
  mappings: "AAAA",
};

function indexedMap(line: number, column = 0, map: unknown = basicMap) {
  return { version: 3, sections: [{ offset: { line, column }, map }] };
}

function consume(map: unknown) {
  // The dependency's declarations omit indexed maps, which its runtime supports.
  return new SourceMapConsumer(map as RawSourceMap);
}

describe("source-map-js security regression (CVE-2026-93749)", () => {
  it("pins every installed lockfile entry to the patched version", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    expect(manifest.overrides["source-map-js"]).toBe("1.2.2");
    const entries = Object.entries(lock.packages).filter(([name]) => name.endsWith("node_modules/source-map-js"));
    expect(entries.length).toBeGreaterThan(0);
    for (const [, entry] of entries) expect(entry).toMatchObject({ version: "1.2.2" });
  });

  it("preserves normal indexed mappings when flattened", () => {
    const consumer = consume(indexedMap(2, 0));
    const flattened = SourceNode.fromStringWithSourceMap("\n\noutput", consumer)
      .toStringWithSourceMap({ file: "output.js" }).map.toJSON();
    expect(consume(flattened).originalPositionFor({ line: 3, column: 0 }))
      .toMatchObject({ source: "example.ts", line: 1, column: 0 });
  });

  // Reject at construction; never flatten adversarial maps or allocate huge strings.
  it("rejects oversized line offsets before flattening", () => {
    expect(() => consume(indexedMap(10_000_001))).toThrow(/must not exceed/);
  });

  it("rejects nested offsets whose total exceeds the limit", () => {
    expect(() => consume(indexedMap(6_000_000, 0, indexedMap(6_000_000))))
      .toThrow(/including offsets of nested sections/);
  });

  it.each([-1, 0.5, NaN, Infinity])("rejects invalid line offset %s", (line) => {
    expect(() => consume(indexedMap(line))).toThrow(/non-negative integers/);
  });

  it.each([-1, 0.5, NaN, Infinity])("rejects invalid column offset %s", (column) => {
    expect(() => consume(indexedMap(0, column))).toThrow(/non-negative integers/);
  });
});
