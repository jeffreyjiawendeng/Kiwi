import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMPTY_REFERENCE } from "@kiwi/contracts";
import { DuplicatesPanel } from "./DuplicatesPanel.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

const HASH = `sha256:${"a".repeat(64)}`;

function record(id: string, title: string, reference: Record<string, unknown>, files = 0) {
  return {
    id,
    title,
    version: 3,
    content_hash: HASH,
    updated_at: "2026-08-20T12:00:00.000Z",
    reference: { ...EMPTY_REFERENCE, ...reference },
    files,
    annotations: 0,
  };
}

/** One group of two records, as the workspace answers it. */
const PAIR = {
  reason: "doi",
  key: "10.1000/xyz123",
  records: [
    record("object-1", "Attention Is All You Need", {
      authors: ["Vaswani et al."],
      year: 2017,
      doi: "10.1000/xyz123",
      container: "NeurIPS",
    }),
    record("object-2", "Attention (preprint)", {
      authors: ["Vaswani et al."],
      year: null,
      doi: "10.1000/xyz123",
      container: "NeurIPS",
    }),
  ],
};

function stub(groups: unknown[], overrides: Record<string, unknown> = {}) {
  return vi.fn(async (envelope: unknown) => {
    const request = envelope as { command: string; args: Record<string, unknown> };
    const override = overrides[request.command];
    if (override !== undefined) return override;
    if (request.command === "kiwi.object.validate-trash")
      return {
        protocol_version: "1.0.0",
        request_id: "validate",
        status: "no_change",
        data: {
          preview: {
            impact: { relation_count: 2, related_object_count: 1 },
            relation_guards: [{ relation_id: "relation-1", version: 1, content_hash: HASH }],
          },
        },
      };
    if (request.command === "kiwi.object.trash")
      return {
        protocol_version: "1.0.0",
        request_id: "trash",
        status: "committed",
        data: {},
      };
    return {
      protocol_version: "1.0.0",
      request_id: "candidates",
      status: "no_change",
      data: { groups },
    };
  });
}

function panel(invokeCommand: ReturnType<typeof stub>, props: Record<string, unknown> = {}) {
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  render(<DuplicatesPanel workspaceId="workspace-1" writable {...props} />);
}

describe("reviewing duplicate Papers", () => {
  it("shows the two records side by side and marks what they disagree on", async () => {
    panel(stub([PAIR]));

    expect(await screen.findByText("2 records with the DOI 10.1000/xyz123")).toBeInTheDocument();
    expect(screen.getByText("Attention Is All You Need")).toBeInTheDocument();
    expect(screen.getByText("Attention (preprint)")).toBeInTheDocument();

    // The year is the field these two disagree on, and it is the reason somebody might decide
    // they are not duplicates at all.
    const year = screen.getByRole("rowheader", { name: /Year/u });
    expect(year.closest("tr")).toHaveClass("duplicates__row--differs");
    // What both records agree on is shown and left unmarked, because a table where everything
    // looks marked says nothing.
    const container = screen.getByRole("rowheader", { name: /Published in/u });
    expect(container.closest("tr")).not.toHaveClass("duplicates__row--differs");
  });

  it("says what is attached to each record before anything is thrown away", async () => {
    const withFiles = {
      ...PAIR,
      records: [{ ...PAIR.records[0]!, files: 2, annotations: 7 }, PAIR.records[1]!],
    };
    panel(stub([withFiles]));

    // Kiwi does not merge, so the annotations on the record somebody trashes are gone from the
    // Library with it. Having to open both records to learn that is how the wrong one goes.
    expect(await screen.findByText(/2 files, 7 annotations/u)).toBeInTheDocument();
    expect(screen.getByText(/0 files, 0 annotations/u)).toBeInTheDocument();
  });

  it("says on the screen that merging is not on offer", async () => {
    panel(stub([PAIR]));

    expect(await screen.findByText(/Kiwi does not merge records/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Merge/u })).not.toBeInTheDocument();
  });

  it("reads what Trash would take before it takes it", async () => {
    const invokeCommand = stub([PAIR]);
    panel(invokeCommand);

    await userEvent.click(
      await screen.findByRole("button", { name: "Move Attention (preprint) to Trash" }),
    );

    expect(
      await screen.findByText(/2 relations and 1 related object go with it/u),
    ).toBeInTheDocument();
    // Nothing has moved yet. The preview is the whole point of the first click.
    expect(
      invokeCommand.mock.calls.every(
        ([envelope]) => (envelope as { command: string }).command !== "kiwi.object.trash",
      ),
    ).toBe(true);
  });

  it("moves the chosen record to Trash, quoting the version it was shown", async () => {
    const invokeCommand = stub([PAIR]);
    const onChanged = vi.fn();
    panel(invokeCommand, { onChanged });

    await userEvent.click(
      await screen.findByRole("button", { name: "Move Attention (preprint) to Trash" }),
    );
    // The confirming button is the one named only "Move to Trash"; the two beside the records
    // name the record they would move.
    await userEvent.click(screen.getByRole("button", { name: "Move to Trash" }));

    expect(
      await screen.findByText(/Moved Attention \(preprint\) to workspace Trash/u),
    ).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    const trashed = invokeCommand.mock.calls
      .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
      .find((request) => request.command === "kiwi.object.trash");
    expect(trashed?.args).toEqual({
      object_id: "object-2",
      expected_version: 3,
      expected_hash: HASH,
      expected_relations: [{ relation_id: "relation-1", version: 1, content_hash: HASH }],
    });
  });

  it("offers nothing to trash in a workspace opened read-only", async () => {
    panel(stub([PAIR]), { writable: false });

    expect(await screen.findByText("Attention Is All You Need")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move .* to Trash/u })).not.toBeInTheDocument();
  });

  it("says plainly when the library has no repeats", async () => {
    panel(stub([]));

    expect(
      await screen.findByText(/Nothing here looks like the same work twice/u),
    ).toBeInTheDocument();
  });

  it("reports a workspace that will not answer", async () => {
    panel(
      stub([], {
        "kiwi.object.duplicate-candidates": {
          protocol_version: "1.0.0",
          request_id: "candidates",
          status: "failed",
          error: { code: "KIWI_INTERNAL", message: "Kiwi could not read the Library." },
        },
      }),
    );

    // Unlike the DOI check beside a field, this screen is the whole reason somebody is here.
    // Silence would look like a library with no duplicates in it.
    expect(await screen.findByRole("alert")).toHaveTextContent("Kiwi could not read the Library.");
  });
});
