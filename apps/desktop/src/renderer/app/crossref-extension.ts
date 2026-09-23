import { Extension, Node, mergeAttributes } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import {
  CROSS_REFERENCE_NODE,
  createCrossReferenceCounter,
  crossReferenceLabel,
  crossReferenceTargetKind,
  isCrossReferenceKind,
  type CrossReferenceKind,
} from "@kiwi/contracts";

/**
 * Cross-references inside the rich editor.
 *
 * Two extensions, because a reference needs two things. `CrossReferenceTargets` gives figures,
 * tables, headings, and displayed equations somewhere to keep an id, and the node below stores
 * which id a sentence points at. The number is never typed and never stored as the truth: it is
 * worked out from document order, and rewritten whenever document order changes.
 *
 * Ids are not handed out when a target is created. Most figures are never referred to, and an
 * editor that put a UUID on every heading would fill the saved document with identifiers that
 * mean nothing to anything. One is assigned at the moment something first points at the target.
 */

/** The attribute a target keeps its id under, in the node tree and in the HTML. */
export const TARGET_ID_ATTRIBUTE = "kiwiId";

const TARGET_TYPES = ["heading", "image", "table", "mathBlock"];

export const CrossReferenceTargets = Extension.create({
  name: "crossReferenceTargets",

  addGlobalAttributes() {
    return [
      {
        types: TARGET_TYPES,
        attributes: {
          [TARGET_ID_ATTRIBUTE]: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-kiwi-id"),
            renderHTML: (attributes) => {
              const id = attributes[TARGET_ID_ATTRIBUTE];
              return typeof id === "string" && id !== "" ? { "data-kiwi-id": id } : {};
            },
          },
        },
      },
    ];
  },
});

export interface CrossReferenceAttributes {
  /** The id of the figure, table, heading, or equation this points at. */
  target: string;
  kind: CrossReferenceKind;
  /** The number as it was last worked out. Kept so a reopened document reads correctly at once. */
  label: string;
}

export function createCrossReferenceNode() {
  return Node.create({
    name: CROSS_REFERENCE_NODE,
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
          default: "figure",
          parseHTML: (element) => element.getAttribute("data-kind") ?? "figure",
          renderHTML: (attributes) => ({ "data-kind": String(attributes["kind"] ?? "figure") }),
        },
        label: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-label") ?? "",
          renderHTML: (attributes) => ({ "data-label": String(attributes["label"] ?? "") }),
        },
      };
    },

    parseHTML() {
      return [{ tag: "span[data-crossref]" }];
    },

    renderHTML({ HTMLAttributes, node }) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, { "data-crossref": "", class: "crossref" }),
        referenceText(node.attrs as unknown as CrossReferenceAttributes),
      ];
    },

    addNodeView() {
      return ({ node }) => {
        const attributes = node.attrs as unknown as CrossReferenceAttributes;
        const element = document.createElement("span");
        element.className = "crossref";
        element.setAttribute("data-crossref", "");
        element.setAttribute("data-target", attributes.target);
        element.textContent = referenceText(attributes);
        // A reference whose figure has been deleted still reads as a sentence, so it has to look
        // wrong to be noticed. The one who cannot see the break sends the paper with it.
        if (attributes.label === "") {
          element.classList.add("crossref--unresolved");
          element.title = "What this pointed at is no longer in the document.";
        }
        return { dom: element };
      };
    },
  });
}

/** What a reference shows: its number, or a question mark once its target is gone. */
export function referenceText(attributes: CrossReferenceAttributes): string {
  return attributes.label === "" ? "(?)" : attributes.label;
}

export interface EditorTarget {
  /** Where the target node starts, so an id can be put on it without searching again. */
  position: number;
  id: string;
  kind: CrossReferenceKind;
  number: string;
  text: string;
}

/**
 * Everything in the open document that can be pointed at, numbered, in document order.
 *
 * Read from the live editor rather than from its JSON because inserting a reference has to set
 * an id on the node that was chosen, and only a position identifies which node that is.
 */
export function editorTargets(editor: Editor): EditorTarget[] {
  const counter = createCrossReferenceCounter();
  const found: EditorTarget[] = [];
  editor.state.doc.descendants((node, position) => {
    const kind = crossReferenceTargetKind(node.type.name);
    if (kind !== null) {
      const level = Number(node.attrs["level"] ?? 1);
      const text =
        node.type.name === "image"
          ? String(node.attrs["alt"] ?? "")
          : node.type.name === "mathBlock"
            ? String(node.attrs["latex"] ?? "")
            : node.textContent;
      found.push({
        position,
        id: String(node.attrs[TARGET_ID_ATTRIBUTE] ?? ""),
        kind,
        number: counter.next(kind, Number.isNaN(level) ? 1 : level),
        text,
      });
    }
    // A table numbers as one thing, and a heading typed inside a cell is not a section of the
    // paper. Both are settled by not walking into it.
    return node.type.name !== "table";
  });
  return found;
}

/** The transaction meta that marks a renumber, so it is not mistaken for something typed. */
export const RENUMBER_META = "kiwiRenumber";

/**
 * Rewrites the numbers document order has changed.
 *
 * Nothing about a reference changes when a figure is inserted above it, so nothing tells the
 * editor to redraw it, the number on screen would stay whatever it was until that paragraph
 * happened to be edited. Writing the number into the node is what makes it move, and it also
 * means the saved document and every export already read correctly without recomputing anything.
 *
 * It is left out of the undo history: renumbering is a consequence of an edit, not an edit, and
 * undoing the insertion of a figure should not need a second undo to put the numbers back.
 */
export function renumberCrossReferences(editor: Editor): void {
  const labels = new Map<string, string>();
  for (const target of editorTargets(editor)) {
    if (target.id !== "") labels.set(target.id, crossReferenceLabel(target.kind, target.number));
  }

  const changes: Array<{ position: number; label: string; kind: CrossReferenceKind }> = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== CROSS_REFERENCE_NODE) return true;
    const target = String(node.attrs["target"] ?? "");
    const label = labels.get(target) ?? "";
    const kind = readKind(label, node.attrs["kind"]);
    if (label !== node.attrs["label"] || kind !== node.attrs["kind"]) {
      changes.push({ position, label, kind });
    }
    return false;
  });
  if (changes.length === 0) return;

  const transaction = editor.state.tr;
  for (const change of changes) {
    transaction.setNodeAttribute(change.position, "label", change.label);
    transaction.setNodeAttribute(change.position, "kind", change.kind);
  }
  transaction.setMeta("addToHistory", false).setMeta(RENUMBER_META, true);
  editor.view.dispatch(transaction);
}

/**
 * The kind a reference says it is.
 *
 * Taken from the label when there is one, because a target can change kind under a reference:
 * an equation deleted and replaced by a figure with the same id is not a thing that happens, but
 * a stored kind that disagrees with the label is, and the label is the thing that was counted.
 */
function readKind(label: string, stored: unknown): CrossReferenceKind {
  const word = label.split(" ")[0]?.toLowerCase() ?? "";
  if (isCrossReferenceKind(word)) return word;
  return isCrossReferenceKind(stored) ? stored : "figure";
}
