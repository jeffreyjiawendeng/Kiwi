import { describe, expect, it } from "vitest";
import { exceedsSizeLimits } from "@kiwi/commands";
import { BATCH_BUDGET, planImportBatches, type ReviewedRow } from "./import-batches.js";

function row(index: number, abstract = ""): ReviewedRow {
  return {
    key: `row-${String(index)}`,
    title: `Paper ${String(index)}`,
    reference: { type: "article", title: `Paper ${String(index)}`, year: 2024, abstract },
    file_hash: null,
  };
}

/**
 * The request as it will actually be measured: what the renderer sends, plus the two fields the
 * main process puts on it afterwards, at the longest either of them may be.
 */
function asSent(entries: readonly ReviewedRow[]): unknown {
  return {
    protocol_version: "1.0.0",
    request_id: "00000000-0000-4000-8000-000000000000",
    workspace_id: "w".repeat(150),
    command: "kiwi.bibliography.import",
    args: { entries, root: "C:\\".concat("\\".repeat(237)) },
  };
}

describe("cutting a reviewed import into requests", () => {
  it("sends a small import as one request", () => {
    const plan = planImportBatches([row(1), row(2), row(3)]);

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]?.entries).toHaveLength(3);
    expect(plan.batches[0]).toMatchObject({ first: 1, last: 3 });
  });

  it("makes every part one the gateway would accept, once main has filled in the rest", () => {
    // The point of the whole module, checked against the guard that would refuse the request
    // rather than against this module's own arithmetic. The root here is the longest the
    // command's schema allows and every character of it a backslash, which JSON doubles: the
    // worst the renderer could be surprised by after it stopped counting.
    const plan = planImportBatches(
      Array.from({ length: 400 }, (_, index) => row(index, "x".repeat(3_000))),
    );

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.batches.length).toBeGreaterThan(1);
    for (const batch of plan.batches) expect(exceedsSizeLimits(asSent(batch.entries))).toBe(false);
  });

  it("keeps every row, in the order they were reviewed", () => {
    const rows = Array.from({ length: 300 }, (_, index) => row(index, "y".repeat(4_000)));

    const plan = planImportBatches(rows);

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.batches.flatMap((batch) => batch.entries)).toEqual(rows);
  });

  it("says where in the selection each part came from", () => {
    // So a part that fails names the rows it was carrying. "Rows 201 to 400 were not added" is
    // something a person can act on; "one of the requests failed" is not.
    const plan = planImportBatches(
      Array.from({ length: 300 }, (_, index) => row(index, "z".repeat(4_000))),
    );

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    let expected = 1;
    for (const batch of plan.batches) {
      expect(batch.first).toBe(expected);
      expect(batch.last).toBe(expected + batch.entries.length - 1);
      expected = batch.last + 1;
    }
    expect(expected - 1).toBe(300);
  });

  it("fills each part before starting the next", () => {
    const plan = planImportBatches(
      Array.from({ length: 200 }, (_, index) => row(index, "q".repeat(5_000))),
    );

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    // Every part but the last is full enough that the row which started the next one would not
    // have fitted in it. Otherwise the import is being sent in more pieces than it needs.
    for (const [index, batch] of plan.batches.entries()) {
      if (index === plan.batches.length - 1) break;
      const next = plan.batches[index + 1]?.entries[0];
      const used = JSON.stringify(batch.entries).length;
      expect(used + JSON.stringify(next).length + 1).toBeGreaterThan(BATCH_BUDGET);
    }
  });

  it("names the one row that cannot be sent at all", () => {
    // A record carrying an entire paper in its abstract. No cutting helps, so the person is
    // told which row it is rather than left with an import that quietly counted wrong.
    const rows = [row(1), row(2, "b".repeat(BATCH_BUDGET + 1)), row(3)];

    expect(planImportBatches(rows)).toEqual({
      status: "row_too_large",
      index: 1,
      title: "Paper 2",
    });
  });

  it("plans nothing for a selection with nothing in it", () => {
    expect(planImportBatches([])).toEqual({ status: "planned", batches: [] });
  });

  it("keeps every part under the row limit the command's schema sets", () => {
    // The limit that almost never binds, and is worth holding to anyway. Even the smallest row
    // that carries all four of its fields costs more than the budget divided by the row limit,
    // so size runs out first for anything a person could really send -- but a part over the
    // count would be refused whole, and no part is ever allowed to be.
    const plan = planImportBatches(
      Array.from({ length: 6_000 }, () => ({
        key: "k",
        title: "a",
        reference: {},
        file_hash: null,
      })),
    );

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.batches.every((batch) => batch.entries.length <= 5_000)).toBe(true);
    // Cut into parts, not cut down: every row that went in comes out in one of them.
    expect(plan.batches.reduce((total, batch) => total + batch.entries.length, 0)).toBe(6_000);
  });
});
