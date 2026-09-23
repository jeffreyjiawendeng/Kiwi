import type { BrowserWindowConstructorOptions, Session, WebContents } from "electron";

export const APP_SCHEME = "kiwi-app";
export const APP_ORIGIN = `${APP_SCHEME}://kiwi`;

// The two schemes the main process serves a document from: one for a file already imported, one
// for a file only just picked and still being reviewed. Named once because the development policy
// has to add to this list rather than replace it.
const CONNECT_SOURCES = "kiwi-asset: kiwi-selection:";

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  /*
    Style attributes on elements, and nothing else about styling, are allowed inline.

    PDF.js positions a page's text layer by writing a style attribute on it. Under `style-src
    'self'` alone Chromium refuses that write, and a document rendered with every text span at the
    origin is a document nobody can read or select from. This directive covers attributes only:
    stylesheets and `<style>` elements still have to come from the application itself, so nothing
    a document carries can style the window.
  */
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob: kiwi-asset:",
  "font-src 'self'",
  // PDF.js fetches the document itself. Those bytes come from the main process rather than from
  // the network, which is why nothing else is permitted here.
  `connect-src ${CONNECT_SOURCES}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
];

export const PRODUCTION_CSP = CSP_DIRECTIVES.join("; ");

// The Vite dev server reaches the renderer over HTTP and a same-origin HMR socket, which the
// production connect-src forbids. Only that directive changes; every privilege boundary stays
// identical to production.
export const DEVELOPMENT_CSP = CSP_DIRECTIVES.map((directive) =>
  directive === `connect-src ${CONNECT_SOURCES}`
    ? `connect-src 'self' ${CONNECT_SOURCES}`
    : directive,
).join("; ");

export function contentSecurityPolicy(isDevelopment: boolean): string {
  return isDevelopment ? DEVELOPMENT_CSP : PRODUCTION_CSP;
}

export function researchWindowOptions(
  preloadPath: string,
  dark = true,
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: dark ? "#1b1b1b" : "#f3f3f3",
    title: "Kiwi",
    // Kiwi draws the complete title bar. Window actions remain narrow, validated IPC calls;
    // the renderer never receives direct BrowserWindow access.
    frame: false,
    thickFrame: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
    },
  };
}

export function isAllowedNavigation(target: string, devServerOrigin: string | null): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol === `${APP_SCHEME}:`) return true;
  if (devServerOrigin !== null && url.origin === devServerOrigin) return true;
  return false;
}

export function hardenWebContents(contents: WebContents, devServerOrigin: string | null): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));

  contents.on("will-navigate", (event, target) => {
    if (!isAllowedNavigation(target, devServerOrigin)) {
      event.preventDefault();
    }
  });

  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

export function hardenSession(session: Session, isDevelopment: boolean): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });

  session.setPermissionCheckHandler(() => false);

  session.setDevicePermissionHandler(() => false);

  session.on("will-download", (event) => {
    event.preventDefault();
  });

  const policy = contentSecurityPolicy(isDevelopment);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}
