export interface UiCommand {
  id: string;
  title: string;
  /** Registered backend command this action invokes, when it invokes one. */
  command: string | null;
  args: Record<string, unknown>;
  keybinding?: string;
  /** Returns null when enabled, or a reason to show the user when disabled. */
  disabledReason(context: UiContext): string | null;
}

export interface UiContext {
  bridgeReady: boolean;
  busy: boolean;
}

/**
 * One definition per action. The button, the menu, and the command center all render
 * from this list, so an action cannot exist in one surface with different behavior in
 * another.
 */
export const UI_COMMANDS: UiCommand[] = [
  {
    id: "diagnostics.echo",
    title: "Run echo command",
    command: "kiwi.diagnostics.echo",
    args: { message: "hello from Kiwi" },
    keybinding: "Ctrl+Alt+E",
    disabledReason: (context) =>
      !context.bridgeReady
        ? "The desktop bridge is unavailable."
        : context.busy
          ? "Another command is running."
          : null,
  },
  {
    id: "diagnostics.count",
    title: "Add 5 to the counter",
    command: "kiwi.diagnostics.count",
    args: { amount: 5 },
    disabledReason: (context) =>
      !context.bridgeReady
        ? "The desktop bridge is unavailable."
        : context.busy
          ? "Another command is running."
          : null,
  },
  {
    id: "diagnostics.slow",
    title: "Run cancellable operation",
    command: "kiwi.diagnostics.slow",
    args: { steps: 20, stepMs: 400 },
    disabledReason: (context) =>
      !context.bridgeReady
        ? "The desktop bridge is unavailable."
        : context.busy
          ? "Another command is running."
          : null,
  },
  {
    id: "diagnostics.invalid",
    title: "Send invalid input",
    command: "kiwi.diagnostics.echo",
    args: { message: "", repeat: 99 },
    disabledReason: (context) =>
      !context.bridgeReady
        ? "The desktop bridge is unavailable."
        : context.busy
          ? "Another command is running."
          : null,
  },
  {
    id: "diagnostics.crash",
    title: "Trigger an unplanned failure",
    command: "kiwi.diagnostics.crash",
    args: {},
    disabledReason: (context) =>
      !context.bridgeReady
        ? "The desktop bridge is unavailable."
        : context.busy
          ? "Another command is running."
          : null,
  },
];

export function findUiCommand(id: string): UiCommand | undefined {
  return UI_COMMANDS.find((command) => command.id === id);
}

export function matchUiCommands(query: string): UiCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return UI_COMMANDS;
  return UI_COMMANDS.filter(
    (command) =>
      command.title.toLowerCase().includes(needle) ||
      (command.command ?? "").toLowerCase().includes(needle),
  );
}
