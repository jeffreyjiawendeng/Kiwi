import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { emptyProtocol, type Criterion, type ProtocolBody } from "@kiwi/contracts";
import {
  addCriterion,
  addExtractionField,
  addHypothesis,
  addSubQuestion,
  changeEntry,
  readProtocolView,
  removeEntry,
  useProtocol,
} from "./protocol.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

interface Asked {
  command: string;
  args: Record<string, unknown>;
}

const WORKSPACE = "workspace-1";
const PROJECT = "project-1";

function row(protocol: Partial<ProtocolBody> = {}, version = 2): Record<string, unknown> {
  return {
    id: "protocol-1",
    version,
    content_hash: `hash-${version}`,
    title: "Does sleep improve recall?",
    created_at: "2026-08-01T09:00:00.000Z",
    updated_at: "2026-08-02T09:00:00.000Z",
    protocol: { ...emptyProtocol(), ...protocol },
  };
}

function ok(data: Record<string, unknown>): RendererCommandResult {
  return { protocol_version: "1.0.0", request_id: "request", status: "succeeded", data };
}

function refused(
  code: string,
  message: string,
  details: Record<string, string | number | boolean> = {},
): RendererCommandResult {
  return {
    protocol_version: "1.0.0",
    request_id: "request",
    status: "failed",
    error: {
      code,
      message,
      details,
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

/** A workspace where the project has never opened the page, and every write is allowed. */
function bridgeFromNothing(): Asked[] {
  let stored: Record<string, unknown> | null = null;
  return installBridge(async (command, args) => {
    if (command === "kiwi.protocol.read") return ok({ protocol: stored });
    if (command === "kiwi.protocol.ensure") {
      stored ??= row({}, 1);
      return ok({ protocol: stored, created: true });
    }
    const version = (stored?.["version"] as number | undefined) ?? 1;
    const changes = { ...args };
    delete changes["project_id"];
    delete changes["expected_version"];
    delete changes["expected_hash"];
    const before = (stored?.["protocol"] ?? emptyProtocol()) as ProtocolBody;
    stored = row({ ...before, ...changes }, version + 1);
    return ok({ protocol: stored });
  });
}

function render() {
  return renderHook(() => useProtocol({ workspaceId: WORKSPACE, projectId: PROJECT }));
}

function criterion(id: string, kind: Criterion["kind"], code: string, text: string): Criterion {
  return { id, kind, code, text };
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("readProtocolView", () => {
  it("reads nothing for a project that has never opened the page", () => {
    expect(readProtocolView({ protocol: null })).toBeNull();
    expect(readProtocolView(undefined)).toBeNull();
  });

  it("keeps the version and hash a save has to send back", () => {
    const view = readProtocolView({ protocol: row({ question: "Does sleep help?" }, 7) });
    expect(view).toMatchObject({ id: "protocol-1", version: 7, content_hash: "hash-7" });
    expect(view?.protocol.question).toBe("Does sleep help?");
  });

  it("shows a protocol it only half understands rather than none of it", () => {
    // A file written by a newer build arrives with the parts this one knows. Refusing the whole
    // answer would leave the page saying the project has no protocol, which is worse than wrong.
    const view = readProtocolView({
      protocol: { ...row({ question: "Does sleep help?" }), protocol: { question: "Kept" } },
    });
    expect(view?.protocol.question).toBe("Kept");
    expect(view?.protocol.hypotheses).toEqual([]);
  });
});

describe("adding entries", () => {
  it("numbers each series from the highest used, not the length", () => {
    // H2 was deleted. The next one is H4, because a claim that named H3 must keep meaning H3.
    const kept = [
      { id: "H1", statement: "Sleep helps", direction: "increase", status: "open" },
      { id: "H3", statement: "Caffeine hurts", direction: "decrease", status: "open" },
    ] as const;
    expect(addHypothesis([...kept]).at(-1)?.id).toBe("H4");
    expect(addSubQuestion([{ id: "Q1", text: "For adults?" }]).at(-1)?.id).toBe("Q2");
    expect(addExtractionField([]).at(-1)).toMatchObject({ id: "F1", type: "text", unit: null });
  });

  it("codes a criterion within its kind, so the code says which it is", () => {
    let criteria = addCriterion([], "inclusion", "Adults");
    criteria = addCriterion(criteria, "exclusion", "Under 18");
    criteria = addCriterion(criteria, "exclusion", "Not in English");
    expect(criteria.map((entry) => entry.code)).toEqual(["I1", "E1", "E2"]);
    // The ids are the project's own series, running across both kinds.
    expect(criteria.map((entry) => entry.id)).toEqual(["C1", "C2", "C3"]);
  });

  it("does not reuse the code of a criterion that was deleted", () => {
    const after = removeEntry(
      [
        criterion("C1", "exclusion", "E1", "Under 18"),
        criterion("C2", "exclusion", "E2", "Not in English"),
      ],
      "C1",
    );
    expect(addCriterion(after, "exclusion", "No control group").at(-1)?.code).toBe("E3");
  });
});

describe("changeEntry and removeEntry", () => {
  it("changes one entry and leaves the others where they are", () => {
    const list = [
      { id: "Q1", text: "For adults?" },
      { id: "Q2", text: "For children?" },
    ];
    expect(changeEntry(list, "Q2", { text: "For teenagers?" })).toEqual([
      { id: "Q1", text: "For adults?" },
      { id: "Q2", text: "For teenagers?" },
    ]);
  });

  it("keeps the ids of what is left when one in the middle goes", () => {
    const list = [{ id: "Q1" }, { id: "Q2" }, { id: "Q3" }];
    expect(removeEntry(list, "Q2").map((entry) => entry.id)).toEqual(["Q1", "Q3"]);
  });
});

describe("useProtocol", () => {
  it("shows an empty protocol for a project that has never opened the page", async () => {
    const asked = bridgeFromNothing();
    const { result } = render();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.object).toBeNull();
    expect(result.current.protocol).toEqual(emptyProtocol());
    expect(result.current.frozen).toBe(false);
    // Looking is not writing. Opening and closing the page leaves no version behind.
    expect(asked.map((call) => call.command)).toEqual(["kiwi.protocol.read"]);
  });

  it("makes the object on the first save and then saves against what it was shown", async () => {
    const asked = bridgeFromNothing();
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save({ question: "Does sleep improve recall?" });
    });
    expect(result.current.protocol.question).toBe("Does sleep improve recall?");

    await act(async () => {
      await result.current.save({ method: "A randomised trial" });
    });

    expect(asked.map((call) => call.command)).toEqual([
      "kiwi.protocol.read",
      "kiwi.protocol.ensure",
      "kiwi.protocol.update",
      "kiwi.protocol.update",
    ]);
    // The second save carries the version the first one produced, not the one the page opened on.
    expect(asked[2]?.args["expected_version"]).toBe(1);
    expect(asked[3]?.args["expected_version"]).toBe(2);
    expect(result.current.protocol.method).toBe("A randomised trial");
    expect(result.current.protocol.question).toBe("Does sleep improve recall?");
  });

  it("does not make a second protocol when there is one already", async () => {
    const asked = installBridge(async (command) =>
      command === "kiwi.protocol.read" ? ok({ protocol: row() }) : ok({ protocol: row({}, 3) }),
    );
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save({ question: "Does sleep help?" });
    });
    expect(asked.map((call) => call.command)).toEqual([
      "kiwi.protocol.read",
      "kiwi.protocol.update",
    ]);
  });

  it("carries the way out of a refusal that named one", async () => {
    installBridge(async (command) =>
      command === "kiwi.protocol.read"
        ? ok({ protocol: row({ frozen_at: "2026-08-20T09:00:00.000Z", frozen_version: 2 }) })
        : refused(
            "KIWI_INVALID_ARGUMENTS",
            "This protocol was frozen. Log a deviation rather than editing it.",
            { instead: "kiwi.protocol.log-deviation", frozen_at: "2026-08-20T09:00:00.000Z" },
          ),
    );
    const { result } = render();
    await waitFor(() => expect(result.current.frozen).toBe(true));

    await act(async () => {
      expect(await result.current.save({ question: "Something else" })).toBe(false);
    });
    expect(result.current.error).toBe(
      "This protocol was frozen. Log a deviation rather than editing it.",
    );
    expect(result.current.instead).toBe("kiwi.protocol.log-deviation");

    act(() => result.current.dismissError());
    expect(result.current.instead).toBeNull();
  });

  it("logs a deviation without telling the command which version it saw", async () => {
    const asked = installBridge(async (command) =>
      command === "kiwi.protocol.read"
        ? ok({ protocol: row({ frozen_at: "2026-08-20T09:00:00.000Z", frozen_version: 2 }) })
        : ok({
            protocol: row(
              {
                frozen_at: "2026-08-20T09:00:00.000Z",
                frozen_version: 2,
                deviations: [
                  {
                    id: "D1",
                    on: "2026-08-22",
                    what: "Widened the age range",
                    why: "Recruitment fell short",
                    approved_by: "R. Okonkwo",
                  },
                ],
              },
              3,
            ),
          }),
    );
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.logDeviation({
        on: "2026-08-22",
        what: "Widened the age range",
        why: "Recruitment fell short",
        approved_by: "R. Okonkwo",
      });
    });

    expect(asked[1]?.command).toBe("kiwi.protocol.log-deviation");
    expect(asked[1]?.args["expected_version"]).toBeUndefined();
    expect(result.current.protocol.deviations.map((entry) => entry.id)).toEqual(["D1"]);
  });

  it("keeps the page as it was when somebody else has already saved", async () => {
    installBridge(async (command) =>
      command === "kiwi.protocol.read"
        ? ok({ protocol: row({ question: "Does sleep improve recall?" }) })
        : refused("KIWI_CONFLICT_VERSION", "This was changed by somebody else.", {
            actual_version: 5,
          }),
    );
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      expect(await result.current.save({ question: "Something else" })).toBe(false);
    });
    // The refusal is reported, and what was on the screen stays there to be copied out of.
    expect(result.current.error).toBe("This was changed by somebody else.");
    expect(result.current.protocol.question).toBe("Does sleep improve recall?");
    expect(result.current.instead).toBeNull();
  });

  it("says the bridge is gone rather than throwing at the page", async () => {
    delete window.kiwiDesktop;
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("The desktop bridge is unavailable.");
  });

  it("asks for nothing when no project is open", async () => {
    const asked = bridgeFromNothing();
    const { result } = renderHook(() => useProtocol({ workspaceId: WORKSPACE, projectId: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(asked).toEqual([]);
    expect(await result.current.save({ question: "Anything?" })).toBe(false);
  });
});
