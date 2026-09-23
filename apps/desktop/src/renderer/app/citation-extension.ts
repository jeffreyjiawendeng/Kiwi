import { Node, mergeAttributes } from "@tiptap/core";

/**
 * A citation inside the rich editor.
 *
 * The node stores which Paper is cited, not the words that represent it. Storing "(Vaswani &
 * Shazeer, 2017)" would freeze the citation at whatever style was current when it was typed,
 * so changing the project's style later would leave every existing citation in the old one.
 * What is stored is the link; what is shown is derived from it.
 *
 * The key is carried alongside so a LaTeX export can emit `\cite{vaswani2017}` without having
 * to resolve the object first. It is a cache of something derivable, and the object id is what
 * decides if they ever disagree.
 */

export interface CitationAttributes {
  objectId: string;
  key: string;
  /** Where in the work: "p. 45", "ch. 2". Optional, and most citations have none. */
  locator: string;
  /** What to show. Recomputed whenever the bibliography is rebuilt. */
  label: string;
}

export interface CitationLookup {
  /** The current label for a cited work, or null while the bibliography has not been read. */
  label(objectId: string): string | null;
}

export const CITATION_NODE = "citation";

export function createCitationNode(lookup: CitationLookup) {
  return Node.create({
    name: CITATION_NODE,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,

    addAttributes() {
      return {
        objectId: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-object-id") ?? "",
          renderHTML: (attributes) => ({
            "data-object-id": String(attributes["objectId"] ?? ""),
          }),
        },
        key: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-key") ?? "",
          renderHTML: (attributes) => ({ "data-key": String(attributes["key"] ?? "") }),
        },
        locator: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-locator") ?? "",
          renderHTML: (attributes) => ({ "data-locator": String(attributes["locator"] ?? "") }),
        },
        label: {
          default: "",
          parseHTML: (element) => element.textContent ?? "",
          renderHTML: () => ({}),
        },
      };
    },

    parseHTML() {
      return [{ tag: "span[data-citation]" }];
    },

    renderHTML({ HTMLAttributes, node }) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, { "data-citation": "", class: "citation" }),
        citationLabel(node.attrs as unknown as CitationAttributes, lookup),
      ];
    },

    addNodeView() {
      return ({ node }) => {
        const element = document.createElement("span");
        element.className = "citation";
        element.setAttribute("data-citation", "");
        const attributes = node.attrs as unknown as CitationAttributes;
        element.setAttribute("data-object-id", attributes.objectId);
        element.textContent = citationLabel(attributes, lookup);
        // A citation whose Paper has been deleted must look wrong rather than look fine: an
        // author who cannot see the break will submit the manuscript with it.
        if (lookup.label(attributes.objectId) === null && attributes.label === "") {
          element.classList.add("citation--unresolved");
          element.title = "This citation does not resolve to a Paper in the Library.";
        }
        return { dom: element };
      };
    },
  });
}

/**
 * What a citation shows.
 *
 * The live lookup wins, because the style may have changed since the citation was typed. The
 * stored label is the fallback for a document opened before the bibliography has loaded, which
 * is better than a flash of empty brackets.
 */
export function citationLabel(attributes: CitationAttributes, lookup: CitationLookup): string {
  const live = lookup.label(attributes.objectId);
  if (live !== null) return live;
  if (attributes.label !== "") return attributes.label;
  return "(?)";
}
