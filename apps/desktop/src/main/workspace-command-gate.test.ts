import { describe, expect, it } from "vitest";
import {
  assetCommands,
  bibliographyCommands,
  claimCommands,
  coeditNoteCommands,
  objectCommands,
  projectCommands,
  protocolCommands,
  taskCommands,
  threadCommands,
} from "@kiwi/workspace";
import {
  READ_ONLY_WORKSPACE_COMMANDS,
  isReadOnlyWorkspaceCommand,
  needsWorkspaceRoot,
} from "./workspace-command-gate.js";

const deps = { newId: () => "id", now: () => "2026-09-21T00:00:00.000Z" };

/** Every command that works on a workspace, as the workspace package defines them. */
const DEFINITIONS = [
  ...objectCommands(deps),
  ...projectCommands(deps),
  ...protocolCommands(deps),
  ...claimCommands(deps),
  ...taskCommands(deps),
  ...threadCommands(deps),
  ...bibliographyCommands(deps),
  ...assetCommands(deps),
  ...coeditNoteCommands(deps),
];

/** The ones that cannot run without being told which folder to run against. */
const ROOTED = DEFINITIONS.filter((definition) => {
  const schema = definition.argsSchema as { required?: unknown };
  return Array.isArray(schema.required) && schema.required.includes("root");
}).map((definition) => definition.name);

describe("workspace command gate", () => {
  it("has commands to check", () => {
    expect(ROOTED.length).toBeGreaterThan(50);
  });

  it("supplies the workspace to every command that requires one", () => {
    // The renderer never holds a path, so a command left out here reaches the command layer with
    // no root and is refused for a property no interface can send. That is how every mark made in
    // the Reader came to fail: the annotation namespace was not on the list.
    const missing = ROOTED.filter((name) => !needsWorkspaceRoot(name));
    expect(missing).toEqual([]);
  });

  it("covers the annotation commands the Reader calls", () => {
    for (const name of [
      "kiwi.annotation.create",
      "kiwi.annotation.update",
      "kiwi.annotation.list",
      "kiwi.annotation.locate",
      "kiwi.annotation.send-to-note",
      "kiwi.annotation.send-to-manuscript",
    ]) {
      expect(needsWorkspaceRoot(name)).toBe(true);
    }
  });

  it("lets a read-only workspace be read and not written", () => {
    expect(isReadOnlyWorkspaceCommand("kiwi.annotation.list")).toBe(true);
    expect(isReadOnlyWorkspaceCommand("kiwi.annotation.create")).toBe(false);
    expect(isReadOnlyWorkspaceCommand("kiwi.object.read")).toBe(true);
    expect(isReadOnlyWorkspaceCommand("kiwi.object.save")).toBe(false);
  });

  it("names only commands that exist", () => {
    // A name that no longer exists reads as a permission that is still in force. The projection
    // and search commands are defined in this application rather than in the workspace package,
    // so they are the exception the check allows for.
    const known = new Set(ROOTED);
    const elsewhere = ["kiwi.projection.", "kiwi.search."];
    const unknown = [...READ_ONLY_WORKSPACE_COMMANDS].filter(
      (name) => !known.has(name) && !elsewhere.some((prefix) => name.startsWith(prefix)),
    );
    expect(unknown).toEqual([]);
  });
});
