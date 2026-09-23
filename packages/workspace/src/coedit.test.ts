import { describe, expect, it } from "vitest";
import {
  checkpointCoeditDocument,
  currentCoeditPresence,
  materializeCoeditMarkdown,
  mergeCoeditOperations,
  type CoeditOperation,
} from "./coedit.js";

const DOCUMENT = "0198c7c4-5d43-71b7-a135-42494e1e51d3";
const base: CoeditOperation = {
  document_id: DOCUMENT,
  operation_id: "0198c800-0000-7000-8000-000000000001",
  actor_id: "account:a",
  lamport: 1,
  kind: "insert",
  after_id: null,
  text: "Finding",
};
const anchor = `${base.operation_id}:000006`;
const a: CoeditOperation = {
  document_id: DOCUMENT,
  operation_id: "0198c800-0000-7000-8000-000000000002",
  actor_id: "account:a",
  lamport: 2,
  kind: "insert",
  after_id: anchor,
  text: " A",
};
const b: CoeditOperation = {
  document_id: DOCUMENT,
  operation_id: "0198c800-0000-7000-8000-000000000003",
  actor_id: "account:b",
  lamport: 2,
  kind: "insert",
  after_id: anchor,
  text: " B",
};

describe("convergent note operations", () => {
  it("converges after offline, reordered, and duplicate delivery", () => {
    const replicaA = mergeCoeditOperations(DOCUMENT, [base, a], [b, base]);
    const replicaB = mergeCoeditOperations(DOCUMENT, [b, b], [a, base]);
    expect(replicaA).toEqual(replicaB);
    expect(materializeCoeditMarkdown(replicaA)).toBe("Finding A B");
    expect(checkpointCoeditDocument(replicaA)).toMatchObject({
      content: "Finding A B",
      operation_count: 3,
      actor_clock: { "account:a": 2, "account:b": 2 },
    });
    expect(checkpointCoeditDocument(replicaA).content_hash).toBe(
      checkpointCoeditDocument(replicaB).content_hash,
    );
  });

  it("applies deletion before or after its target arrives", () => {
    const deletion: CoeditOperation = {
      document_id: DOCUMENT,
      operation_id: "0198c800-0000-7000-8000-000000000004",
      actor_id: "account:b",
      lamport: 3,
      kind: "delete",
      target_ids: [`${b.operation_id}:000000`, `${b.operation_id}:000001`],
    };
    expect(
      materializeCoeditMarkdown(mergeCoeditOperations(DOCUMENT, [deletion], [b, a, base])),
    ).toBe("Finding A");
  });

  it("keeps only current ephemeral presence", () => {
    expect(
      currentCoeditPresence(DOCUMENT, "2026-08-22T12:00:00.000Z", [
        {
          document_id: DOCUMENT,
          actor_id: "account:a",
          sequence: 1,
          cursor: 2,
          updated_at: "2026-08-22T11:59:00.000Z",
          expires_at: "2026-08-22T12:01:00.000Z",
        },
        {
          document_id: DOCUMENT,
          actor_id: "account:a",
          sequence: 2,
          cursor: 5,
          updated_at: "2026-08-22T11:59:30.000Z",
          expires_at: "2026-08-22T12:01:30.000Z",
        },
      ]),
    ).toMatchObject([{ actor_id: "account:a", cursor: 5 }]);
  });
});
