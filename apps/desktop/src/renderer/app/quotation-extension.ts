import { Node, mergeAttributes } from "@tiptap/core";
import { QUOTATION_NODE, quotationText, readQuotation } from "@kiwi/contracts";

/**
 * The attribution line under a quotation, inside the rich editor.
 *
 * A passage arrives in a draft with a line saying which paper and which page it came from. That
 * line is a node rather than words, and what it stores is the mark the passage was taken from,
 * so that reading "— Attention Is All You Need, p. 4" and going to look at page 4 is one click
 * rather than a search through a PDF for a sentence you can half remember.
 *
 * It is an atom: the line is a record of where something came from, not prose to be edited. A
 * writer who types over half of it has a quotation that says it came from somewhere it did not.
 * Deleting it whole is allowed, because a passage can be cut from a draft, and the line has
 * nothing to attach itself to once the passage is gone.
 */

/**
 * How a quotation reaches the rest of the interface.
 *
 * Asked rather than handed over, because node views are built by ProseMirror and kept for the
 * life of the node. A callback passed in at creation would be the one this component held on its
 * first render, forever.
 */
export interface QuotationHandlers {
  /** Whether this surface can open a Reader. False makes the line a line, not a link. */
  linked(): boolean;
  /** The paper travels with the mark, so a deleted mark still leaves somewhere to go. */
  open(annotationId: string, paperId: string): void;
}

export function createQuotationNode(handlers: QuotationHandlers) {
  return Node.create({
    name: QUOTATION_NODE,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,

    addAttributes() {
      return {
        annotation: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-annotation") ?? "",
          renderHTML: (attributes) => ({
            "data-annotation": String(attributes["annotation"] ?? ""),
          }),
        },
        target: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-target") ?? "",
          renderHTML: (attributes) => ({ "data-target": String(attributes["target"] ?? "") }),
        },
        source: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-source") ?? "",
          renderHTML: (attributes) => ({ "data-source": String(attributes["source"] ?? "") }),
        },
        page_label: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-page") ?? "",
          renderHTML: (attributes) => ({ "data-page": String(attributes["page_label"] ?? "") }),
        },
      };
    },

    parseHTML() {
      return [{ tag: "span[data-quotation]" }];
    },

    renderHTML({ HTMLAttributes, node }) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, { "data-quotation": "", class: "quotation-source" }),
        quotationText(readQuotation(node.attrs)),
      ];
    },

    addNodeView() {
      return ({ node }) => {
        const attributes = readQuotation(node.attrs);
        const element = document.createElement("span");
        element.className = "quotation-source";
        element.setAttribute("data-quotation", "");
        element.setAttribute("data-annotation", attributes.annotation);
        element.textContent = quotationText(attributes);
        if (attributes.annotation === "" || !handlers.linked()) return { dom: element };
        element.classList.add("quotation-source--linked");
        element.setAttribute("role", "link");
        element.setAttribute("tabindex", "0");
        element.title = "Open the page this was read on";
        element.addEventListener("mousedown", (event) => {
          // Claimed on the press rather than the click: the editor turns a press on an atom into
          // a selection, and a link that selects itself before it opens flashes for no reason.
          event.preventDefault();
          event.stopPropagation();
          handlers.open(attributes.annotation, attributes.target);
        });
        element.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          handlers.open(attributes.annotation, attributes.target);
        });
        return { dom: element };
      };
    },
  });
}
