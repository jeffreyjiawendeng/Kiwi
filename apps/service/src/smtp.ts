import { connect as connectPlain } from "node:net";
import { connect as connectTls } from "node:tls";
import type { Duplex } from "node:stream";

export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
}

export interface SmtpTransport {
  send(message: SmtpMessage): Promise<void>;
}

/**
 * How the session reaches an encrypted channel.
 *
 * `implicit` negotiates TLS before the greeting, which is what port 465 expects.
 * `starttls` opens in the clear and upgrades before authenticating, which is what the
 * submission port 587 expects. Some providers offer only one of the two, so the transport
 * has to speak both. Nothing secret is ever sent before the upgrade completes.
 */
export type SmtpSecurity = "implicit" | "starttls";

export interface SmtpTransportOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  security?: SmtpSecurity;
  connect?: (host: string, port: number, security: SmtpSecurity) => Promise<Duplex>;
  upgrade?: (socket: Duplex, host: string) => Promise<Duplex>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const IMPLICIT_TLS_PORT = 465;

// Port 465 is assigned to implicit TLS. Every other submission port begins in the clear
// and has to be upgraded, so that is the safer assumption for an unrecognised port.
export function defaultSmtpSecurity(port: number): SmtpSecurity {
  return port === IMPLICIT_TLS_PORT ? "implicit" : "starttls";
}

// A header value carrying CR or LF would let a caller append headers of its own.
function assertHeaderSafe(value: string, field: string): void {
  if (/[\r\n\0]/u.test(value) || value.length > 998) {
    throw new Error(`The ${field} value is not valid for an email header.`);
  }
}

function encodeSubject(subject: string): string {
  return /^[\x20-\x7e]*$/u.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

// RFC 5321 requires a line that begins with a period to be sent with the period doubled,
// because a bare period on its own line ends the message.
function dotStuff(body: string): string {
  return body
    .split(/\r?\n/u)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

interface SmtpReply {
  code: number;
  text: string;
  // Every line of a multi-line reply, without its status code. An EHLO reply carries the
  // server's capabilities here, and those decide whether the session can proceed.
  lines: string[];
}

class SmtpConversation {
  private buffer = "";
  private partial: string[] = [];
  private pending: ((reply: SmtpReply | Error) => void) | null = null;
  private failure: Error | null = null;
  private readonly replies: SmtpReply[] = [];
  private readonly onData = (chunk: string): void => this.receive(chunk);
  private readonly onError = (cause: Error): void => this.fail(cause);
  private readonly onClose = (): void =>
    this.fail(new Error("The mail server closed the connection."));

  constructor(private readonly socket: Duplex) {
    socket.setEncoding("utf8");
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  // A STARTTLS upgrade moves the session onto a new socket. The conversation that read the
  // plaintext greeting has to stop reading first, or both would consume the same stream.
  detach(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
  }

  private fail(cause: Error): void {
    this.failure ??= cause;
    const waiting = this.pending;
    this.pending = null;
    waiting?.(this.failure);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      // A hyphen in the fourth column marks a continuation of a multi-line reply.
      if (line.length >= 4 && line[3] === "-") {
        this.partial.push(line.slice(4));
        continue;
      }
      const code = Number.parseInt(line.slice(0, 3), 10);
      const reply: SmtpReply = {
        code,
        text: line.slice(4),
        lines: [...this.partial, line.slice(4)],
      };
      this.partial = [];
      const waiting = this.pending;
      if (waiting === null) this.replies.push(reply);
      else {
        this.pending = null;
        waiting(reply);
      }
    }
  }

  async expect(accepted: readonly number[], step: string): Promise<SmtpReply> {
    const reply = await new Promise<SmtpReply | Error>((resolve) => {
      if (this.failure !== null) {
        resolve(this.failure);
        return;
      }
      const queued = this.replies.shift();
      if (queued !== undefined) {
        resolve(queued);
        return;
      }
      this.pending = resolve;
    });
    if (reply instanceof Error) throw reply;
    if (!accepted.includes(reply.code)) {
      throw new Error(`The mail server rejected ${step} with status ${String(reply.code)}.`);
    }
    return reply;
  }

  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }
}

function openSocket(host: string, port: number, security: SmtpSecurity): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket =
      security === "implicit"
        ? connectTls({ host, port, servername: host }, () => {
            socket.off("error", reject);
            resolve(socket);
          })
        : connectPlain({ host, port }, () => {
            socket.off("error", reject);
            resolve(socket);
          });
    socket.once("error", reject);
  });
}

