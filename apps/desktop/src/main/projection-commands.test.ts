import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_COLLECTION_FILTERS, EMPTY_REFERENCE } from "@kiwi/contracts";
import { createObject, createWorkspace } from "@kiwi/workspace";
import { createProjectionService } from "./projection.js";
import { projectionCommands } from "./projection-commands.js";
import { createGateway, createRegistry } from "@kiwi/commands";

const WORKSPACE_ID = "0198c7c1-4e7d-7e31-a23a-824269ac23d0";
let scratch: string;
let root: string;
let sequence = 0;

function id(): string {
  sequence += 1;
  return `0198cb00-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}

/**
 * The gateway rather than the service behind it.
 *
 * What is being checked here is the schema an envelope has to get past, which is the part the
 * renderer meets and the part the service never sees.
 */
function gateway() {
  const projection = createProjectionService(join(scratch, "machine-state", "workspaces"));
  const registry = createRegistry();
  for (const definition of projectionCommands(projection)) registry.register(definition);
  const { invoke } = createGateway({ registry, newCorrelationId: () => crypto.randomUUID() });
  return {
    projection,
    async run(command: string, args: Record<string, unknown>) {
      const requestId = crypto.randomUUID();
      return invoke(
        {
          protocol_version: "1.0.0",
          request_id: requestId,
          idempotency_key: requestId,
          workspace_id: WORKSPACE_ID,
          command,
          args: { ...args, root },
        },
        {
          actor: { kind: "local_user", id: "actor:local/default" },
          origin: { surface: "ui", extension_id: null },
        },
      );
    },
  };
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kiwi-projcmd-"));
  root = join(scratch, "canonical-workspace");
  sequence = 0;
  await createWorkspace({
    root,
    workspaceId: WORKSPACE_ID,
    title: "Projection command fixture",
    now: "2026-08-26T09:00:00.000Z",
  });
});

afterEach(async () => {
  // Retried, because Windows keeps a database file busy for a moment after it is closed.
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function paper(title: string): Promise<string> {
  const objectId = id();
  await createObject({
    root,
    workspaceId: WORKSPACE_ID,
    objectId,
    type: "source",
    title,
    content: "",
    actor: "account:test",
    requestId: id(),
    now: "2026-08-26T09:05:00.000Z",
    additionalFields: { reference: { ...EMPTY_REFERENCE, year: 2017 }, tags: [] },
    transactionId: id(),
    preparedEventId: id(),
    domainEventId: id(),
    committedEventId: id(),
  });
  return objectId;
}

describe("projection commands", () => {
  it("accepts every filter group the Library sends, including the empty ones", async () => {
    await paper("Attention Is All You Need");
    const { projection, run } = gateway();

    // The interface sends the whole set on every list, so a group missing from the schema is not
    // a filter that fails to narrow: it is a Library that never loads.
    const result = await run("kiwi.projection.list", {
      object_types: ["source"],
      text: "",
      filters: { ...EMPTY_COLLECTION_FILTERS, read: ["unread"] },
      sort: { field: "title", direction: "ascending" },
      page: { offset: 0, limit: 50 },
    });

    expect(result.error).toBeUndefined();
    expect((result.data?.["objects"] as Array<{ title: string }>).map((row) => row.title)).toEqual([
      "Attention Is All You Need",
    ]);
    projection.close(WORKSPACE_ID);
  });

  it("records an opening and orders the Library by it", async () => {
    const first = await paper("Opened");
    await paper("Never opened");
    const { projection, run } = gateway();

    const marked = await run("kiwi.projection.mark-opened", { object_id: first });
    expect(marked.status).toBe("committed");
    expect(marked.data?.["opened"]).toMatchObject({ object_id: first });

    const listed = await run("kiwi.projection.list", {
      object_types: ["source"],
      sort: { field: "last_opened", direction: "descending" },
    });
    const rows = listed.data?.["objects"] as Array<{
      title: string;
      last_opened_at: string | null;
    }>;
    expect(rows.map((row) => row.title)).toEqual(["Opened", "Never opened"]);
    expect(rows[0]?.last_opened_at).not.toBeNull();
    expect(rows[1]?.last_opened_at).toBeNull();
    projection.close(WORKSPACE_ID);
  });

  it("refuses an opening it was given no item for", async () => {
    const { projection, run } = gateway();

    const result = await run("kiwi.projection.mark-opened", { object_id: "" });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("KIWI_INVALID_ARGUMENTS");
    projection.close(WORKSPACE_ID);
  });
});
