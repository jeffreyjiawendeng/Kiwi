import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { createSmtpTransport } from "./smtp.js";

const MESSAGE = {
  from: "kiwi@example.test",
  to: "researcher@example.test",
  subject: "Verify your Kiwi email address",
  body: "Enter this code in Kiwi:\n\n    ABCD-2345\n",
};

class FakeServer extends Duplex {
  readonly written: string[] = [];
  private readonly replies: string[];

  constructor(replies: string[]) {
    super({ decodeStrings: false });
    this.replies = [...replies];
    queueMicrotask(() => this.reply());
  }

  private reply(): void {
    const next = this.replies.shift();
    if (next !== undefined) this.push(next);
  }

  override _read(): void {
    // Replies are pushed in response to client commands.
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error) => void,
  ): void {
    this.written.push(chunk.toString());
    queueMicrotask(() => this.reply());
    done();
  }
}

function transportFor(replies: string[]) {
  let server: FakeServer | undefined;
  const transport = createSmtpTransport({
    host: "mail.example.test",
    port: 465,
    username: "kiwi",
    password: "a mail password",
    connect: async () => {
      server = new FakeServer(replies);
      return server;
    },
  });
  return { transport, server: (): FakeServer => server as FakeServer };
}

const ACCEPTING = [
  "220 mail.example.test ready\r\n",
  "250-mail.example.test\r\n250 AUTH PLAIN\r\n",
  "235 authenticated\r\n",
  "250 sender ok\r\n",
  "250 recipient ok\r\n",
  "354 send the message\r\n",
  "250 queued\r\n",
  "221 bye\r\n",
];

