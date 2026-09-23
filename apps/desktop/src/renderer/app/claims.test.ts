import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { emptyClaim, type ClaimBody } from "@kiwi/contracts";
import {
  evidenceOf,
  evidenceTally,
  isDisputed,
  readClaimViews,
  standsOnNothing,
  useClaims,
  withAnswer,
  type ClaimView,
} from "./claims.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

interface Asked {
  command: string;
  args: Record<string, unknown>;
}

function piece(
  id: string,
  stance: string,
  title = "Table 2 of the trial",
): Record<string, unknown> {
  return {
    relation_id: `relation-${id}`,
    object_id: id,
    object_type: "annotation",
    title,
    stance,
    attached_at: "2026-08-03T09:00:00.000Z",
  };
}

function row(
  id: string,
  statement: string,
  claim: Partial<ClaimBody> = {},
  evidence: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  return {
    id,
    version: 3,
    content_hash: `hash-${id}`,
    title: statement,
    created_at: "2026-08-01T09:00:00.000Z",
    updated_at: "2026-08-02T09:00:00.000Z",
    claim: { ...emptyClaim(), statement, ...claim },
    evidence,
  };
}

function view(id: string, statement: string, stances: string[] = []): ClaimView {
  const read = readClaimViews({
    claims: [
      row(
        id,
        statement,
        {},
        stances.map((stance, at) => piece(`e${at}`, stance)),
      ),
    ],
  });
  return read[0] as ClaimView;
}

function ok(data: Record<string, unknown>): RendererCommandResult {
  return { protocol_version: "1.0.0", request_id: "request", status: "succeeded", data };
}

function refused(code: string, message: string): RendererCommandResult {
  return {
    protocol_version: "1.0.0",
    request_id: "request",
    status: "failed",
    error: {
      code,
      message,
      details: {},
      retryable: false,
      recovery_actions: ["correct_input"],
      correlation_id: "correlation",
    },
  };
}

function installBridge(
  answer: (command: string, args: Record<string, unknown>) => Promise<RendererCommandResult>,
): Asked[] {
  const asked: Asked[] = [];
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const sent = envelope as { command: string; args: Record<string, unknown> };
    asked.push({ command: sent.command, args: sent.args });
    return answer(sent.command, sent.args);
  });
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  return asked;
}

/** A bridge that answers every list with the same claims, and every write with a plain yes. */
function bridgeListing(...rows: Array<Record<string, unknown>>): Asked[] {
  return installBridge(async (command) =>
    command === "kiwi.claim.list" ? ok({ claims: rows }) : ok({}),
  );
}

