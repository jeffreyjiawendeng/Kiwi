import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { MENTION_NODE } from "@kiwi/contracts";
import {
  createMentionNode,
  createMentionTrigger,
  mentionTriggerRange,
  restampMentions,
} from "./mention-extension.js";

let open: Editor | null = null;

afterEach(() => {
  open?.destroy();
  open = null;
});

function editorWith(content: string, onTyped: () => void = () => undefined): Editor {
  open = new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit,
      createMentionNode({ linked: () => false, open: () => undefined }),
      createMentionTrigger(onTyped),
    ],
    content,
  });
  return open;
}

/** Types one character the way a keyboard does, so the input rules see it. */
async function type(editor: Editor, text: string): Promise<void> {
  editor.commands.insertContent(text, { applyInputRules: true });
  // The simulated rule runs on the next turn, which is how the plugin schedules it.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("noticing an @", () => {
  it("opens the picker on an @ that starts a word", async () => {
    const onTyped = vi.fn();
    const editor = editorWith("<p></p>", onTyped);
    await type(editor, "@");
    expect(onTyped).toHaveBeenCalled();
  });

  it("opens it after a space, which is where most of them are typed", async () => {
    const onTyped = vi.fn();
    const editor = editorWith("<p>As shown in</p>", onTyped);
    editor.commands.focus("end");
    await type(editor, " @");
    expect(onTyped).toHaveBeenCalled();
  });

  it("stays out of the way in the middle of a word", async () => {
    // `research@example.org` is an address. An address that opened a menu over the paragraph
    // every time it was typed would make the paragraph unwritable.
    const onTyped = vi.fn();
    const editor = editorWith("<p>research</p>", onTyped);
    editor.commands.focus("end");
    await type(editor, "@");
    expect(onTyped).not.toHaveBeenCalled();
  });

  it("leaves the @ in the sentence, so dismissing the picker costs nothing", async () => {
    const editor = editorWith("<p>As</p>");
    editor.commands.focus("end");
    await type(editor, " @");
    expect(editor.getText()).toBe("As @");
  });
});

describe("the @ a picker replaces", () => {
  it("is the one immediately before the caret", () => {
    const editor = editorWith("<p>As @</p>");
    editor.commands.focus("end");
    const { from, to } = mentionTriggerRange(editor);
    expect(to - from).toBe(1);
    expect(editor.state.doc.textBetween(from, to)).toBe("@");
  });

  it("is nothing at all when the picker was opened from the toolbar", () => {
    // Nothing was typed, so nothing is taken out. The mention is inserted where the caret is.
    const editor = editorWith("<p>As shown</p>");
    editor.commands.focus("end");
    const range = mentionTriggerRange(editor);
    expect(range.from).toBe(range.to);
  });
});

describe("rewriting the names", () => {
  function noteMentioning(target: string, label: string, missing = false): string {
    return `<p>As <span data-mention data-target="${target}" data-kind="source" data-label="${label}"${
      missing ? " data-missing" : ""
    }></span> shows.</p>`;
  }

  function stored(editor: Editor): Record<string, unknown> {
    let attrs: Record<string, unknown> = {};
    editor.state.doc.descendants((node) => {
      if (node.type.name === MENTION_NODE) attrs = node.attrs;
      return true;
    });
    return attrs;
  }

  it("puts the current title into the sentence", () => {
    const editor = editorWith(noteMentioning("paper-1", "The name it had then"));
    restampMentions(editor, new Map([["paper-1", "The name it has now"]]));
    expect(stored(editor)["label"]).toBe("The name it has now");
    expect(stored(editor)["missing"]).toBe(false);
  });

  it("marks a mention whose object is gone, and keeps the name it had", () => {
    const editor = editorWith(noteMentioning("paper-1", "A deleted paper"));
    restampMentions(editor, new Map());
    expect(stored(editor)["label"]).toBe("A deleted paper");
    expect(stored(editor)["missing"]).toBe(true);
  });

  it("clears the mark when what was gone comes back", () => {
    const editor = editorWith(noteMentioning("paper-1", "A restored paper", true));
    restampMentions(editor, new Map([["paper-1", "A restored paper"]]));
    expect(stored(editor)["missing"]).toBe(false);
  });

  it("is not something undo has to be pressed twice past", () => {
    // A rename made in another pane is not an edit to this document. Putting it in the history
    // would make the next undo restore a name nothing in the workspace answers to.
    const editor = editorWith(noteMentioning("paper-1", "The name it had then"));
    restampMentions(editor, new Map([["paper-1", "The name it has now"]]));
    editor.commands.undo();
    expect(stored(editor)["label"]).toBe("The name it has now");
  });

  it("writes nothing when every name is already right", () => {
    const editor = editorWith(noteMentioning("paper-1", "Already right"));
    const before = editor.state;
    restampMentions(editor, new Map([["paper-1", "Already right"]]));
    expect(editor.state).toBe(before);
  });
});
