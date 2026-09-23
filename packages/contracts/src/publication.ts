export const OBJECT_TITLE_MAX_LENGTH = 200;
export const OBJECT_CONTENT_MAX_LENGTH = 1_000_000;

export type PublicationProblemSeverity = "error" | "warning";
export type PublicationProblemField = "title" | "content";

export interface PublicationProblem {
  code: "title_required" | "title_too_long" | "content_too_long" | "content_empty";
  severity: PublicationProblemSeverity;
  field: PublicationProblemField;
  message: string;
}

/** Deterministic object validation shared by the editor and canonical command boundary. */
export function validateObjectPublication(input: {
  title: string;
  content: string;
}): PublicationProblem[] {
  const problems: PublicationProblem[] = [];
  if (input.title.trim() === "") {
    problems.push({
      code: "title_required",
      severity: "error",
      field: "title",
      message: "Add a title before saving.",
    });
  } else if (input.title.length > OBJECT_TITLE_MAX_LENGTH) {
    problems.push({
      code: "title_too_long",
      severity: "error",
      field: "title",
      message: `Shorten the title to ${OBJECT_TITLE_MAX_LENGTH} characters or fewer.`,
    });
  }
  if (input.content.length > OBJECT_CONTENT_MAX_LENGTH) {
    problems.push({
      code: "content_too_long",
      severity: "error",
      field: "content",
      message: `Shorten the content to ${OBJECT_CONTENT_MAX_LENGTH.toLocaleString("en-US")} characters or fewer.`,
    });
  } else if (input.content.trim() === "") {
    problems.push({
      code: "content_empty",
      severity: "warning",
      field: "content",
      message: "This version has no content beyond its title.",
    });
  }
  return problems;
}
