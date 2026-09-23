import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * Raised and lowered text.
 *
 * Research writing cannot do without these: a footnote marker, an ion, a power, a unit. They are
 * marks rather than nodes because they are a property of a stretch of text, and because that is
 * what lets a superscript survive being edited around, typing in front of one does not inherit
 * it, and deleting the word it sits on takes it with the word.
 *
 * The Word exporter already writes both. The two extensions here are what puts them in the
 * document in the first place, by keystroke, by button, and out of a paste.
 */

function verticalMark(name: "superscript" | "subscript") {
  const tag = name === "superscript" ? "sup" : "sub";
  const value = name === "superscript" ? "super" : "sub";
  return Mark.create({
    name,
    // Text cannot be raised and lowered at once. Applying one clears the other rather than
    // producing a run that claims both and renders as neither.
    excludes: "superscript subscript",
    parseHTML() {
      return [
        { tag },
        // Nothing pasted through Kiwi's cleaner still says this, because the cleaner turns the
        // style into the tag. Something dropped in by a script or an older document can.
        {
          style: "vertical-align",
          getAttrs: (style: string | HTMLElement) => (style === value ? {} : false),
        },
      ];
    },
    renderHTML({ HTMLAttributes }) {
      return [tag, mergeAttributes(HTMLAttributes), 0];
    },
    addKeyboardShortcuts() {
      // The shortcuts a person arrives with from a word processor.
      return {
        [name === "superscript" ? "Mod-." : "Mod-,"]: () => this.editor.commands.toggleMark(name),
      };
    },
  });
}

export const Superscript = verticalMark("superscript");
export const Subscript = verticalMark("subscript");