describe("SMTP submission", () => {
  it("authenticates and delivers one message over the established connection", async () => {
    const { transport, server } = transportFor(ACCEPTING);
    await transport.send(MESSAGE);
    const sent = server().written.join("");

    expect(sent).toContain("EHLO kiwi\r\n");
    expect(sent).toContain("MAIL FROM:<kiwi@example.test>\r\n");
    expect(sent).toContain("RCPT TO:<researcher@example.test>\r\n");
    expect(sent).toContain("Subject: Verify your Kiwi email address\r\n");
    expect(sent).toContain("ABCD-2345");
    expect(sent.endsWith("QUIT\r\n")).toBe(true);
    expect(sent).toMatch(/\r\n\.\r\n/u);
  });

  it("sends the credential only inside the AUTH command", async () => {
    const { transport, server } = transportFor(ACCEPTING);
    await transport.send(MESSAGE);
    const sent = server().written.join("");
    const credential = Buffer.from("\0kiwi\0a mail password", "utf8").toString("base64");

    expect(sent).toContain(`AUTH PLAIN ${credential}\r\n`);
    expect(sent).not.toContain("a mail password");
  });

  it("reads a multi-line greeting without treating a continuation as the reply", async () => {
    const { transport } = transportFor([
      "220-mail.example.test\r\n220 ready\r\n",
      ...ACCEPTING.slice(1),
    ]);
    await expect(transport.send(MESSAGE)).resolves.toBeUndefined();
  });

  it("reports the step a mail server rejected", async () => {
    const { transport } = transportFor([
      "220 ready\r\n",
      "250 ok\r\n",
      "535 bad credential\r\n",
      "221 bye\r\n",
    ]);
    await expect(transport.send(MESSAGE)).rejects.toThrow(/authentication with status 535/iu);
  });

  it("refuses an address or subject that would inject another header", async () => {
    const { transport } = transportFor(ACCEPTING);
    await expect(
      transport.send({ ...MESSAGE, to: "victim@example.test\r\nBcc: other@example.test" }),
    ).rejects.toThrow(/recipient address/iu);
    await expect(transport.send({ ...MESSAGE, subject: "Hello\nBcc: other" })).rejects.toThrow(
      /subject/iu,
    );
  });

  it("doubles a leading period so a message line cannot end the message", async () => {
    const { transport, server } = transportFor(ACCEPTING);
    await transport.send({ ...MESSAGE, body: "safe\n. not the end\nlast" });
    expect(server().written.join("")).toContain("safe\r\n.. not the end\r\nlast\r\n.\r\n");
  });

  it("encodes a subject that is not plain ASCII", async () => {
    const { transport, server } = transportFor(ACCEPTING);
    await transport.send({ ...MESSAGE, subject: "Kód pro Kiwi" });
    expect(server().written.join("")).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("Kód pro Kiwi", "utf8").toString("base64")}?=`,
    );
  });
  it("upgrades an unencrypted submission port before authenticating", async () => {
    // Port 587 opens in the clear. Nothing secret may be written until STARTTLS completes.
    const plain = new FakeServer([
      "220 mail.example.test ready\r\n",
      "250-mail.example.test\r\n250 STARTTLS\r\n",
      "220 ready to start TLS\r\n",
    ]);
    let secured: FakeServer | undefined;
    const transport = createSmtpTransport({
      host: "mail.example.test",
      port: 587,
      username: "kiwi",
      password: "a mail password",
      connect: async () => plain,
      upgrade: async () => {
        secured = new FakeServer([
          "250-mail.example.test\r\n250 AUTH PLAIN\r\n",
          "235 authenticated\r\n",
          "250 sender ok\r\n",
          "250 recipient ok\r\n",
          "354 send the message\r\n",
          "250 queued\r\n",
          "221 bye\r\n",
        ]);
        return secured;
      },
    });

    await transport.send(MESSAGE);

    const beforeUpgrade = plain.written.join("");
    expect(beforeUpgrade).toContain("STARTTLS\r\n");
    expect(beforeUpgrade).not.toContain("AUTH");
    expect(beforeUpgrade).not.toContain("a mail password");

    const afterUpgrade = (secured as FakeServer).written.join("");
    expect(afterUpgrade).toContain("EHLO kiwi\r\n");
    expect(afterUpgrade).toContain("AUTH PLAIN ");
    expect(afterUpgrade).toContain("ABCD-2345");
  });

  it("refuses to authenticate when a plaintext server does not offer STARTTLS", async () => {
    const plain = new FakeServer([
      "220 mail.example.test ready\r\n",
      "250-mail.example.test\r\n250 AUTH PLAIN\r\n",
    ]);
    const transport = createSmtpTransport({
      host: "mail.example.test",
      port: 587,
      username: "kiwi",
      password: "a mail password",
      connect: async () => plain,
      upgrade: async () => {
        throw new Error("The upgrade must not be attempted.");
      },
    });

    // Sending the password in the clear is never the fallback for a missing upgrade.
    await expect(transport.send(MESSAGE)).rejects.toThrow(/does not offer STARTTLS/u);
    expect(plain.written.join("")).not.toContain("AUTH");
  });

  it("authenticates with LOGIN when the server offers no PLAIN mechanism", async () => {
    const { transport, server } = transportFor([
      "220 mail.example.test ready\r\n",
      "250-mail.example.test\r\n250 AUTH LOGIN CRAM-MD5\r\n",
      "334 VXNlcm5hbWU6\r\n",
      "334 UGFzc3dvcmQ6\r\n",
      "235 authenticated\r\n",
      "250 sender ok\r\n",
      "250 recipient ok\r\n",
      "354 send the message\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ]);

    await transport.send(MESSAGE);
    const sent = server().written.join("");

    expect(sent).toContain("AUTH LOGIN\r\n");
    expect(sent).toContain(`${Buffer.from("kiwi", "utf8").toString("base64")}\r\n`);
    expect(sent).toContain(`${Buffer.from("a mail password", "utf8").toString("base64")}\r\n`);
    expect(sent).not.toContain("a mail password");
  });

  it("refuses a server that offers no mechanism it can use", async () => {
    const { transport } = transportFor([
      "220 mail.example.test ready\r\n",
      "250-mail.example.test\r\n250 AUTH GSSAPI CRAM-MD5\r\n",
    ]);

    await expect(transport.send(MESSAGE)).rejects.toThrow(/no authentication mechanism/u);
  });

  it("reads every capability of a multi-line greeting, not only its last line", async () => {
    const { transport, server } = transportFor([
      "220 mail.example.test ready\r\n",
      "250-mail.example.test\r\n250-PIPELINING\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n",
      "235 authenticated\r\n",
      "250 sender ok\r\n",
      "250 recipient ok\r\n",
      "354 send the message\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ]);

    // AUTH is advertised in the middle of the reply, so a parser that keeps only the final
    // line would find no mechanism at all.
    await transport.send(MESSAGE);
    expect(server().written.join("")).toContain("AUTH PLAIN ");
  });
});
