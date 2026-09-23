export interface ComparableObjectVersion {
  version: number;
  content_hash: string;
  title: string;
  content: string;
}

export interface VersionFieldChange {
  field: "title";
  before: string;
  after: string;
  changed: boolean;
}

export interface MarkdownLineChange {
  kind: "unchanged" | "removed" | "added";
  text: string;
  before_line: number | null;
  after_line: number | null;
}

export interface ObjectVersionComparison {
  before: ComparableObjectVersion;
  after: ComparableObjectVersion;
  fields: VersionFieldChange[];
  markdown: MarkdownLineChange[];
  changed: boolean;
  simplified: boolean;
}

const LCS_CELL_LIMIT = 100_000;

function lines(value: string): string[] {
  return value.normalize("NFC").replaceAll("\r\n", "\n").split("\n");
}

function simpleMiddleDiff(before: string[], after: string[]): MarkdownLineChange[] {
  const changes: MarkdownLineChange[] = [];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    changes.push({
      kind: "unchanged",
      text: before[prefix]!,
      before_line: prefix + 1,
      after_line: prefix + 1,
    });
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }
  for (let index = prefix; index < before.length - suffix; index += 1) {
    changes.push({
      kind: "removed",
      text: before[index]!,
      before_line: index + 1,
      after_line: null,
    });
  }
  for (let index = prefix; index < after.length - suffix; index += 1) {
    changes.push({
      kind: "added",
      text: after[index]!,
      before_line: null,
      after_line: index + 1,
    });
  }
  for (let index = suffix; index > 0; index -= 1) {
    const beforeIndex = before.length - index;
    const afterIndex = after.length - index;
    changes.push({
      kind: "unchanged",
      text: before[beforeIndex]!,
      before_line: beforeIndex + 1,
      after_line: afterIndex + 1,
    });
  }
  return changes;
}

function lcsDiff(before: string[], after: string[]): MarkdownLineChange[] {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      const offset = beforeIndex * width + afterIndex;
      table[offset] =
        before[beforeIndex] === after[afterIndex]
          ? table[(beforeIndex + 1) * width + afterIndex + 1]! + 1
          : Math.max(table[(beforeIndex + 1) * width + afterIndex]!, table[offset + 1]!);
    }
  }

  const changes: MarkdownLineChange[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length || afterIndex < after.length) {
    if (
      beforeIndex < before.length &&
      afterIndex < after.length &&
      before[beforeIndex] === after[afterIndex]
    ) {
      changes.push({
        kind: "unchanged",
        text: before[beforeIndex]!,
        before_line: beforeIndex + 1,
        after_line: afterIndex + 1,
      });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      afterIndex < after.length &&
      (beforeIndex === before.length ||
        table[beforeIndex * width + afterIndex + 1]! >=
          table[(beforeIndex + 1) * width + afterIndex]!)
    ) {
      changes.push({
        kind: "added",
        text: after[afterIndex]!,
        before_line: null,
        after_line: afterIndex + 1,
      });
      afterIndex += 1;
    } else {
      changes.push({
        kind: "removed",
        text: before[beforeIndex]!,
        before_line: beforeIndex + 1,
        after_line: null,
      });
      beforeIndex += 1;
    }
  }
  return changes;
}

export function compareObjectVersions(
  left: ComparableObjectVersion,
  right: ComparableObjectVersion,
): ObjectVersionComparison {
  const [before, after] = left.version <= right.version ? [left, right] : [right, left];
  const beforeLines = lines(before.content);
  const afterLines = lines(after.content);
  const simplified = beforeLines.length * afterLines.length > LCS_CELL_LIMIT;
  const markdown = simplified
    ? simpleMiddleDiff(beforeLines, afterLines)
    : lcsDiff(beforeLines, afterLines);
  return {
    before,
    after,
    fields: [
      {
        field: "title",
        before: before.title,
        after: after.title,
        changed: before.title !== after.title,
      },
    ],
    markdown,
    changed: before.title !== after.title || before.content !== after.content,
    simplified,
  };
}
