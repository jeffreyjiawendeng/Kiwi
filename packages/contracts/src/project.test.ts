import { describe, expect, it } from "vitest";
import {
  OPTIONAL_PROJECT_PAGES,
  PROJECT_PAGES,
  PROJECT_PAGE_GROUPS,
  PROJECT_PAGE_LABELS,
  PROJECT_PAGE_PURPOSE,
  PROJECT_TEMPLATES,
  defaultProjectSettings,
  enabledProjectPages,
  projectPageEnabled,
  projectPageGroups,
  readProjectSettings,
  validateProjectSettings,
} from "./project.js";

describe("the page list", () => {
  it("names and explains every page", () => {
    // A page in the rail with no label renders as an empty button.
    for (const page of PROJECT_PAGES) {
      expect(PROJECT_PAGE_LABELS[page]).toBeTruthy();
      expect(PROJECT_PAGE_PURPOSE[page]).toBeTruthy();
    }
  });

  it("puts every page in exactly one rail group", () => {
    // A page in no group is unreachable; a page in two appears twice.
    const grouped = PROJECT_PAGE_GROUPS.flatMap((group) => group.pages);
    expect([...grouped].sort()).toEqual([...PROJECT_PAGES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("keeps the optional pages a subset of the pages", () => {
    for (const page of OPTIONAL_PROJECT_PAGES) {
      expect(PROJECT_PAGES).toContain(page);
    }
  });

  it("leaves Dashboard, Library, Reader, Notes and Manuscript always on", () => {
    // These are the loop. A project that could switch them off would be a project you
    // cannot work in.
    for (const page of ["dashboard", "library", "reader", "notes", "manuscript"] as const) {
      expect(OPTIONAL_PROJECT_PAGES).not.toContain(page);
    }
  });
});

describe("templates", () => {
  it("only ever turns on optional pages", () => {
    // A template that named an always-on page would imply it could be off.
    for (const template of PROJECT_TEMPLATES) {
      for (const page of template.pages) {
        expect(OPTIONAL_PROJECT_PAGES).toContain(page);
      }
    }
  });

  it("starts General with nothing extra", () => {
    expect(defaultProjectSettings("general").pages).toEqual([]);
  });

  it("turns on everything under Everything", () => {
    expect(defaultProjectSettings("everything").pages).toEqual([...OPTIONAL_PROJECT_PAGES]);
  });

  it("gives a literature review its screening and extraction", () => {
    expect(defaultProjectSettings("literature_review").pages).toEqual(["screening", "extraction"]);
  });
});

describe("readProjectSettings", () => {
  it("fills in a project with no settings at all", () => {
    // A project written before settings existed still has to open.
    expect(readProjectSettings(undefined)).toEqual(defaultProjectSettings());
    expect(readProjectSettings(null).template).toBe("general");
  });

  it("drops a page name this build has never heard of", () => {
    const settings = readProjectSettings({ pages: ["screening", "telepathy"] });
    expect(settings.pages).toEqual(["screening"]);
  });

  it("enables a page named twice exactly once", () => {
    expect(readProjectSettings({ pages: ["data", "data"] }).pages).toEqual(["data"]);
  });

  it("stores pages in rail order rather than the order they were switched on", () => {
    const settings = readProjectSettings({ pages: ["results", "screening", "data"] });
    expect(settings.pages).toEqual(["screening", "data", "results"]);
  });

  it("falls back rather than refusing to open when a field is wrong", () => {
    const settings = readProjectSettings({
      template: "nonsense",
      citation_style: 7,
      sensitivity: "cosmic",
      description: 42,
    });
    expect(settings.template).toBe("general");
    expect(settings.citation_style).toBe("apa");
    expect(settings.sensitivity).toBe("internal");
    expect(settings.description).toBe("");
  });

  it("keeps what was actually set", () => {
    const settings = readProjectSettings({
      template: "quantitative",
      description: "Ribosome assembly",
      citation_style: "nature",
      sensitivity: "confidential",
      review_required: true,
      archived: true,
      pages: ["data", "analysis"],
    });
    expect(settings).toEqual({
      description: "Ribosome assembly",
      template: "quantitative",
      pages: ["data", "analysis"],
      citation_style: "nature",
      sensitivity: "confidential",
      review_required: true,
      archived: true,
    });
  });

  it("does not restore a template's pages over an explicit empty list", () => {
    // Switching every optional page off is a decision, not a missing field.
    expect(readProjectSettings({ template: "quantitative", pages: [] }).pages).toEqual([]);
  });
});

describe("which pages a project shows", () => {
  it("shows every always-on page and no optional one by default", () => {
    const pages = enabledProjectPages(defaultProjectSettings());
    expect(pages).toContain("library");
    expect(pages).not.toContain("analysis");
  });

  it("shows an optional page once it is enabled", () => {
    const settings = defaultProjectSettings("quantitative");
    expect(projectPageEnabled(settings, "analysis")).toBe(true);
    expect(projectPageEnabled(settings, "screening")).toBe(false);
  });

  it("drops a group whose pages are all off", () => {
    // Analyze holds nothing but optional pages, so a General project has no Analyze heading.
    const groups = projectPageGroups(defaultProjectSettings());
    expect(groups.map((group) => group.label)).not.toContain("Analyze");
    expect(projectPageGroups(defaultProjectSettings("quantitative")).map((g) => g.label)).toContain(
      "Analyze",
    );
  });

  it("keeps rail order", () => {
    const pages = enabledProjectPages(defaultProjectSettings("everything"));
    expect(pages).toEqual([...PROJECT_PAGES]);
  });
});

describe("validateProjectSettings", () => {
  const settings = defaultProjectSettings();

  it("requires a name", () => {
    expect(validateProjectSettings({ title: "   ", settings })).toMatchObject([
      { field: "title", severity: "error" },
    ]);
  });

  it("accepts a named project", () => {
    expect(validateProjectSettings({ title: "Thesis chapter 3", settings })).toEqual([]);
  });

  it("warns rather than refuses when Results has no Analysis behind it", () => {
    const problems = validateProjectSettings({
      settings: { ...settings, pages: ["results"] },
    });
    expect(problems).toMatchObject([{ field: "pages", severity: "warning" }]);
  });

  it("says nothing about a coherent quantitative project", () => {
    expect(
      validateProjectSettings({
        title: "Screen",
        settings: defaultProjectSettings("quantitative"),
      }),
    ).toEqual([]);
  });
});
