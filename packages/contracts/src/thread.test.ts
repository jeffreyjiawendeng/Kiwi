import { describe, expect, it } from "vitest";
import {
  compareThreadMessages,
  isThreadAnchorKind,
  mentionPlainText,
  mergeThreadMessages,
  parseMentions,
  readThread,
  reanchorThread,
  replyToThread,
  resolveThreadAnchor,
  startThread,
  threadContent,
  threadTitle,
  validateThread,
  withResolvedAnchor,
  withThreadMessages,
  type ThreadAnchor,
  type ThreadMessage,
} from "./thread.js";

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "m1",
    author_id: "ada",
    author_name: "Ada Lovelace",
    body: "This paragraph contradicts figure 2.",
    created_at: "2026-08-26T10:00:00.000Z",
    edited_at: null,
    ...overrides,
  };
}

const QUOTE = "the effect was larger in the second cohort";

const passage: ThreadAnchor = {
  object_id: "manuscript-1",
  kind: "text_range",
  from: 40,
  to: 96,
  quote: QUOTE,
};

/** An anchor on the passage as it sits in this text, the way the editor would record it. */
function anchoredIn(text: string): ThreadAnchor {
  const from = text.indexOf(QUOTE);
  return {
    object_id: "manuscript-1",
    kind: "text_range",
    from,
    to: from + QUOTE.length,
    quote: QUOTE,
  };
}

function span(text: string, resolution: { from: number | null; to: number | null }): string {
  return text.slice(resolution.from ?? 0, resolution.to ?? 0);
}

describe("what a thread is attached to", () => {
  it("takes only the four kinds of anchor", () => {
    expect(isThreadAnchorKind("text_range")).toBe(true);
    expect(isThreadAnchorKind("paragraph")).toBe(false);
  });

  it("refuses a comment on a passage with no passage", () => {
    // A text_range with no positions would anchor to the top of the document and read as a
    // comment on the title, which is not where anybody put it.
    const thread = startThread({ object_id: "manuscript-1", kind: "text_range" }, message());
    expect(validateThread(thread).map((problem) => problem.field)).toContain("anchor");
  });

  it("refuses a comment on nothing", () => {
    const thread = startThread({ object_id: "  ", kind: "object" }, message());
    expect(validateThread(thread)).toHaveLength(1);
  });

  it("accepts a comment on a passage", () => {
    expect(validateThread(startThread(passage, message()))).toEqual([]);
  });
});

describe("the fields stored twice", () => {
  it("derives the participants from the messages", () => {
    // The inbox asks "which threads am I in" without opening every message of every thread, so
    // the answer is stored on the thread. It is only ever derived here.
    const thread = replyToThread(
      startThread(passage, message()),
      message({ id: "m2", author_id: "grace", author_name: "Grace Hopper", body: "Agreed." }),
    );
    expect(thread.participants).toEqual(["ada", "grace"]);
  });

  it("does not repeat a participant who replies twice", () => {
    const thread = replyToThread(
      startThread(passage, message()),
      message({ id: "m2", body: "Or figure 3." }),
    );
    expect(thread.participants).toEqual(["ada"]);
  });

  it("derives the mentions from every message", () => {
    const thread = replyToThread(
      startThread(passage, message({ body: "@[Grace Hopper](user:grace) is this right?" })),
      message({ id: "m2", body: "Ask @[Grace Hopper](user:grace) and @[Alan](user:alan)." }),
    );
    expect(thread.mentions).toEqual(["grace", "alan"]);
  });

  it("recomputes both when a stored thread disagrees with its own messages", () => {
    // A file written by an older build, or merged by another machine, is not a reason to show a
    // thread with a participant who never wrote in it.
    const thread = readThread({
      anchor: passage,
      status: "open",
      resolved_by: null,
      resolved_at: null,
      messages: [message()],
      participants: ["ada", "someone-who-left"],
      mentions: ["nobody"],
    });
    expect(thread?.participants).toEqual(["ada"]);
    expect(thread?.mentions).toEqual([]);
  });
});

describe("mentions", () => {
  it("reads the account id, not the name", () => {
    // The name is what renders; the id is what a notification is sent to, so a renamed account
    // still reaches the right person.
    expect(parseMentions("morning @[Ada Lovelace](user:ada-1)")).toEqual(["ada-1"]);
  });

  it("ignores an @ that is not a mention", () => {
    expect(parseMentions("write to ada@example.org")).toEqual([]);
  });

  it("renders as a person reads it", () => {
    expect(mentionPlainText("ask @[Ada Lovelace](user:ada-1) first")).toBe(
      "ask @Ada Lovelace first",
    );
  });
});