function upgradeSocket(socket: Duplex, host: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    // The plaintext socket becomes the transport for the TLS session. The certificate is
    // verified against the configured hostname, so an intercepted upgrade fails here.
    const secured = connectTls({ socket, servername: host }, () => {
      secured.off("error", reject);
      resolve(secured);
    });
    secured.once("error", reject);
  });
}

function capabilities(lines: readonly string[]): Set<string> {
  return new Set(lines.map((line) => line.trim().toUpperCase()));
}

function supports(advertised: Set<string>, capability: string): boolean {
  for (const line of advertised) {
    if (line === capability || line.startsWith(`${capability} `)) return true;
  }
  return false;
}

function authMechanisms(advertised: Set<string>): Set<string> {
  for (const line of advertised) {
    if (line === "AUTH" || line.startsWith("AUTH ")) {
      return new Set(line.slice(4).trim().split(/\s+/u).filter(Boolean));
    }
  }
  return new Set();
}

export function createSmtpTransport(options: SmtpTransportOptions): SmtpTransport {
  const security = options.security ?? defaultSmtpSecurity(options.port);
  const open = options.connect ?? openSocket;
  const upgrade = options.upgrade ?? upgradeSocket;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async send(message): Promise<void> {
      assertHeaderSafe(message.from, "from address");
      assertHeaderSafe(message.to, "recipient address");
      assertHeaderSafe(message.subject, "subject");

      let socket = await open(options.host, options.port, security);
      let conversation = new SmtpConversation(socket);
      let deadline = setTimeout(() => socket.destroy(), timeoutMs);
      try {
        await conversation.expect([220], "the connection");
        conversation.write("EHLO kiwi");
        let advertised = capabilities((await conversation.expect([250], "EHLO")).lines);

        if (security === "starttls") {
          if (!supports(advertised, "STARTTLS")) {
            // Continuing would mean sending the password in the clear. Refusing is the
            // only safe answer, and it names the misconfiguration plainly.
            throw new Error(
              "The mail server does not offer STARTTLS, so the password cannot be sent safely. Use the implicit TLS port instead.",
            );
          }
          conversation.write("STARTTLS");
          await conversation.expect([220], "STARTTLS");
          conversation.detach();
          clearTimeout(deadline);
          socket = await upgrade(socket, options.host);
          conversation = new SmtpConversation(socket);
          deadline = setTimeout(() => socket.destroy(), timeoutMs);
          // The capabilities offered in the clear are not trustworthy and are replaced by
          // the ones the server states over the encrypted channel.
          conversation.write("EHLO kiwi");
          advertised = capabilities(
            (await conversation.expect([250], "EHLO after STARTTLS")).lines,
          );
        }

        const mechanisms = authMechanisms(advertised);
        if (mechanisms.size > 0 && !mechanisms.has("PLAIN") && !mechanisms.has("LOGIN")) {
          throw new Error(
            "The mail server offers no authentication mechanism Kiwi can use. PLAIN or LOGIN is required.",
          );
        }
        if (mechanisms.has("LOGIN") && !mechanisms.has("PLAIN")) {
          conversation.write("AUTH LOGIN");
          await conversation.expect([334], "authentication");
          conversation.write(Buffer.from(options.username, "utf8").toString("base64"));
          await conversation.expect([334], "the account name");
          conversation.write(Buffer.from(options.password, "utf8").toString("base64"));
          await conversation.expect([235], "authentication");
        } else {
          const credential = Buffer.from(
            `\0${options.username}\0${options.password}`,
            "utf8",
          ).toString("base64");
          conversation.write(`AUTH PLAIN ${credential}`);
          await conversation.expect([235], "authentication");
        }

        conversation.write(`MAIL FROM:<${message.from}>`);
        await conversation.expect([250], "the sender address");
        conversation.write(`RCPT TO:<${message.to}>`);
        await conversation.expect([250, 251], "the recipient address");
        conversation.write("DATA");
        await conversation.expect([354], "the message body");

        const headers = [
          `From: ${message.from}`,
          `To: ${message.to}`,
          `Subject: ${encodeSubject(message.subject)}`,
          `Date: ${new Date().toUTCString()}`,
          "MIME-Version: 1.0",
          'Content-Type: text/plain; charset="utf-8"',
          "Content-Transfer-Encoding: 8bit",
          "Auto-Submitted: auto-generated",
        ].join("\r\n");
        socket.write(`${headers}\r\n\r\n${dotStuff(message.body)}\r\n.\r\n`);
        await conversation.expect([250], "the delivered message");
        conversation.write("QUIT");
      } finally {
        clearTimeout(deadline);
        socket.destroy();
      }
    },
  };
}
