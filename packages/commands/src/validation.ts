import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { SCHEMAS } from "@kiwi/contracts";

export interface FieldProblem {
  path: string;
  rule: string;
  detail: string;
}

export interface Validator {
  compile(schema: object): ValidateFunction;
  validateEnvelope(value: unknown): FieldProblem[];
}

// RFC 9562 textual form, any version. Kiwi issues version 7, but a caller may replay an
// identifier minted by an earlier build, so the version nibble is not constrained here.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Ajv reports the failing keyword and instance path. Only those structural facts are
 * kept. The offending value is never copied into a problem, because argument values can
 * carry research content.
 */
export function toFieldProblems(errors: ErrorObject[] | null | undefined): FieldProblem[] {
  if (!errors) return [];
  return errors.map((error) => ({
    path: error.instancePath === "" ? "/" : error.instancePath,
    rule: error.keyword,
    detail: error.message ?? "is not valid",
  }));
}

export function createValidator(): Validator {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  ajv.addFormat("uuid", UUID_PATTERN);

  const envelope = ajv.compile(SCHEMAS.commandEnvelope);
  const cache = new Map<object, ValidateFunction>();

  return {
    compile(schema) {
      const existing = cache.get(schema);
      if (existing !== undefined) return existing;
      const compiled = ajv.compile(schema);
      cache.set(schema, compiled);
      return compiled;
    },

    validateEnvelope(value) {
      return envelope(value) ? [] : toFieldProblems(envelope.errors);
    },
  };
}

function depthOf(value: unknown, depth = 0): number {
  if (depth > 64) return depth;
  if (Array.isArray(value)) {
    return value.reduce<number>((max, item) => Math.max(max, depthOf(item, depth + 1)), depth);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce<number>(
      (max, item) => Math.max(max, depthOf(item, depth + 1)),
      depth,
    );
  }
  return depth;
}

/** Guards against a payload that is structurally hostile before schema work begins. */
export function exceedsSizeLimits(value: unknown, maxBytes = 256 * 1024, maxDepth = 24): boolean {
  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? "";
  } catch {
    return true;
  }
  if (encoded.length > maxBytes) return true;
  return depthOf(value) > maxDepth;
}