describe("the order of a conversation", () => {
  it("orders by the id when two replies share a second", () => {
    const early = message({ id: "b" });
    const late = message({ id: "a" });
    // Two machines must agree on the order, and a clock to the millisecond does not settle it.
    expect(compareThreadMessages(early, late)).toBeGreaterThan(0);
  });

  it("sorts a list given out of order", () => {
    const thread = withThreadMessages(startThread(passage, message()), [
      message({ id: "m2", created_at: "2026-08-26T11:00:00.000Z" }),
      message({ id: "m1" }),
    ]);
    expect(thread.messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);
  });
});

describe("two machines that both replied offline", () => {
  it("keeps both replies", () => {
    // Last-writer-wins on the object would drop whichever reply synced first. This is why the
    // message list has a merge rule of its own.
    const mine = [message(), message({ id: "m2", created_at: "2026-08-26T10:05:00.000Z" })];
    const theirs = [
      message(),
      message({ id: "m3", author_id: "grace", created_at: "2026-08-26T10:04:00.000Z" }),
    ];
    expect(mergeThreadMessages(mine, theirs).map((entry) => entry.id)).toEqual(["m1", "m3", "m2"]);
  });

  it("keeps the later edit of one message rather than both copies of it", () => {
    const original = message({ body: "figure 2" });
    const edited = message({ body: "figure 3", edited_at: "2026-08-26T12:00:00.000Z" });
    const merged = mergeThreadMessages([original], [edited]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.body).toBe("figure 3");
  });

  it("merges an empty side without losing the other", () => {
    expect(mergeThreadMessages([], [message()])).toHaveLength(1);
  });
});

describe("how a thread reads in a list", () => {
  it("titles itself with its opening comment, with mentions in plain words", () => {
    const thread = startThread(passage, message({ body: "@[Grace](user:grace) check this" }));
    expect(threadTitle(thread)).toBe("@Grace check this");
  });

  it("falls back to what it is anchored to", () => {
    const thread = startThread(passage, message({ body: " " }));
    expect(threadTitle(thread)).toBe("Comment on “the effect was larger in the second cohort”");
  });

  it("is searchable by every message in it", () => {
    const thread = replyToThread(
      startThread(passage, message()),
      message({ id: "m2", body: "the reagent lot changed" }),
    );
    expect(threadContent(thread)).toContain("reagent lot");
  });
});

describe("what a stored thread is not allowed to be", () => {
  it("rejects an empty comment", () => {
    const thread = startThread(passage, message({ body: "   " }));
    expect(validateThread(thread).map((problem) => problem.field)).toEqual(["messages"]);
  });

  it("rejects two messages sharing an identifier", () => {
    // The merge rule unions by id. Two different messages under one id is one of them deleted.
    const thread = withThreadMessages(startThread(passage, message()), [
      message(),
      message({ body: "different words, same id" }),
    ]);
    expect(validateThread(thread)).toHaveLength(1);
  });

  it("rejects a resolved thread that does not say when", () => {
    const thread = { ...startThread(passage, message()), status: "resolved" as const };
    expect(validateThread(thread).map((problem) => problem.field)).toEqual(["resolved_at"]);
  });

  it("reads a thread that is not one as nothing at all", () => {
    expect(readThread({ status: "open" })).toBeNull();
    expect(readThread(null)).toBeNull();
  });

  it("keeps a message whose fields are missing rather than dropping the conversation", () => {
    const thread = readThread({ anchor: passage, messages: [{ id: "m1" }, "junk"] });
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]?.author_name).toBe("");
  });
});

