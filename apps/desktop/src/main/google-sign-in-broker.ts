import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AccountAuthResult,
  AccountRegistrationProfile,
  SignInProvider,
} from "@kiwi/contracts";
import type { AccountServiceClient, IdentityMode } from "./account-service-client.js";

interface CallbackSuccess {
  status: "code";
  code: string;
}

interface CallbackFailure {
  status: "error";
  code: "provider_cancelled" | "provider_denied" | "invalid_callback";
  message: string;
}

type CallbackResult = CallbackSuccess | CallbackFailure;

interface PendingGoogleSignIn {
  server: Server;
  finish(result: CallbackResult): void;
  cancelled: boolean;
}

export interface ProviderSignInRequest {
  provider: SignInProvider;
  mode: IdentityMode;
  registrationProfile?: AccountRegistrationProfile;
}

export interface GoogleSignInBroker {
  start(request?: ProviderSignInRequest): Promise<AccountAuthResult>;
  cancel(): boolean;
  pending(): boolean;
}

export interface GoogleSignInBrokerOptions {
  accountService: AccountServiceClient;
  openExternal(url: string): Promise<void>;
  timeoutMs?: number;
  randomToken?: () => string;
}

const CALLBACK_STYLE = `
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2rem;
        background: #f6f8f5;
        color: #182019;
        font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        font-size: 14px;
      }
      main { max-width: 26rem; text-align: center; }
      h1 {
        margin: 0;
        font-size: 1.25rem;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: #2f713d;
      }
      h1.problem { color: #c42b1c; }
      p { margin: 0.5rem 0 0; line-height: 1.5; color: #657066; }
      @media (prefers-color-scheme: dark) {
        body { background: #151a16; color: #edf3ed; }
        h1 { color: #63a96f; }
        h1.problem { color: #e88b82; }
        p { color: #aab6ab; }
      }
      @media (forced-colors: active) {
        body { forced-color-adjust: none; background: Canvas; color: CanvasText; }
        h1, h1.problem, p { color: CanvasText; }
      }
    `;

const CALLBACK_STYLE_HASH = createHash("sha256").update(CALLBACK_STYLE, "utf8").digest("base64");

function callbackPage(title: string, heading: string, detail: string, problem = false): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>${CALLBACK_STYLE}</style>
  </head>
  <body>
    <main>
      <h1${problem ? ' class="problem"' : ""}>${heading}</h1>
      <p>${detail}</p>
    </main>
  </body>
</html>
`;
}

const SIGNED_IN_PAGE = callbackPage(
  "Return to Kiwi",
  "You are signed in",
  "You can close this page and return to Kiwi.",
);

const IDENTITY_CONFIRMED_PAGE = callbackPage(
  "Return to Kiwi",
  "Identity confirmed",
  "You can close this page and return to Kiwi to continue.",
);

const DENIED_PAGE = callbackPage(
  "Return to Kiwi",
  "Sign-in was not approved",
  "You can close this page and return to Kiwi.",
  true,
);

const MISMATCHED_PAGE = callbackPage(
  "Return to Kiwi",
  "This response did not match",
  "The sign-in response did not match this request. Close this page and start again in Kiwi.",
  true,
);

const INCOMPLETE_PAGE = callbackPage(
  "Return to Kiwi",
  "This response was incomplete",
  "The sign-in response was incomplete. Close this page and start again in Kiwi.",
  true,
);

const NOT_FOUND_PAGE = callbackPage("Not found", "Not found", "You can close this page.", true);

const INVALID_PAGE = callbackPage(
  "Invalid request",
  "Invalid request",
  "You can close this page.",
  true,
);

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function writeCallback(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'sha256-${CALLBACK_STYLE_HASH}'`,
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function close(server: Server): void {
  if (server.listening) server.close();
}

