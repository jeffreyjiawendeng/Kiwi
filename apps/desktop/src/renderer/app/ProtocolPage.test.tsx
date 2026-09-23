import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  defaultProjectSettings,
  emptyProtocol,
  type Criterion,
  type ExtractionField,
  type Hypothesis,
  type ProjectSettings,
  type ProtocolBody,
} from "@kiwi/contracts";
import { ProtocolPage } from "./ProtocolPage.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

interface Asked {
  command: string;
  args: Record<string, unknown>;
}

const FROZEN_AT = "2026-08-20T09:00:00.000Z";

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
  message: string,
  details: Record<string, string | number | boolean> = {},
): RendererCommandResult {
  return {
    protocol_version: "1.0.0",
    request_id: "request",
    status: "failed",
    error: {
      code: "KIWI_INVALID_ARGUMENTS",
      message,
      details,
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

/** A project whose protocol is `stored`, and whose writes all go through. */
function bridgeHolding(stored: Record<string, unknown> | null): Asked[] {
  let held = stored;
  return installBridge((command, args) => {
    if (command === "kiwi.protocol.read") return ok({ protocol: held });
    if (command === "kiwi.protocol.ensure") {
      held ??= row({}, 1);
      return ok({ protocol: held, created: true });
    }
    if (command === "kiwi.project.configure") return ok({ warnings: [] });
    const changes = { ...args };
    for (const key of ["project_id", "expected_version", "expected_hash"]) delete changes[key];
    const before = (held?.["protocol"] ?? emptyProtocol()) as ProtocolBody;
    const version = ((held?.["version"] as number | undefined) ?? 1) + 1;
    held = row({ ...before, ...changes }, version);
    return ok({ protocol: held });
  });
}

function show(
  stored: Record<string, unknown> | null,
  settings: ProjectSettings = defaultProjectSettings(),
): { asked: Asked[]; saved: ReturnType<typeof vi.fn> } {
  const asked = bridgeHolding(stored);
  const saved = vi.fn();
  render(
    <ProtocolPage
      workspaceId="workspace-1"
      projectId="project-1"
      projectTitle="Sleep and recall"
      settings={settings}
      projectVersion={4}
      projectHash="sha256:project"
      writable
      onProjectSaved={saved}
    />,
  );
  return { asked, saved };
}

/** Types into a field and leaves it, which is when this page saves. */
function typeAndLeave(field: HTMLElement, text: string): void {
  fireEvent.change(field, { target: { value: text } });
  fireEvent.blur(field);
}

/** Adds an entry the way the page does: type into the row's own box, then press its Add. */
function addEntry(label: string, text: string): void {
  const box = screen.getByLabelText(label);
  fireEvent.change(box, { target: { value: text } });
  const add = box.parentElement?.querySelector("button");
  if (add === null || add === undefined) throw new Error(`Nothing to add ${label} with.`);
  fireEvent.click(add);
}

function sent(asked: Asked[], command: string): Asked | undefined {
  return asked.find((call) => call.command === command);
}

function hypothesis(id: string, statement: string): Hypothesis {
  return { id, statement, direction: "increase", status: "open" };
}

function criterion(id: string, kind: Criterion["kind"], code: string, text: string): Criterion {
  return { id, kind, code, text };
}

function field(id: string, name: string, extra: Partial<ExtractionField> = {}): ExtractionField {
  return { id, name, type: "text", required: false, allowed: [], unit: null, ...extra };
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("ProtocolPage", () => {
  it("shows the question as the page's own heading", async () => {
    show(
      row({
        question: "Does sleep improve recall?",
        sub_questions: [{ id: "Q1", text: "In adults?" }],
      }),
    );

    expect(await screen.findByRole("heading", { name: "Does sleep improve recall?" })).toBeTruthy();
    expect((screen.getByLabelText("Sub-question Q1") as HTMLInputElement).value).toBe("In adults?");
  });

  it("opens on an empty protocol for a project that has never opened it", async () => {
    const { asked } = show(null);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "What is this project asking?" })).toBeTruthy(),
    );
    // Looking at the page is not writing one. Nothing but the read has been sent.
    expect(asked.map((call) => call.command)).toEqual(["kiwi.protocol.read"]);
  });

  it("makes the protocol on the first save and sends the question once", async () => {
    const { asked } = show(null);
    await screen.findByLabelText("The primary question");

    typeAndLeave(screen.getByLabelText("The primary question"), "Does sleep improve recall?");

    await waitFor(() => expect(sent(asked, "kiwi.protocol.update")).toBeTruthy());
    expect(asked.map((call) => call.command)).toEqual([
      "kiwi.protocol.read",
      "kiwi.protocol.ensure",
      "kiwi.protocol.update",
    ]);
    expect(sent(asked, "kiwi.protocol.update")?.args["question"]).toBe(
      "Does sleep improve recall?",
    );
  });

  it("saves nothing when a field is left as it was found", async () => {
    const { asked } = show(row({ question: "Does sleep improve recall?" }));
    const question = await screen.findByLabelText("The primary question");

    fireEvent.focus(question);
    fireEvent.blur(question);

    expect(asked.map((call) => call.command)).toEqual(["kiwi.protocol.read"]);
  });

  it("adds a hypothesis with the next unused number, and sends the whole list", async () => {
    const { asked } = show(row({ hypotheses: [hypothesis("H1", "Sleep helps")] }));
    await screen.findByLabelText("New hypothesis");

    addEntry("New hypothesis", "Caffeine hurts");

    await waitFor(() => expect(sent(asked, "kiwi.protocol.update")).toBeTruthy());
    expect(sent(asked, "kiwi.protocol.update")?.args["hypotheses"]).toEqual([
      hypothesis("H1", "Sleep helps"),
      { id: "H2", statement: "Caffeine hurts", direction: "none", status: "open" },
    ]);
  });

  it("does not offer to add a rule that says nothing", async () => {
    show(row());
    const add = await screen.findByLabelText("New exclusion rule");

    const button = add.parentElement?.querySelector("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
  });

  it("codes a new exclusion within its kind", async () => {
    const { asked } = show(row({ criteria: [criterion("C1", "inclusion", "I1", "Adults")] }));
    const box = await screen.findByLabelText("New exclusion rule");

    fireEvent.change(box, { target: { value: "No control group" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(sent(asked, "kiwi.protocol.update")).toBeTruthy());
    expect(sent(asked, "kiwi.protocol.update")?.args["criteria"]).toEqual([
      criterion("C1", "inclusion", "I1", "Adults"),
      criterion("C2", "exclusion", "E1", "No control group"),
    ]);
  });

  it("drops the unit when a number becomes text, which is the only thing that may have one", async () => {
    const { asked } = show(
      row({ extraction_schema: [field("F1", "Dose", { type: "number", unit: "mg" })] }),
    );
    const type = await screen.findByLabelText("What Dose holds");

    fireEvent.change(type, { target: { value: "text" } });

    await waitFor(() => expect(sent(asked, "kiwi.protocol.update")).toBeTruthy());
    expect(sent(asked, "kiwi.protocol.update")?.args["extraction_schema"]).toEqual([
      field("F1", "Dose"),
    ]);
  });

  it("says when a frozen protocol was frozen, and stops offering to edit it", async () => {
    show(row({ question: "Does sleep improve recall?", frozen_at: FROZEN_AT, frozen_version: 2 }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Frozen on"));
    expect((screen.getByLabelText("The primary question") as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Freeze this protocol" })).toBeNull();
    expect(screen.getByRole("button", { name: "Log a deviation" })).toBeTruthy();
  });

  it("asks twice before freezing, because there is no unfreezing", async () => {
    const { asked } = show(row({ question: "Does sleep improve recall?" }));

    fireEvent.click(await screen.findByRole("button", { name: "Freeze this protocol" }));
    expect(screen.getByRole("alert").textContent).toContain("cannot be undone");
    fireEvent.click(screen.getByRole("button", { name: "Not yet" }));
    expect(sent(asked, "kiwi.protocol.freeze")).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Freeze this protocol" }));
    fireEvent.click(screen.getByRole("button", { name: "Freeze it" }));
    await waitFor(() => expect(sent(asked, "kiwi.protocol.freeze")).toBeTruthy());
  });

  it("offers the deviation when a refusal names it, and logs one", async () => {
    // Somebody else froze the protocol while this page was open, so the save that was already
    // being typed comes back refused. The way out arrives with the refusal.
    const asked = installBridge((command) => {
      if (command === "kiwi.protocol.read") return ok({ protocol: row() });
      if (command === "kiwi.protocol.update") {
        return refused("This protocol was frozen. Log a deviation rather than editing it.", {
          instead: "kiwi.protocol.log-deviation",
          frozen_at: FROZEN_AT,
        });
      }
      return ok({ protocol: row({ frozen_at: FROZEN_AT, frozen_version: 2 }, 3) });
    });
    render(
      <ProtocolPage
        workspaceId="workspace-1"
        projectId="project-1"
        projectTitle="Sleep and recall"
        settings={defaultProjectSettings()}
        projectVersion={4}
        projectHash="sha256:project"
        writable
        onProjectSaved={vi.fn()}
      />,
    );

    typeAndLeave(await screen.findByLabelText("The primary question"), "Something else");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("was frozen"));

    fireEvent.click(screen.getByRole("button", { name: "Log a deviation" }));
    fireEvent.change(screen.getByLabelText("What changed"), {
      target: { value: "Widened the age range" },
    });
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "2026-08-22" } });
    fireEvent.change(screen.getByLabelText("Why"), {
      target: { value: "Recruitment fell short" },
    });
    fireEvent.change(screen.getByLabelText("Approved by"), { target: { value: "R. Okonkwo" } });
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));

    await waitFor(() => expect(sent(asked, "kiwi.protocol.log-deviation")).toBeTruthy());
    const logged = sent(asked, "kiwi.protocol.log-deviation");
    expect(logged?.args).toMatchObject({
      on: "2026-08-22",
      what: "Widened the age range",
      why: "Recruitment fell short",
      approved_by: "R. Okonkwo",
    });
    // A deviation is appended rather than edited into place, so it quotes no version.
    expect(logged?.args["expected_version"]).toBeUndefined();
  });

  it("refuses to log a deviation that does not say who approved it", async () => {
    const { asked } = show(row({ frozen_at: FROZEN_AT, frozen_version: 2 }));

    fireEvent.click(await screen.findByRole("button", { name: "Log a deviation" }));
    fireEvent.change(screen.getByLabelText("What changed"), { target: { value: "Widened it" } });
    fireEvent.click(screen.getByRole("button", { name: "Log it" }));

    expect(screen.getByRole("alert").textContent).toContain("who approved it");
    expect(sent(asked, "kiwi.protocol.log-deviation")).toBeUndefined();
  });

  it("turns on the Codebook through the same command Settings uses", async () => {
    const { asked, saved } = show(row());

    fireEvent.click(await screen.findByRole("button", { name: "Enable qualitative coding" }));

    await waitFor(() => expect(sent(asked, "kiwi.project.configure")).toBeTruthy());
    const configure = sent(asked, "kiwi.project.configure");
    expect(configure?.args).toMatchObject({
      project_id: "project-1",
      expected_version: 4,
      title: "Sleep and recall",
    });
    expect((configure?.args["settings"] as ProjectSettings).pages).toContain("codebook");
    await waitFor(() => expect(saved).toHaveBeenCalled());
  });

  it("does not offer to turn on a page that is already on", async () => {
    const settings = defaultProjectSettings();
    show(row(), { ...settings, pages: [...settings.pages, "codebook"] });

    await screen.findByRole("heading", { name: "Qualitative coding" });
    expect(screen.queryByRole("button", { name: "Enable qualitative coding" })).toBeNull();
  });
});