describe("a passage that has moved since the comment was left", () => {
  it("leaves an untouched document alone", () => {
    const text = `Introduction. ${QUOTE} And so on.`;
    expect(resolveThreadAnchor(anchoredIn(text), { text })).toEqual({
      state: "found",
      from: text.indexOf(QUOTE),
      to: text.indexOf(QUOTE) + QUOTE.length,
    });
  });

  it("follows the words when an edit above the comment pushes them down", () => {
    const before = `Introduction. ${QUOTE} And so on.`;
    const after = `Introduction, rewritten at some length by a co-author. ${QUOTE} And so on.`;
    const resolution = resolveThreadAnchor(anchoredIn(before), { text: after });
    expect(resolution.state).toBe("moved");
    expect(span(after, resolution)).toBe(QUOTE);
  });

  it("does not call a re-wrapped line a move", () => {
    // The words are identical and only the line break is new, so there is nothing to write back.
    const before = `Introduction. ${QUOTE} And so on.`;
    const after = before.replace("larger in", "larger\nin");
    expect(resolveThreadAnchor(anchoredIn(before), { text: after }).state).toBe("found");
  });

  it("takes the nearer of two identical passages", () => {
    const twice = `${QUOTE}${"filler ".repeat(120)}${QUOTE}`;
    const second = twice.lastIndexOf(QUOTE);
    const anchor: ThreadAnchor = {
      object_id: "manuscript-1",
      kind: "text_range",
      from: second,
      to: second + QUOTE.length,
      quote: QUOTE,
    };
    const after = `Added. ${twice}`;
    const resolution = resolveThreadAnchor(anchor, { text: after });
    expect(resolution.from).toBe(after.lastIndexOf(QUOTE));
  });

  it("follows a passage moved far away when it is the only one", () => {
    // A section dragged to the end of the document takes its comments with it.
    const before = `${QUOTE} and the rest.`;
    const after = `${"x".repeat(5_000)} ${QUOTE}`;
    const resolution = resolveThreadAnchor(anchoredIn(before), { text: after });
    expect(resolution.state).toBe("moved");
    expect(span(after, resolution)).toBe(QUOTE);
  });

  it("will not guess between two far-away passages", () => {
    const before = `${QUOTE} and the rest.`;
    const after = `${"x".repeat(5_000)} ${QUOTE} and again ${QUOTE}`;
    expect(resolveThreadAnchor(anchoredIn(before), { text: after }).state).toBe("orphaned");
  });
});

describe("a comment whose passage is gone", () => {
  it("is orphaned rather than deleted", () => {
    const thread = startThread(passage, message());
    const resolution = resolveThreadAnchor(thread.anchor, { text: "Nothing of the sort here." });
    expect(resolution.state).toBe("orphaned");
    // The thread is not touched: its old positions and its quotation are what someone
    // re-anchoring it has to go on.
    expect(withResolvedAnchor(thread, resolution)).toBe(thread);
  });

  it("writes the new positions back only when they moved", () => {
    const before = `Introduction. ${QUOTE} And so on.`;
    const after = `Introduction, rewritten at some length by a co-author. ${QUOTE} And so on.`;
    const thread = startThread(anchoredIn(before), message());
    const moved = withResolvedAnchor(thread, resolveThreadAnchor(thread.anchor, { text: after }));
    expect(moved.anchor.from).toBe(after.indexOf(QUOTE));
    expect(moved.messages).toEqual(thread.messages);
  });

  it("orphans a passage whose positions fall off the end and has no quotation to find", () => {
    const anchor: ThreadAnchor = {
      object_id: "manuscript-1",
      kind: "text_range",
      from: 40,
      to: 96,
    };
    expect(resolveThreadAnchor(anchor, { text: "Short." }).state).toBe("orphaned");
  });

  it("is re-anchored to the text a person selects, quotation and all", () => {
    const thread = startThread(passage, message());
    const text = "The second cohort ran on a different reagent lot.";
    const anchored = reanchorThread(thread, 4, 17, "second cohort");
    expect(text.slice(anchored.anchor.from, anchored.anchor.to)).toBe("second cohort");
    expect(resolveThreadAnchor(anchored.anchor, { text }).state).toBe("found");
  });
});

describe("an anchor that is not a passage", () => {
  it("cannot be moved by editing the text", () => {
    const anchor: ThreadAnchor = { object_id: "note-1", kind: "object" };
    expect(resolveThreadAnchor(anchor, { text: "" })).toEqual({
      state: "found",
      from: null,
      to: null,
    });
  });

  it("orphans a comment on a section that has been deleted", () => {
    const anchor: ThreadAnchor = {
      object_id: "manuscript-1",
      kind: "section",
      section_id: "methods",
    };
    expect(resolveThreadAnchor(anchor, { text: "", sections: ["introduction"] }).state).toBe(
      "orphaned",
    );
    expect(resolveThreadAnchor(anchor, { text: "", sections: ["methods"] }).state).toBe("found");
  });
});
