/**
 * A project: one piece of research inside a workspace.
 *
 * A workspace is a group of people and the projects they share, a lab, a reading group, or
 * just you. A project is one piece of work inside it, and it owns the pages, the settings, and
 * the objects. A workspace with a single project is the common case, and the interface opens
 * straight into it rather than making anyone choose.
 *
 * Every page is built and every page can be turned on. Six start off because they are
 * method-specific: somebody writing a paper from a stack of PDFs would never open Screening or
 * Analysis, and six empty pages in the rail is six pages of noise. Turning one on is a switch,
 * and turning it off again destroys nothing, a disabled page's objects stay where they are.
 */

/** Every destination in the rail, in the order research runs. */
export const PROJECT_PAGES = [
  "dashboard",
  "question",
  "tasks",
  "import",
  "inbox",
  "library",
  "screening",
  "reader",
  "notes",
  "codebook",
  "extraction",
  "data",
  "analysis",
  "results",
  "claims",
  "manuscript",
  "bibliography",
  "review",
  "export",
  "graph",
  "history",
  "members",
  "settings",
  "trash",
] as const;

export type ProjectPage = (typeof PROJECT_PAGES)[number];

/**
 * The pages a project has to ask for.
 *
 * Screening, Codebook, and Extraction only mean something to someone running a systematic
 * review or coding qualitative data. Data, Analysis, and Results only mean something to
 * someone running code against a dataset. Everything else applies to any project and is
 * always present.
 */
export const OPTIONAL_PROJECT_PAGES = [
  "screening",
  "codebook",
  "extraction",
  "data",
  "analysis",
  "results",
] as const;

export type OptionalProjectPage = (typeof OPTIONAL_PROJECT_PAGES)[number];

export const PROJECT_PAGE_LABELS: Record<ProjectPage, string> = {
  dashboard: "Dashboard",
  question: "Question & Protocol",
  tasks: "Tasks",
  import: "Search & Import",
  inbox: "Inbox",
  library: "Library",
  screening: "Screening",
  reader: "Reader",
  notes: "Notes",
  codebook: "Codebook",
  extraction: "Extraction Table",
  data: "Data",
  analysis: "Analysis",
  results: "Results",
  claims: "Claims & Evidence",
  manuscript: "Manuscript",
  bibliography: "Bibliography",
  review: "Review",
  export: "Export & Release",
  graph: "Graph",
  history: "History",
  members: "Members",
  settings: "Settings",
  trash: "Trash",
};

/** One line saying what the page is for, shown beside the switch that enables it. */
export const PROJECT_PAGE_PURPOSE: Record<ProjectPage, string> = {
  dashboard: "The state of the project in one screen",
  question: "What the project is asking, and how it will be answered",
  tasks: "Who is doing what, and by when",
  import: "Everything that brings new material in",
  inbox: "Captured items waiting to be filed",
  library: "Every paper in the project",
  screening: "Deciding which sources are in the review",
  reader: "Reading and marking up documents",
  notes: "Where reading turns into thinking",
  codebook: "The codes applied to qualitative material",
  extraction: "One row per source, columns from the extraction schema",
  data: "Datasets, their schemas, and where they came from",
  analysis: "Scripts and notebooks, and the runs of them",
  results: "The figures and tables analysis produced",
  claims: "What the project asserts, and what supports it",
  manuscript: "Writing the paper",
  bibliography: "What is cited, and how it is formatted",
  review: "Getting it checked before it goes out",
  export: "Producing the finished document",
  graph: "Every object and every link between them",
  history: "Everything that has happened, and how to undo it",
  members: "Who is in this workspace, and what they may do",
  settings: "How this project and this workspace behave",
  trash: "Deleted items, until they are purged",
};

/** How the rail groups the pages. Every page appears in exactly one group. */
export const PROJECT_PAGE_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly pages: readonly ProjectPage[];
}> = [
  { label: "Plan", pages: ["dashboard", "question", "tasks"] },
  { label: "Gather", pages: ["import", "inbox", "library", "screening"] },
  { label: "Read", pages: ["reader", "notes", "codebook", "extraction"] },
  { label: "Analyze", pages: ["data", "analysis", "results"] },
  { label: "Write", pages: ["claims", "manuscript", "bibliography", "review", "export"] },
  { label: "Project", pages: ["graph", "history", "members", "settings", "trash"] },
];

