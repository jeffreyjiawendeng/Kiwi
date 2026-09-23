import { Extension, InputRule, Node, mergeAttributes } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import {
  MENTION_NODE,
  isObjectType,
  mentionText,
  objectTypeLabel,
  readMention,
  type MentionAttributes,
} from "@kiwi/contracts";

/**
 * Mentions inside the rich editor.
 *
 * Two extensions, for the two halves of the same thing. `createMentionTrigger` notices an `@` at
 * the start of a word and says so; the node below is what an accepted choice becomes. The `@`
 * itself is never stored, it is a way of typing, and by the time the sentence is read there is
 * nothing to distinguish "the paper I typed with an @" from "the paper I chose from a menu".
 *
 * What the node stores is the object's id. The title beside it is a copy, rewritten from the
 * workspace every time the document is opened, so a paper renamed in the Library is renamed in
 * every sentence that points at it.
 */

/**
 * How a mention reaches the rest of the interface.
 *
 * Both are asked rather than handed over, because node views are built by ProseMirror and kept
 * for the life of the node. A callback passed in at creation would be the one this component had
 * on its first render, forever.
 */
export interface MentionHandlers {
  /** Whether this surface can send anyone anywhere. False makes a mention a name, not a link. */
  linked(): boolean;
  open(target: string, kind: string): void;
}

export function createMentionNode(handlers: MentionHandlers) {
  return Node.create({
    name: MENTION_NODE,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,

    addAttributes() {
      return {
        target: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-target") ?? "",
          renderHTML: (attributes) => ({ "data-target": String(attributes["target"] ?? "") }),
        },
        kind: {
          default: "note",
          parseHTML: (element) => element.getAttribute("data-kind") ?? "note",
          renderHTML: (attributes) => ({ "data-kind": String(attributes["kind"] ?? "note") }),
        },
        label: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-label") ?? "",
          renderHTML: (attributes) => ({ "data-label": String(attributes["label"] ?? "") }),
        },
        missing: {
          default: false,
          parseHTML: (element) => element.getAttribute("data-missing") === "",
          renderHTML: (attributes) =>
            attributes["missing"] === true ? { "data-missing": "" } : {},
        },
      };
    },

    parseHTML() {
      return [{ tag: "span[data-mention]" }];
    },

    renderHTML({ HTMLAttributes, node }) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, { "data-mention": "", class: "mention" }),
        mentionText(readMention(node.attrs)),
      ];
    },

    addNodeView() {
      return ({ node }) => {
        const attributes = readMention(node.attrs);
        const element = document.createElement("span");
        element.className = "mention";
        element.setAttribute("data-mention", "");
        element.setAttribute("data-target", attributes.target);
        element.setAttribute("data-kind", attributes.kind);
        element.textContent = mentionText(attributes);
        if (attributes.missing) {
          // A sentence whose link has gone still reads perfectly, which is the whole problem:
          // nobody rereads a paragraph to check that what it points at is still there.
          element.classList.add("mention--missing");
          element.title = `This ${objectTypeLabel(attributes.kind).toLocaleLowerCase()} is no longer in the workspace.`;
          return { dom: element };
        }
        if (!handlers.linked()) return { dom: element };
        element.classList.add("mention--linked");
        element.setAttribute("role", "link");
        element.setAttribute("tabindex", "0");
        element.title = `Open this ${objectTypeLabel(attributes.kind).toLocaleLowerCase()}`;
        element.addEventListener("mousedown", (event) => {
          // Claimed on the press rather than the click: the editor turns a press on an atom into
          // a selection, and a link that selects itself before it opens flashes for no reason.
          event.preventDefault();
          event.stopPropagation();
          handlers.open(attributes.target, attributes.kind);
        });
        element.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          handlers.open(attributes.target, attributes.kind);
        });
        return { dom: element };
      };
    },
  });
}

/**
 * Notices an `@` typed at the start of a word.
 *
 * Nothing is written to the document: the rule reports and returns, which leaves the `@` to be
 * typed as the ordinary character it is. That matters when the picker is dismissed, what is
 * left behind is the `@` the person typed, in the sentence they were writing, rather than a hole
 * where a menu used to be.
 *
 * Mid-word it is not a trigger. `research@example.org` is an address, and an address that opened
 * a menu over the paragraph would be unusable.
 */
export function createMentionTrigger(onTyped: () => void) {
  return Extension.create({
    name: "mentionTrigger",

    addInputRules() {
      return [
        new InputRule({
          find: /(?:^|[\s([{"'])@$/u,
          handler: () => {
            onTyped();
          },
        }),
      ];
    },
  });
}

/**
 * The `@` immediately before the caret, if that is where the caret is.
 *
 * The picker replaces the sigil that opened it, and inserts on its own where nothing opened it:
 * the toolbar reaches the same picker without anything having been typed.
 */
export function mentionTriggerRange(editor: Editor): { from: number; to: number } {
  const { from, empty } = editor.state.selection;
  if (!empty || from === 0) return { from, to: from };
  const before = editor.state.doc.textBetween(from - 1, from, "\n", "\n");
  return before === "@" ? { from: from - 1, to: from } : { from, to: from };
}

/** The transaction meta that marks a title refresh, so it is not mistaken for something typed. */
export const RESTAMP_META = "kiwiMentions";

/**
 * Writes the current titles into every mention.
 *
 * The same move `renumberCrossReferences` makes, for the same reason. Nothing tells the editor
 * that a paper was renamed in another pane, so the name on screen would stay whatever it was
 * until that paragraph happened to be edited. Writing the title into the node is what makes it
 * change, and it also means the saved document and every export already read correctly without
 * anything having to resolve an id first.
 *
 * Left out of the undo history: a rename made somewhere else is not an edit to this document,
 * and undoing back past it would restore a name nothing in the workspace answers to.
 */
export function restampMentions(editor: Editor, titles: ReadonlyMap<string, string>): void {
  const changes: Array<{ position: number; attributes: MentionAttributes }> = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== MENTION_NODE) return true;
    const current = readMention(node.attrs);
    if (current.target === "") return false;
    const title = titles.get(current.target);
    const next: MentionAttributes = {
      target: current.target,
      kind: current.kind,
      // The last name it had, when it has no name any more. A note that loses the link should
      // not also lose what it was talking about.
      label: title ?? current.label,
      missing: title === undefined,
    };
    if (next.label !== current.label || next.missing !== current.missing) {
      changes.push({ position, attributes: next });
    }
    return false;
  });
  if (changes.length === 0) return;

  const transaction = editor.state.tr;
  for (const change of changes) {
    transaction.setNodeAttribute(change.position, "label", change.attributes.label);
    transaction.setNodeAttribute(change.position, "missing", change.attributes.missing);
  }
  transaction.setMeta("addToHistory", false).setMeta(RESTAMP_META, true);
  editor.view.dispatch(transaction);
}

/** The kind a mention should be stored with, given whatever the projection said it was. */
export function mentionKind(type: unknown): MentionAttributes["kind"] {
  return isObjectType(type) ? type : "note";
}