export function createGoogleSignInBroker(options: GoogleSignInBrokerOptions): GoogleSignInBroker {
  const timeoutMs = options.timeoutMs ?? 2 * 60 * 1_000;
  const nextToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  let active: PendingGoogleSignIn | null = null;

  return {
    async start(
      request = { provider: "google", mode: "sign_in" } as const,
    ): Promise<AccountAuthResult> {
      if (active !== null) {
        return {
          status: "error",
          code: "invalid_callback",
          message: "A sign-in is already in progress.",
        };
      }

      const state = nextToken();
      const nonce = nextToken();
      const codeVerifier = `${nextToken()}${nextToken()}`.slice(0, 128);
      const codeChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
      const callbackPath = `/oauth/callback/${nextToken()}`;
      let settle!: (result: CallbackResult) => void;
      const callback = new Promise<CallbackResult>((resolve) => {
        settle = resolve;
      });
      let settled = false;
      const finish = (result: CallbackResult): void => {
        if (settled) return;
        settled = true;
        settle(result);
      };
      let expectedHost = "";
      const server = createServer((incoming, response) => {
        let url: URL;
        try {
          url = new URL(incoming.url ?? "", "http://127.0.0.1");
        } catch {
          writeCallback(response, 400, INVALID_PAGE);
          return;
        }
        if (
          incoming.method !== "GET" ||
          incoming.headers.host !== expectedHost ||
          url.pathname !== callbackPath
        ) {
          writeCallback(response, 404, NOT_FOUND_PAGE);
          return;
        }
        const returnedState = url.searchParams.get("state");
        if (returnedState === null || !sameSecret(returnedState, state)) {
          writeCallback(response, 400, MISMATCHED_PAGE);
          return;
        }
        const providerError = url.searchParams.get("error");
        if (providerError !== null) {
          writeCallback(
            response,
            200,
            providerError === "access_denied" ? DENIED_PAGE : MISMATCHED_PAGE,
          );
          finish({
            status: "error",
            code: providerError === "access_denied" ? "provider_denied" : "invalid_callback",
            message:
              providerError === "access_denied"
                ? "Sign-in was not approved."
                : "The provider returned an invalid response.",
          });
          return;
        }
        const code = url.searchParams.get("code");
        if (code === null || code === "" || code.length > 512) {
          writeCallback(response, 400, INCOMPLETE_PAGE);
          finish({
            status: "error",
            code: "invalid_callback",
            message: "The provider returned an invalid response.",
          });
          return;
        }
        writeCallback(
          response,
          200,
          request.mode === "reauthenticate" ? IDENTITY_CONFIRMED_PAGE : SIGNED_IN_PAGE,
        );
        finish({ status: "code", code });
      });
      active = { server, finish, cancelled: false };

      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        const address = server.address() as AddressInfo;
        expectedHost = `127.0.0.1:${address.port}`;
        const redirectUri = `http://${expectedHost}${callbackPath}`;
        if (active.cancelled) {
          return {
            status: "error",
            code: "provider_cancelled",
            message: "Sign-in was canceled.",
          };
        }

        const started = await options.accountService.startIdentity(
          {
            provider: request.provider,
            ...(request.registrationProfile === undefined
              ? {}
              : { registration_profile: request.registrationProfile }),
            redirect_uri: redirectUri,
            state,
            nonce,
            code_challenge: codeChallenge,
          },
          request.mode,
        );
        if (started.status === "error") return started;
        if (active.cancelled) {
          return {
            status: "error",
            code: "provider_cancelled",
            message: "Sign-in was canceled.",
          };
        }
        try {
          await options.openExternal(started.authorization_url);
        } catch {
          return {
            status: "error",
            code: "invalid_callback",
            message: "Kiwi could not open the system browser.",
          };
        }

        const timer = setTimeout(
          () =>
            finish({
              status: "error",
              code: "invalid_callback",
              message: "Sign-in timed out. Try again.",
            }),
          timeoutMs,
        );
        const returned = await callback.finally(() => clearTimeout(timer));
        if (returned.status === "error") return returned;
        return options.accountService.exchangeIdentity(
          {
            provider: request.provider,
            ...(request.registrationProfile === undefined
              ? {}
              : { registration_profile: request.registrationProfile }),
            redirect_uri: redirectUri,
            state,
            nonce,
            code_challenge: codeChallenge,
            code: returned.code,
            code_verifier: codeVerifier,
          },
          request.mode,
        );
      } finally {
        close(server);
        active = null;
      }
    },

    cancel(): boolean {
      if (active === null) return false;
      active.cancelled = true;
      active.finish({
        status: "error",
        code: "provider_cancelled",
        message: "Sign-in was canceled.",
      });
      close(active.server);
      return true;
    },

    pending(): boolean {
      return active !== null;
    },
  };
}
