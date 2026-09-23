import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emptyClaim, emptyProtocol, type ClaimBody, type ProtocolBody } from "@kiwi/contracts";
import { ClaimsPage } from "./ClaimsPage.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

interface Asked {
  command: string;
  args: Record<string, unknown>;
}

function piece(id: string, stance: string, title: string): Record<string, unknown> {
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

function protocolRow(protocol: Partial<ProtocolBody> = {}): Record<string, unknown> {
  return {
    id: "protocol-1",
    version: 2,
    content_hash: "hash-2",
    title: "Does sleep improve recall?",
    created_at: "2026-08-01T09:00:00.000Z",
    updated_at: "2026-08-02T09:00:00.000Z",
    protocol: { ...emptyProtocol(), ...protocol },
  };
}

function ok(data: Record<string, unknown>): RendererCommandResult {
  return { protocol_version: "1.0.0", request_id: "request", status: "succeeded", data };
}

function refused(message: string): RendererCommandResult {
  return {
    protocol_version: "1.0.0",
    request_id: "request",
    status: "failed",
    error: {
      code: "KIWI_INVALID_ARGUMENTS",
      message,
      details: {},
      retryable: false,
      recovery_actions: ["correct_input"],
      correlation_id: "correlation",
    },
  };
}

function installBridge(
  answer: (command: string, args: Record<string, unknown>) => RendererCommandResult,
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

/** A workspace with these claims, one hypothesis in the protocol, and every write allowed. */
function bridgeWith(...rows: Array<Record<string, unknown>>): Asked[] {
  return installBridge((command) => {
    if (command === "kiwi.claim.list") return ok({ claims: rows });
    if (command === "kiwi.protocol.read")
      return ok({
        protocol: protocolRow({
          sub_questions: [{ id: "Q1", text: "Does a nap help?" }],
          hypotheses: [
            {
              id: "H1",
              statement: "A nap after learning helps",
              direction: "none",
              status: "open",
            },
          ],
        }),
      });
    return ok({});
  });
}

function page(writable = true): void {
  render(<ClaimsPage workspaceId="workspace-1" projectId="project-1" writable={writable} />);
}

function lastCall(asked: Asked[], command: string): Asked | undefined {
  return [...asked].reverse().find((call) => call.command === command);
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("ClaimsPage", () => {
  it("shows what the project asserts and what stands behind it", async () => {
    bridgeWith(
      row("a", "Sleep improves recall", {}, [piece("e1", "supports", "Table 2 of the trial")]),
    );
    page();

    expect(await screen.findByText("Sleep improves recall")).toBeTruthy();
    expect(screen.getByText("Table 2 of the trial")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "1 claim" })).toBeTruthy();
  });

  it("says which claims are standing on nothing", async () => {
    // Argued against and not for is still standing on nothing, and that is the most urgent kind
    // of it. The heading says how many so nobody has to count the cards.
    bridgeWith(
      row("a", "Sleep improves recall", {}, [piece("e1", "contradicts", "The 2019 replication")]),
      row("b", "Caffeine does not", {}, [piece("e2", "supports", "Figure 4")]),
    );
    page();

    expect(
      await screen.findByRole("heading", { name: "2 claims, 1 standing on nothing" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Nothing supports this yet")).toHaveLength(1);
  });

  it("narrows to the unsupported list by asking the store, not the page", async () => {
    const asked = bridgeWith(row("a", "Sleep improves recall"));
    page();
    await screen.findByText("Sleep improves recall");

    fireEvent.click(screen.getByLabelText("Only unsupported"));
    await waitFor(() =>
      expect(lastCall(asked, "kiwi.claim.list")?.args).toEqual({
        project_id: "project-1",
        unsupported: true,
      }),
    );
  });

  it("writes a new claim as a draft", async () => {
    const asked = bridgeWith();
    page();
    await screen.findByRole("heading", { name: "0 claims" });

    fireEvent.click(screen.getByRole("button", { name: "New claim" }));
    fireEvent.change(screen.getByLabelText("What the project asserts"), {
      target: { value: "  Sleep improves recall  " },
    });
    fireEvent.click(screen.getByLabelText(/H1/));
    fireEvent.click(screen.getByRole("button", { name: "Add claim" }));

    await waitFor(() => expect(lastCall(asked, "kiwi.claim.create")).toBeDefined());
    expect(lastCall(asked, "kiwi.claim.create")?.args).toEqual({
      project_id: "project-1",
      statement: "Sleep improves recall",
      confidence: "low",
      answers: ["H1"],
    });
  });

  it("refuses to send a claim that asserts nothing", async () => {
    const asked = bridgeWith();
    page();
    await screen.findByRole("heading", { name: "0 claims" });

    fireEvent.click(screen.getByRole("button", { name: "New claim" }));
    fireEvent.click(screen.getByRole("button", { name: "Add claim" }));

    expect(screen.getByRole("alert").textContent).toContain("A claim has to assert something.");
    expect(lastCall(asked, "kiwi.claim.create")).toBeUndefined();
  });

  it("sends an edit against the version the card was showing", async () => {
    const asked = bridgeWith(row("a", "Sleep improves recall"));
    page();
    await screen.findByText("Sleep improves recall");

    fireEvent.change(screen.getByLabelText("Stands"), { target: { value: "supported" } });
    await waitFor(() => expect(lastCall(asked, "kiwi.claim.update")).toBeDefined());
    expect(lastCall(asked, "kiwi.claim.update")?.args).toEqual({
      claim_id: "a",
      expected_version: 3,
      expected_hash: "hash-a",
      status: "supported",
    });
  });

  it("ticks one answer without cancelling the others", async () => {
    const asked = bridgeWith(row("a", "Sleep improves recall", { answers: ["Q1"] }));
    page();
    await screen.findByText("Sleep improves recall");

    fireEvent.click(screen.getByLabelText(/H1/));
    await waitFor(() => expect(lastCall(asked, "kiwi.claim.update")).toBeDefined());
    expect(lastCall(asked, "kiwi.claim.update")?.args["answers"]).toEqual(["Q1", "H1"]);
  });

  it("says when a claim answers something the protocol no longer carries", async () => {
    // Somebody deleted H9. The claim still says it answers it, and saying so is better than the
    // claim quietly answering nothing.
    bridgeWith(row("a", "Sleep improves recall", { answers: ["H9"] }));
    page();
    await screen.findByText("Sleep improves recall");

    expect(screen.getByText("H9 is not in the protocol any more.")).toBeTruthy();
  });

  it("moves a piece of evidence to the other side in one click", async () => {
    const asked = bridgeWith(
      row("a", "Sleep improves recall", {}, [piece("e1", "supports", "Table 2 of the trial")]),
    );
    page();
    await screen.findByText("Table 2 of the trial");

    fireEvent.click(screen.getByRole("button", { name: "Contradicts instead" }));
    await waitFor(() => expect(lastCall(asked, "kiwi.claim.attach-evidence")).toBeDefined());
    expect(lastCall(asked, "kiwi.claim.attach-evidence")?.args).toEqual({
      claim_id: "a",
      object_id: "e1",
      stance: "contradicts",
    });
  });

  it("puts a claim back on the unsupported list when its evidence is detached", async () => {
    let listed = [
      row("a", "Sleep improves recall", {}, [piece("e1", "supports", "Table 2 of the trial")]),
    ];
    installBridge((command) => {
      if (command === "kiwi.claim.list") return ok({ claims: listed });
      if (command === "kiwi.protocol.read") return ok({ protocol: protocolRow() });
      if (command === "kiwi.claim.detach-evidence") listed = [row("a", "Sleep improves recall")];
      return ok({});
    });
    page();
    await screen.findByText("Table 2 of the trial");
    expect(screen.queryByText("Nothing supports this yet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    expect(await screen.findByText("Nothing supports this yet")).toBeTruthy();
  });

  it("says why a write was refused and leaves the card as it was", async () => {
    installBridge((command) => {
      if (command === "kiwi.claim.list") return ok({ claims: [row("a", "Sleep improves recall")] });
      if (command === "kiwi.protocol.read") return ok({ protocol: protocolRow() });
      return refused("Somebody else changed this claim. Reload to see what it says now.");
    });
    page();
    await screen.findByText("Sleep improves recall");

    fireEvent.change(screen.getByLabelText("Stands"), { target: { value: "supported" } });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Somebody else changed this claim."),
    );
    expect(screen.getByText("Sleep improves recall")).toBeTruthy();
  });

  it("shows a read-only project its claims and none of the ways to change them", async () => {
    bridgeWith(
      row("a", "Sleep improves recall", {}, [piece("e1", "supports", "Table 2 of the trial")]),
    );
    page(false);
    await screen.findByText("Sleep improves recall");

    expect(screen.getByRole("button", { name: "New claim" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Detach" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Stands")).toHaveProperty("disabled", true);
  });

  it("never names a folder", async () => {
    // The main process fills the root in from the open workspace. A renderer that sent one could
    // send the wrong one, or one it was never meant to know about.
    const asked = bridgeWith(row("a", "Sleep improves recall"));
    page();
    await screen.findByText("Sleep improves recall");

    fireEvent.change(screen.getByLabelText("Stands"), { target: { value: "abandoned" } });
    await waitFor(() => expect(lastCall(asked, "kiwi.claim.update")).toBeDefined());
    for (const call of asked) expect(call.args["root"]).toBeUndefined();
  });
});
