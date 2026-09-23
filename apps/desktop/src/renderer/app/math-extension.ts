import { Node, mergeAttributes, type CommandProps } from "@tiptap/core";
import { InputRule } from "@tiptap/core";
import katex from "katex";

/**
 * Equations inside the rich editor.
 *
 * A researcher writing in the Google-Docs mode still needs maths, and maths means LaTeX:
 * there is no second notation anyone would accept. So the node holds LaTeX source and renders
 * it with KaTeX, which is the same syntax the LaTeX mode uses. What is typed here would
 * compile there.
 *
 * The source is the truth and the rendering is derived, which is why an equation survives a
 * round trip through the file on disk and turns up in a search.
 */

export interface MathAttributes {
  latex: string;
}

function render(latex: string, display: boolean, into: HTMLElement): void {
  try {
    katex.render(latex, into, {
      displayMode: display,
      throwOnError: false,
      // An unknown command renders in red rather than throwing. A half-written equation is
      // the normal state while typing one, and it must not blank the document.
      errorColor: "#c04b4b",
      strict: false,
      trust: false,
    });
  } catch {
    into.textContent = latex;
  }
}

function mathNode(name: "mathInline" | "mathBlock") {
  const display = name === "mathBlock";
  return Node.create({
    name,
    group: display ? "block" : "inline",
    inline: !display,
    atom: true,
    selectable: true,
    draggable: false,

    addAttributes() {
      return {
        latex: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-latex") ?? "",
          renderHTML: (attributes) => ({ "data-latex": String(attributes["latex"] ?? "") }),
        },
      };
    },

    parseHTML() {
      return [{ tag: `span[data-math="${name}"]` }];
    },

    renderHTML({ HTMLAttributes }) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, { "data-math": name, class: `math math--${name}` }),
      ];
    },

    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement("span");
        dom.className = `math math--${name}`;
        dom.setAttribute("data-math", name);
        // KaTeX emits its own MathML element carrying role="math", so the wrapper is found
        // by a test id rather than by a role that would then be ambiguous.
        dom.setAttribute("data-testid", "math-node");

        const view = document.createElement("span");
        view.className = "math__rendered";
        const input = document.createElement("input");
        input.className = "math__source";
        input.setAttribute("aria-label", display ? "Display equation" : "Inline equation");
        input.value = String(node.attrs["latex"] ?? "");
        input.hidden = true;

        const paint = (latex: string): void => {
          if (latex.trim() === "") {
            view.textContent = display ? "Empty equation" : "equation";
            view.classList.add("math__rendered--empty");
            return;
          }
          view.classList.remove("math__rendered--empty");
          render(latex, display, view);
        };
        paint(input.value);

        function openEditor(): void {
          if (!editor.isEditable) return;
          input.hidden = false;
          view.hidden = true;
          input.focus();
          input.select();
        }

        function closeEditor(): void {
          input.hidden = true;
          view.hidden = false;
          paint(input.value);
          const position = typeof getPos === "function" ? getPos() : null;
          if (position === null || position === undefined) return;
          editor.view.dispatch(
            editor.view.state.tr.setNodeMarkup(position, undefined, { latex: input.value }),
          );
        }

        view.addEventListener("click", openEditor);
        input.addEventListener("blur", closeEditor);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            closeEditor();
            editor.commands.focus();
          }
        });
        // Typing in the field must not reach the document underneath.
        input.addEventListener("keyup", (event) => event.stopPropagation());

        dom.append(view, input);
        return {
          dom,
          update(updated) {
            if (updated.type.name !== name) return false;
            const latex = String(updated.attrs["latex"] ?? "");
            if (input.hidden) {
              input.value = latex;
              paint(latex);
            }
            return true;
          },
          ignoreMutation: () => true,
        };
      };
    },

    addInputRules() {
      return [
        new InputRule({
          // `$$ ` opens a display equation, `$x$` an inline one. Both are what someone who
          // writes LaTeX already types without being told to.
          find: display ? /\$\$$/u : /\$([^$]+)\$$/u,
          handler: ({ state, range, match }) => {
            const latex = display ? "" : (match[1] ?? "");
            state.tr.replaceWith(range.from, range.to, state.schema.nodes[name]!.create({ latex }));
          },
        }),
      ];
    },

    addCommands() {
      return {
        [display ? "insertMathBlock" : "insertMathInline"]:
          (latex = "") =>
          ({ chain }: CommandProps) =>
            chain().focus().insertContent({ type: name, attrs: { latex } }).run(),
      } as never;
    },
  });
}

export const MathInline = mathNode("mathInline");
export const MathBlock = mathNode("mathBlock");