function statements(claims: ClaimView[]): string[] {
  return claims.map((claim) => claim.claim.statement);
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("readClaimViews", () => {
  it("keeps the order the command answered in", () => {
    const claims = readClaimViews({
      claims: [row("b", "Sleep improves recall"), row("a", "Caffeine does not")],
    });
    expect(statements(claims)).toEqual(["Sleep improves recall", "Caffeine does not"]);
  });

  it("leaves out a row it cannot read and keeps the rest", () => {
    const claims = readClaimViews({
      claims: [row("a", "Sleep improves recall"), { id: "b", title: "Nonsense" }],
    });
    expect(statements(claims)).toEqual(["Sleep improves recall"]);
  });

  it("reads nothing out of an answer with no claims in it", () => {
    expect(readClaimViews(undefined)).toEqual([]);
    expect(readClaimViews({})).toEqual([]);
  });

  it("keeps the version and hash an edit has to send back", () => {
    const claims = readClaimViews({ claims: [row("a", "Sleep improves recall")] });
    expect(claims[0]).toMatchObject({ version: 3, content_hash: "hash-a" });
  });

  it("drops a piece of evidence whose stance it cannot read and keeps the others", () => {
    // A newer build might attach evidence some other way. Counting what this one cannot read as
    // either for or against would make the claim look settled by something unreadable.
    const claims = readClaimViews({
      claims: [
        row("a", "Sleep improves recall", {}, [piece("e1", "supports"), piece("e2", "hints")]),
      ],
    });
    expect(claims[0]?.evidence.map((entry) => entry.object_id)).toEqual(["e1"]);
  });
});

describe("evidence", () => {
  it("counts each side", () => {
    expect(
      evidenceTally(view("a", "Sleep improves recall", ["supports", "contradicts", "supports"])),
    ).toEqual({ supports: 2, contradicts: 1 });
  });

  it("hands back one side without the caller counting again", () => {
    const claim = view("a", "Sleep improves recall", ["supports", "contradicts"]);
    expect(evidenceOf(claim, "contradicts").map((entry) => entry.object_id)).toEqual(["e1"]);
  });

  it("says a claim with nothing for it stands on nothing", () => {
    expect(standsOnNothing(view("a", "Sleep improves recall"))).toBe(true);
  });

  it("still says so when the only evidence is against it", () => {
    // Being argued against is not being stood up. A claim with three papers against it and none
    // for it is the most urgent thing on the unsupported list, not something off it.
    expect(standsOnNothing(view("a", "Sleep improves recall", ["contradicts"]))).toBe(true);
  });

  it("marks a claim with evidence pointing both ways", () => {
    expect(isDisputed(view("a", "Sleep improves recall", ["supports", "contradicts"]))).toBe(true);
    expect(isDisputed(view("a", "Sleep improves recall", ["supports"]))).toBe(false);
  });
});

describe("withAnswer", () => {
  it("adds one without cancelling the others", () => {
    const claim = view("a", "Sleep improves recall");
    claim.claim.answers = ["Q1"];
    expect(withAnswer(claim, "H2", true)).toEqual(["Q1", "H2"]);
  });

  it("removes one without cancelling the others", () => {
    const claim = view("a", "Sleep improves recall");
    claim.claim.answers = ["Q1", "H2"];
    expect(withAnswer(claim, "Q1", false)).toEqual(["H2"]);
  });

  it("has nothing to send when the answer already reads that way", () => {
    const claim = view("a", "Sleep improves recall");
    claim.claim.answers = ["Q1"];
    expect(withAnswer(claim, "Q1", true)).toBeNull();
    expect(withAnswer(claim, "H9", false)).toBeNull();
  });

  it("refuses an id the protocol could never carry", () => {
    expect(withAnswer(view("a", "Sleep improves recall"), "the third one", true)).toBeNull();
  });
});

describe("useClaims", () => {
  it("shows the project's claims", async () => {
    const asked = bridgeListing(row("a", "Sleep improves recall"), row("b", "Caffeine does not"));
    const { result } = renderHook(() =>
      useClaims({ workspaceId: "workspace-1", projectId: "project-1" }),
    );

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(statements(result.current.claims)).toEqual([
      "Sleep improves recall",
      "Caffeine does not",
    ]);
    expect(asked[0]).toEqual({ command: "kiwi.claim.list", args: { project_id: "project-1" } });
  });

  it("never names a folder", async () => {
    // The main process fills in the root from the open workspace. A renderer that sent one could
    // send the wrong one, or one it was never meant to know about.
    const asked = bridgeListing(row("a", "Sleep improves recall"));
    const { result } = renderHook(() =>
      useClaims({ workspaceId: "workspace-1", projectId: "project-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.attach("a", "annotation-1", "supports"));

    for (const call of asked) expect(call.args["root"]).toBeUndefined();
  });

  it("asks for only the claims nothing supports", async () => {
    const asked = bridgeListing();
    const { result } = renderHook(() =>
      useClaims({ workspaceId: "workspace-1", projectId: "project-1", unsupported: true }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(asked[0]?.args).toEqual({ project_id: "project-1", unsupported: true });
  });

  it("asks again when the filter changes", async () => {
    const asked = bridgeListing(row("a", "Sleep improves recall"));
    const { result, rerender } = renderHook(
      (props: { status?: "draft" | "supported" }) =>
        useClaims({ workspaceId: "workspace-1", projectId: "project-1", ...props }),
      { initialProps: {} },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ status: "supported" });
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]?.args).toEqual({ project_id: "project-1", status: "supported" });
  });

  it("reads the list again after attaching evidence, so every surface agrees", async () => {
    let listed = [row("a", "Sleep improves recall")];
    const asked = installBridge(async (command) => {
      if (command === "kiwi.claim.list") return ok({ claims: listed });
      listed = [row("a", "Sleep improves recall", {}, [piece("e1", "supports")])];
      return ok({});
    });
    const { result } = renderHook(() =>
      useClaims({ workspaceId: "workspace-1", projectId: "project-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(standsOnNothing(result.current.claims[0] as ClaimView)).toBe(true);

    await act(() => result.current.attach("a", "e1", "supports"));
    expect(asked.map((call) => call.command)).toEqual([
      "kiwi.claim.list",
      "kiwi.claim.attach-evidence",
      "kiwi.claim.list",
    ]);
    expect(standsOnNothing(result.current.claims[0] as ClaimView)).toBe(false);
  });

  it("sends the version the row was showing when it was edited", async () => {
    const asked = bridgeListing(row("a", "Sleep improves recall"));
    const { result } = renderHook(() =>
      useClaims({ workspaceId: "workspace-1", projectId: "project-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const claim = result.current.claims[0] as ClaimView;
    await act(() => result.current.update(claim, { status: "supported" }));
    expect(asked[1]).toEqual({
      command: "kiwi.claim.update",
      args: {
        claim_id: "a",
        expected_version: 3,
        expected_hash: "hash-a",
        status: "supported",
      },
    });
  });

  it("says a claim needs a project to belong to rather than writing one nowhere", async () => {
    const asked = bridgeListing(row("a", "Sleep improves recall"));
    const { result } = renderHook(() => useClaims({ workspaceId: "workspace-1" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      expect(await result.current.create({ statement: "Caffeine does not" })).toBe(false);
    });
    expect(result.current.error).toBe("Open a project to write down what it asserts.");
    expect(asked.map((call) => call.command)).toEqual(["kiwi.claim.list"]);
  });

  it("says why a write was refused and leaves the list as it was", async () => {
    installBridge(async (command) =>
      command === "kiwi.claim.list"
        ? ok({ claims: [row("a", "Sleep improves recall")] })
        : refused(
            "KIWI_INVALID_ARGUMENTS",
            "A claim cannot be evidence for a claim. Attach what the first claim stands on instead.",
          ),
    );
    const { result } = renderHook(() =>
      useClaims({ workspaceId: "workspace-1", projectId: "project-1" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.attach("a", "claim-b", "supports"));
    expect(result.current.error).toContain("A claim cannot be evidence for a claim.");
    expect(statements(result.current.claims)).toEqual(["Sleep improves recall"]);

    act(() => result.current.dismissError());
    expect(result.current.error).toBeNull();
  });

  it("does not let an earlier read put back the list it replaced", async () => {
    // A filter changed while the first read is still out. The answer that lands second is the
    // one being asked about, whichever of them started first.
    const slow: Array<() => void> = [];
    installBridge(
      (command, args) =>
        new Promise((resolve) => {
          const claims = args["status"] === undefined ? [row("a", "Sleep improves recall")] : [];
          const answer = () => resolve(ok({ claims }));
          if (command === "kiwi.claim.list" && args["status"] === undefined) slow.push(answer);
          else answer();
        }),
    );
    const { result, rerender } = renderHook(
      (props: { status?: "supported" }) =>
        useClaims({ workspaceId: "workspace-1", projectId: "project-1", ...props }),
      { initialProps: {} },
    );

    rerender({ status: "supported" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      slow.forEach((answer) => answer());
      await Promise.resolve();
    });
    expect(result.current.claims).toEqual([]);
  });
});
