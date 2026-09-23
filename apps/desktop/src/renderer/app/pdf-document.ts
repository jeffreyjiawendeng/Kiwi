import type { PdfInfo } from "@kiwi/contracts";

/**
 * The seam between the Reader and PDF.js.
 *
 * PDF.js draws to a canvas, which jsdom does not have, so the Reader talks to this interface
 * instead of importing the library directly. Tests supply a fake; the application supplies
 * `loadPdfDocument`, which is the only place the library is imported.
 */

export interface PdfTextItem {
  text: string;
  /** Position in CSS pixels at scale 1, measured from the top left of the page. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfPage {
  /** Page size in CSS pixels at scale 1. */
  width: number;
  height: number;
  /** Draws this page into the canvas at the given scale. */
  render(canvas: HTMLCanvasElement, scale: number): Promise<void>;
  /** The selectable text, positioned so it can be laid over the drawing. */
  textItems(): Promise<PdfTextItem[]>;
}

export interface PdfOutlineEntry {
  title: string;
  pageNumber: number | null;
  children: PdfOutlineEntry[];
}

export interface PdfDocument {
  pageCount: number;
  /** The label the document gives a page, which is not always its index. */
  pageLabel(pageNumber: number): string;
  page(pageNumber: number): Promise<PdfPage>;
  outline(): Promise<PdfOutlineEntry[]>;
  /**
   * What the file says about itself, under Kiwi's spelling of the names.
   *
   * A missing entry comes back null rather than as an empty string, because a file that states
   * no author and a file that states an empty one are saying the same thing and only one of the
   * two spellings should have to be handled downstream.
   */
  metadata(): Promise<PdfInfo>;
  destroy(): void;
}

export type PdfLoader = (url: string) => Promise<PdfDocument>;

let workerConfigured = false;

/**
 * Loads a document with PDF.js.
 *
 * The worker is bundled rather than fetched: `script-src 'self'` and `worker-src 'self' blob:`
 * forbid pulling it from anywhere else, and a research tool should not need a CDN to open a
 * file that is already on the machine.
 */
export const loadPdfDocument: PdfLoader = async (url) => {
  const pdfjs = await import("pdfjs-dist");
  if (!workerConfigured) {
    const workerUrl = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url);
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.href;
    workerConfigured = true;
  }

  const task = pdfjs.getDocument({ url });
  const document = await task.promise;

  let labels: Array<string | null> | null = null;
  try {
    labels = await document.getPageLabels();
  } catch {
    labels = null;
  }

  return {
    pageCount: document.numPages,
    pageLabel(pageNumber) {
      return labels?.[pageNumber - 1] ?? String(pageNumber);
    },
    async page(pageNumber) {
      const page = await document.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      return {
        width: base.width,
        height: base.height,
        async render(canvas, scale) {
          const viewport = page.getViewport({ scale });
          const context = canvas.getContext("2d");
          if (context === null) return;
          // Drawing at the device pixel ratio and scaling back down with CSS is what keeps
          // small type readable rather than soft.
          const ratio = window.devicePixelRatio || 1;
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.style.width = `${String(Math.floor(viewport.width))}px`;
          canvas.style.height = `${String(Math.floor(viewport.height))}px`;
          context.setTransform(ratio, 0, 0, ratio, 0, 0);
          await page.render({ canvas, canvasContext: context, viewport }).promise;
        },
        async textItems() {
          const content = await page.getTextContent();
          const items: PdfTextItem[] = [];
          for (const item of content.items) {
            if (!("str" in item) || item.str === "") continue;
            // transform is [a, b, c, d, e, f]; e and f are the PDF-space origin of the run,
            // which has its y axis pointing up from the bottom of the page.
            const [a, , , d, e, f] = item.transform as number[];
            const height = Math.abs(d ?? 0) || item.height || 0;
            items.push({
              text: item.str,
              left: e ?? 0,
              top: base.height - (f ?? 0) - height,
              width: item.width || Math.abs(a ?? 0) * item.str.length,
              height,
            });
          }
          return items;
        },
      };
    },
    async outline() {
      const raw = await document.getOutline().catch(() => null);
      if (raw === null) return [];
      const resolve = async (entries: typeof raw): Promise<PdfOutlineEntry[]> => {
        const resolved: PdfOutlineEntry[] = [];
        for (const entry of entries) {
          let pageNumber: number | null = null;
          try {
            const destination =
              typeof entry.dest === "string"
                ? await document.getDestination(entry.dest)
                : entry.dest;
            const reference = Array.isArray(destination) ? destination[0] : null;
            if (reference !== null && typeof reference === "object") {
              pageNumber = (await document.getPageIndex(reference as never)) + 1;
            }
          } catch {
            pageNumber = null;
          }
          resolved.push({
            title: entry.title,
            pageNumber,
            children: entry.items.length > 0 ? await resolve(entry.items) : [],
          });
        }
        return resolved;
      };
      return resolve(raw);
    },
    async metadata() {
      // A file with no info dictionary is ordinary rather than broken; it is read off its first
      // page instead, which is where half of them have to be read anyway.
      const read = await document.getMetadata().catch(() => null);
      const info = (read?.info ?? {}) as Record<string, unknown>;
      const entry = (name: string): string | null => {
        const value = info[name];
        return typeof value === "string" && value.trim() !== "" ? value : null;
      };
      return {
        title: entry("Title"),
        author: entry("Author"),
        subject: entry("Subject"),
        keywords: entry("Keywords"),
        creationDate: entry("CreationDate"),
      };
    },
    destroy() {
      void task.destroy();
    },
  };
};

/** The URL the main process serves an imported file from. */
export function assetUrl(workspaceId: string, assetId: string): string {
  return `kiwi-asset://${encodeURIComponent(workspaceId)}/${encodeURIComponent(assetId)}`;
}

/**
 * The URL the main process serves a picked file from, before anything has imported it.
 *
 * The identifier is the one the file picker handed back, and it is all the renderer has: it says
 * nothing about where the file is, it stops working ten minutes after the file was chosen, and it
 * stops working the moment the import takes it. A file that has been imported has an asset id and
 * belongs at the address above.
 */
export function selectionUrl(selectionId: string): string {
  return `kiwi-selection://pending/${encodeURIComponent(selectionId)}`;
}
