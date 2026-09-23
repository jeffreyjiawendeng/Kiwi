import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMAS, SCHEMA_FILES } from "./schemas.js";

const schemaDir = join(import.meta.dirname, "..", "schemas");

describe("schema documents", () => {
  it.each(Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[])(
    "%s matches its JSON document on disk",
    (name) => {
      const onDisk: unknown = JSON.parse(readFileSync(join(schemaDir, SCHEMA_FILES[name]), "utf8"));
      expect(SCHEMAS[name]).toEqual(onDisk);
    },
  );

  it("declares draft 2020-12 for every document", () => {
    for (const schema of Object.values(SCHEMAS)) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });

  it("gives every document a stable identifier", () => {
    const ids = Object.values(SCHEMAS).map((schema) => schema.$id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^https:\/\/kiwi\.dev\/schemas\//);
  });
});