/**
 * A template is a preselected set of switches and nothing more.
 *
 * It is not a mode. Every page it turns on can be turned off, every page it leaves off can be
 * turned on, and choosing the wrong one on day one costs a visit to Settings rather than a new
 * project.
 */
export const PROJECT_TEMPLATES = [
  {
    id: "general",
    label: "General",
    description: "Read papers, take notes, write something. Nothing extra.",
    pages: [] as readonly OptionalProjectPage[],
  },
  {
    id: "literature_review",
    label: "Literature review",
    description: "Screen sources against criteria and extract from them in a structured table.",
    pages: ["screening", "extraction"] as readonly OptionalProjectPage[],
  },
  {
    id: "qualitative",
    label: "Qualitative study",
    description: "Code material against a codebook and extract what the codes turn up.",
    pages: ["codebook", "extraction"] as readonly OptionalProjectPage[],
  },
  {
    id: "quantitative",
    label: "Quantitative study",
    description: "Keep datasets, run analyses against them, and collect what they produce.",
    pages: ["data", "analysis", "results"] as readonly OptionalProjectPage[],
  },
  {
    id: "everything",
    label: "Everything",
    description: "Every page on. For a project that does not fit the others.",
    pages: OPTIONAL_PROJECT_PAGES as readonly OptionalProjectPage[],
  },
] as const;

export type ProjectTemplateId = (typeof PROJECT_TEMPLATES)[number]["id"];

export const CITATION_STYLES = ["apa", "mla", "chicago", "ieee", "nature"] as const;
export type CitationStyle = (typeof CITATION_STYLES)[number];

export const PROJECT_SENSITIVITIES = ["public", "internal", "confidential", "restricted"] as const;
export type ProjectSensitivity = (typeof PROJECT_SENSITIVITIES)[number];

export const PROJECT_LIMITS = {
  title: 200,
  description: 2_000,
} as const;

export interface ProjectSettings {
  description: string;
  template: ProjectTemplateId;
  /** Only the optional pages that are on. The always-on pages are never listed. */
  pages: OptionalProjectPage[];
  citation_style: CitationStyle;
  sensitivity: ProjectSensitivity;
  review_required: boolean;
  archived: boolean;
}

export function isProjectPage(value: unknown): value is ProjectPage {
  return typeof value === "string" && (PROJECT_PAGES as readonly string[]).includes(value);
}

export function isOptionalProjectPage(value: unknown): value is OptionalProjectPage {
  return typeof value === "string" && (OPTIONAL_PROJECT_PAGES as readonly string[]).includes(value);
}

export function isProjectTemplateId(value: unknown): value is ProjectTemplateId {
  return typeof value === "string" && PROJECT_TEMPLATES.some((template) => template.id === value);
}

export function projectTemplate(id: ProjectTemplateId): (typeof PROJECT_TEMPLATES)[number] {
  return PROJECT_TEMPLATES.find((template) => template.id === id) ?? PROJECT_TEMPLATES[0];
}

