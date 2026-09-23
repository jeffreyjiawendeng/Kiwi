import { useEffect } from "react";

/**
 * What a window calls itself.
 *
 * Every Kiwi window loads the same page, so every one of them is titled "Kiwi". That is fine until
 * there are three. A window is detached in order to be put somewhere -- a second monitor, the other
 * half of this one, a taskbar button to come back to -- and three identical entries are picked
 * between by opening them one at a time until the right one comes forward.
 *
 * So a window opened to show one thing says which thing. The application's name stays on the end:
 * the entry is still a Kiwi window, and on Windows the taskbar groups them under that name.
 */

export const APPLICATION_TITLE = "Kiwi";

export function windowTitle(name: string | null): string {
  const trimmed = (name ?? "").trim();
  // An untitled note is not called "Untitled - Kiwi". Nothing is gained by naming a window after
  // the fact that it has no name, and the application's own name is the honest fallback.
  //
  // The separator is the hyphen every Windows application uses in a title bar, as in
  // "notes.txt - Notepad".
  return trimmed === "" ? APPLICATION_TITLE : `${trimmed} - ${APPLICATION_TITLE}`;
}

/** Names this window after what it shows, and gives the name back when it stops showing it. */
export function useWindowTitle(name: string | null): void {
  useEffect(() => {
    document.title = windowTitle(name);
    return () => {
      document.title = APPLICATION_TITLE;
    };
  }, [name]);
}
