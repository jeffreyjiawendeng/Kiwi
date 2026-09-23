import { afterEach, describe, expect, it, vi } from "vitest";
import {
  draftAnnotation,
  listClaimChoices,
  mergeRects,
  pageElementFor,
  sendEvidenceToClaim,
} from "./annotations.js";
import type { RendererBridge } from "./bridge.js";

describe("mergeRects", () => {
  it("joins the runs of one line into a single band", () => {
    // A selection across styled text arrives as one rectangle per run. Left alone, a
    // highlight over "the *word* here" renders as three stripes with gaps.
    const merged = mergeRects([
      { left: 0.1, top: 0.2, width: 0.1, height: 0.02 },
      { left: 0.2, top: 0.2, width: 0.1, height: 0.02 },
      { left: 0.3, top: 0.2005, width: 0.1, height: 0.02 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.left).toBeCloseTo(0.1);
    expect(merged[0]?.top).toBeCloseTo(0.2);
    // Fractions are arithmetic on floats, so the band's width is compared approximately.
    expect(merged[0]?.width).toBeCloseTo(0.3);
  });

  it("keeps separate lines separate", () => {
    const merged = mergeRects([
      { left: 0.1, top: 0.2, width: 0.4, height: 0.02 },
      { left: 0.1, top: 0.24, width: 0.3, height: 0.02 },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("keeps a gap on the same line, such as a column break", () => {
    const merged = mergeRects([
      { left: 0.05, top: 0.3, width: 0.35, height: 0.02 },
      { left: 0.55, top: 0.3, width: 0.35, height: 0.02 },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("orders top to bottom then left to right", () => {
    const merged = mergeRects([
      { left: 0.1, top: 0.5, width: 0.1, height: 0.02 },
      { left: 0.1, top: 0.1, width: 0.1, height: 0.02 },
    ]);
    expect(merged.map((rect) => rect.top)).toEqual([0.1, 0.5]);
  });

  it("returns nothing for nothing", () => {
    expect(mergeRects([])).toEqual([]);
  });

  it("takes the tallest height when runs of one line differ", () => {
    // A line with a superscript is taller in one run than the next; the band has to cover it.
    const merged = mergeRects([
      { left: 0.1, top: 0.2, width: 0.1, height: 0.02 },
      { left: 0.2, top: 0.2, width: 0.1, height: 0.03 },
    ]);
    expect(merged[0]?.height).toBe(0.03);
  });
});

describe("pageElementFor", () => {
  it("finds the page a node sits inside", () => {
    const page = window.document.createElement("div");
    page.dataset["page"] = "3";
    const span = window.document.createElement("span");
    page.append(span);
    const text = window.document.createTextNode("passage");
    span.append(text);

    expect(pageElementFor(text)).toBe(page);
  });

  it("returns nothing for a node outside every page", () => {
    const stray = window.document.createElement("div");
    expect(pageElementFor(stray)).toBeNull();
    expect(pageElementFor(null)).toBeNull();
  });
});

describe("draftAnnotation", () => {
  it("fills in the parts a mark does not carry", () => {
    const draft = draftAnnotation({
      kind: "highlight",
      assetId: "asset-1",
      page: 2,
      pageLabel: "ii",
      rects: [{ left: 0.1, top: 0.1, width: 0.2, height: 0.02 }],
      color: "green",
      quoted: "a passage",
    });
    expect(draft).toMatchObject({
      kind: "highlight",
      page_label: "ii",
      color: "green",
      quoted: "a passage",
      comment: "",
      image_asset_id: null,
    });
  });
});

interface Asked {
  command: string;
  args: Record<string, unknown>;
}

/** A bridge that answers every command and records what it was asked. */
function installBridge(data: Record<string, unknown> = {}): Asked[] {
  const asked: Asked[] = [];
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const sent = envelope as { command: string; args: Record<string, unknown> };
    asked.push({ command: sent.command, args: sent.args });
    return {
      protocol_version: "1.0.0",
      request_id: "request",
      status: "succeeded" as const,
      data,
    };
  });
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  return asked;
}

afterEach(() => {
  delete window.kiwiDesktop;
});

describe("sendEvidenceToClaim", () => {
  const passage = draftAnnotation({
    kind: "highlight",
    assetId: "asset-1",
    page: 4,
    pageLabel: "4",
    rects: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.02 }],
    color: "yellow",
    quoted: "reaction times fell by 12%",
  });

  it("sends a passage that is not a mark yet, along with the claim to write", async () => {
    const asked = installBridge({ claim: { id: "claim-1" }, claim_created: true });
    const sent = await sendEvidenceToClaim(
      "workspace-1",
      { projectId: "project-1", statement: "Sleep debt slows reaction time." },
      { excerpt: { objectId: "paper-1", annotation: passage }, stance: "supports" },
    );

    expect(sent).toEqual({ claimId: "claim-1", created: true });
    expect(asked[0]?.command).toBe("kiwi.claim.send-evidence");
    expect(asked[0]?.args).toEqual({
      project_id: "project-1",
      statement: "Sleep debt slows reaction time.",
      excerpt: { object_id: "paper-1", annotation: passage },
      stance: "supports",
    });
  });

  it("sends marks that already exist to a claim that already exists", async () => {
    const asked = installBridge({ claim: { id: "claim-1" } });
    await sendEvidenceToClaim(
      "workspace-1",
      { claimId: "claim-1" },
      { objectIds: ["annotation-1"], stance: "contradicts" },
    );
    expect(asked[0]?.args).toEqual({
      claim_id: "claim-1",
      object_ids: ["annotation-1"],
      stance: "contradicts",
    });
  });

  it("leaves out an empty list rather than sending one", async () => {
    // An empty `object_ids` would be refused by the command, and the excerpt is the whole send.
    const asked = installBridge({ claim: { id: "claim-1" } });
    await sendEvidenceToClaim(
      "workspace-1",
      { claimId: "claim-1" },
      { objectIds: [], excerpt: { objectId: "paper-1", annotation: passage } },
    );
    expect(asked[0]?.args["object_ids"]).toBeUndefined();
  });

  it("never names a folder", async () => {
    const asked = installBridge({ claim: { id: "claim-1" } });
    await sendEvidenceToClaim("workspace-1", { claimId: "claim-1" }, { objectIds: ["a"] });
    expect(asked[0]?.args["root"]).toBeUndefined();
  });

  it("says what went wrong rather than pretending a claim was written", async () => {
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: "request",
      status: "failed" as const,
      error: {
        code: "KIWI_INVALID_ARGUMENTS",
        message: "A claim cannot be evidence for a claim.",
        details: {},
        retryable: false,
        recovery_actions: ["correct_input"],
        correlation_id: "correlation",
      },
    }));
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;

    const sent = await sendEvidenceToClaim(
      "workspace-1",
      { claimId: "claim-1" },
      { objectIds: ["claim-2"] },
    );
    expect(sent).toEqual({ error: "A claim cannot be evidence for a claim." });
  });
});

describe("listClaimChoices", () => {
  it("asks for the open project's claims and keeps the ones it can read", async () => {
    const asked = installBridge({
      claims: [{ id: "claim-1", title: "Sleep debt slows reaction time." }, { id: 7 }, {}],
    });
    expect(await listClaimChoices("workspace-1", "project-1")).toEqual([
      { id: "claim-1", title: "Sleep debt slows reaction time." },
    ]);
    expect(asked[0]?.args).toEqual({ project_id: "project-1" });
  });

  it("asks for every claim when no project is open", async () => {
    const asked = installBridge({ claims: [] });
    await listClaimChoices("workspace-1", null);
    expect(asked[0]?.args).toEqual({});
  });
});