export function defaultProjectSettings(template: ProjectTemplateId = "general"): ProjectSettings {
  return {
    description: "",
    template,
    pages: [...projectTemplate(template).pages],
    citation_style: "apa",
    sensitivity: "internal",
    review_required: false,
    archived: false,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads settings off an object that may have been written by any version of Kiwi.
 *
 * Tolerant by design: a project whose settings are missing, half-written, or carrying a page
 * name this build has never heard of still opens, with the defaults filling the gaps. A
 * project that refuses to open because one field is wrong is worse than one that opens with a
 * field reset.
 */
export function readProjectSettings(value: unknown): ProjectSettings {
  const input = record(value);
  if (input === null) return defaultProjectSettings();

  const template = isProjectTemplateId(input["template"]) ? input["template"] : "general";
  const defaults = defaultProjectSettings(template);

  const rawPages = input["pages"];
  const pages = Array.isArray(rawPages)
    ? // Order is the rail's order, not the order they were switched on, and a name repeated
      // twice enables the page once.
      OPTIONAL_PROJECT_PAGES.filter((page) => rawPages.includes(page))
    : defaults.pages;

  return {
    description:
      typeof input["description"] === "string"
        ? input["description"].slice(0, PROJECT_LIMITS.description)
        : "",
    template,
    pages: [...pages],
    citation_style: (CITATION_STYLES as readonly unknown[]).includes(input["citation_style"])
      ? (input["citation_style"] as CitationStyle)
      : defaults.citation_style,
    sensitivity: (PROJECT_SENSITIVITIES as readonly unknown[]).includes(input["sensitivity"])
      ? (input["sensitivity"] as ProjectSensitivity)
      : defaults.sensitivity,
    review_required: input["review_required"] === true,
    archived: input["archived"] === true,
  };
}

export function projectPageEnabled(settings: ProjectSettings, page: ProjectPage): boolean {
  return isOptionalProjectPage(page) ? settings.pages.includes(page) : isProjectPage(page);
}

/** Every page this project shows, in rail order. */
export function enabledProjectPages(settings: ProjectSettings): ProjectPage[] {
  return PROJECT_PAGES.filter((page) => projectPageEnabled(settings, page));
}

/** The rail's groups, with disabled pages removed and empty groups dropped. */
export function projectPageGroups(
  settings: ProjectSettings,
): Array<{ label: string; pages: ProjectPage[] }> {
  return PROJECT_PAGE_GROUPS.map((group) => ({
    label: group.label,
    pages: group.pages.filter((page) => projectPageEnabled(settings, page)),
  })).filter((group) => group.pages.length > 0);
}

/**
 * The pages the rail shows without being asked for.
 *
 * Every page is still one click away; these are the ones somebody opens daily. A rail listing
 * all twenty-four under six headings is a table of contents, and a table of contents is what you
 * read when you do not know where anything is -- not what you want in front of you every day
 * once you do.
 *
 * Order is the order research runs in, not the order of `PROJECT_PAGES`: Tasks belongs with the
 * work rather than at the top beside the Dashboard, because it is where you go last.
 */
export const PROJECT_CORE_PAGES = [
  "dashboard",
  "inbox",
  "library",
  "reader",
  "notes",
  "claims",
  "manuscript",
  "tasks",
] as const;

/**
 * Which kind of object a page's count is a count of.
 *
 * Only where the number means something. A Manuscript page beside a "1" is telling somebody what
 * they already know, and a Reader has no objects of its own to count.
 */
export const PROJECT_PAGE_COUNTED_TYPE: Partial<Record<ProjectPage, string>> = {
  inbox: "inbox_item",
  library: "source",
  notes: "note",
  claims: "claim",
};

export interface ProjectRailPages {
  /** Listed outright. */
  core: ProjectPage[];
  /** Behind More, in the order the rail used to group them. */
  more: ProjectPage[];
}

/**
 * The rail, split into what is shown and what is folded away.
 *
 * A core page the project has switched off is not shown, and it does not reappear under More
 * either: off means off wherever the page would have been drawn.
 */
export function projectRailPages(settings: ProjectSettings): ProjectRailPages {
  const core = PROJECT_CORE_PAGES.filter((page) => projectPageEnabled(settings, page));
  return {
    core: [...core],
    more: enabledProjectPages(settings).filter(
      (page) => !(PROJECT_CORE_PAGES as readonly ProjectPage[]).includes(page),
    ),
  };
}

export interface ProjectProblem {
  field: "title" | "description" | "pages" | "template";
  severity: "error" | "warning";
  message: string;
}

export function validateProjectSettings(input: {
  title?: string;
  settings: ProjectSettings;
}): ProjectProblem[] {
  const problems: ProjectProblem[] = [];
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title === "")
      problems.push({ field: "title", severity: "error", message: "Name the project." });
    else if (title.length > PROJECT_LIMITS.title)
      problems.push({
        field: "title",
        severity: "error",
        message: `A project name is at most ${PROJECT_LIMITS.title} characters.`,
      });
  }
  if (input.settings.description.length > PROJECT_LIMITS.description)
    problems.push({
      field: "description",
      severity: "error",
      message: `A description is at most ${PROJECT_LIMITS.description} characters.`,
    });

  // Results without Analysis is not an error, but it is almost always a mistake: nothing
  // fills that page except a run.
  if (input.settings.pages.includes("results") && !input.settings.pages.includes("analysis"))
    problems.push({
      field: "pages",
      severity: "warning",
      message: "Results is filled by Analysis. With Analysis off, nothing will appear there.",
    });
  if (input.settings.pages.includes("analysis") && !input.settings.pages.includes("data"))
    problems.push({
      field: "pages",
      severity: "warning",
      message: "Analysis runs against datasets. With Data off, there is nothing to run against.",
    });
  return problems;
}
