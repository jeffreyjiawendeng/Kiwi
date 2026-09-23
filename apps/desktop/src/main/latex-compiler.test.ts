import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import {
  compileDocument,
  compileLocally,
  latexmkArguments,
  localCompilerAvailable,
  type CloudCompiler,
  type CompileOutcome,
  type LocalRunner,
} from "./latex-compiler.js";

const scratchDirs: string[] = [];

afterEach(async () => {
  for (const directory of scratchDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

function runner(
  overrides: {
    code?: number;
    output?: string;
    pdf?: Uint8Array | null;
    onRun?: (command: string, args: string[], cwd: string) => void;
  } = {},
): LocalRunner {
  return {
    run: vi.fn(async (command, args, options) => {
      overrides.onRun?.(command, args, options.cwd);
      return { code: overrides.code ?? 0, output: overrides.output ?? "Output written." };
    }),
    readOutput: vi.fn(async () => {
      if (overrides.pdf === null) throw new Error("ENOENT");
      return overrides.pdf ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    }),
  };
}

function input(overrides: Partial<Parameters<typeof compileLocally>[0]> = {}) {
  return {
    source: "\\documentclass{article}\\begin{document}Hi\\end{document}",
    engine: "lualatex" as const,
    files: [],
    ...overrides,
  };
}

describe("latexmkArguments", () => {
  it("drives latexmk rather than the engine, so references resolve", () => {
    // One run leaves ?? where every citation should be. That looks like a working compile
    // and is not one; latexmk is what knows how many passes are needed.
    const args = latexmkArguments("lualatex", "kiwi-document");
    expect(args).toContain("-lualatex");
    expect(args).toContain("kiwi-document.tex");
  });

  it("selects the engine that was asked for", () => {
    expect(latexmkArguments("xelatex", "j")).toContain("-xelatex");
    expect(latexmkArguments("pdflatex", "j")).toContain("-pdf");
  });

  it("never stops for input", () => {
    // A missing file otherwise hangs on a prompt nobody can see until the timeout.
    expect(latexmkArguments("lualatex", "j")).toContain("-interaction=nonstopmode");
  });
});

describe("compileLocally", () => {
  it("writes the source and returns the document", async () => {
    const seen: string[] = [];
    const local = runner({ onRun: (_command, _args, cwd) => seen.push(cwd) });
    const outcome = await compileLocally(input(), { runner: local });

    expect(outcome.status).toBe("ok");
    expect(outcome.ran).toBe("local");
    expect(outcome.pdf).not.toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("carries figures into the directory the compiler reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "kiwi-latex-test-"));
    scratchDirs.push(root);
    // The scratch directory is removed as soon as the compile finishes, so what is in it has
    // to be read while the compiler is notionally running.
    let present: string[] = [];
    let figure: Buffer | null = null;
    const local: LocalRunner = {
      run: vi.fn(async (_command, _args, options) => {
        present = await readdir(options.cwd);
        figure = await readFile(join(options.cwd, "figure-abc")).catch(() => null);
        return { code: 0, output: "Output written." };
      }),
      readOutput: vi.fn(async () => new Uint8Array([0x25])),
    };

    await compileLocally(
      input({ files: [{ name: "figure-abc", bytes: new Uint8Array([1, 2, 3]) }] }),
      { runner: local, scratchRoot: root },
    );

    expect(present).toContain("kiwi-document.tex");
    expect(present).toContain("figure-abc");
    expect(figure).toEqual(Buffer.from([1, 2, 3]));
  });

  it("refuses a figure name that would escape the directory", async () => {
    // The name comes from the document, which is editable on disk.
    const root = await mkdtemp(join(tmpdir(), "kiwi-latex-test-"));
    scratchDirs.push(root);
    let present: string[] = [];
    const local: LocalRunner = {
      run: vi.fn(async (_command, _args, options) => {
        present = await readdir(options.cwd);
        return { code: 0, output: "Output written." };
      }),
      readOutput: vi.fn(async () => new Uint8Array([0x25])),
    };

    await compileLocally(
      input({
        files: [
          { name: "../escape.tex", bytes: new Uint8Array([1]) },
          { name: "ok-figure", bytes: new Uint8Array([2]) },
        ],
      }),
      { runner: local, scratchRoot: root },
    );

    expect(present).toContain("ok-figure");
    expect(present).not.toContain("escape.tex");
    // The parent is where a ../ name would have landed.
    expect(await readdir(root)).not.toContain("escape.tex");
  });

  it("reads the log into problems with line numbers", async () => {
    const local = runner({
      code: 1,
      pdf: null,
      output: ["(./kiwi-document.tex", "! Undefined control sequence.", "l.7 \\nope"].join("\n"),
    });
    const outcome = await compileLocally(input(), { runner: local });

    expect(outcome.status).toBe("failed");
    expect(outcome.problems[0]).toMatchObject({ severity: "error", line: 7 });
  });

  it("treats a produced document as a result even with warnings", async () => {
    // Almost every real paper compiles with warnings. Calling that a failure would mean
    // nothing ever compiled.
    const local = runner({
      output: [
        "(./kiwi-document.tex",
        "LaTeX Warning: Reference `x' undefined on input line 3.",
      ].join("\n"),
    });
    const outcome = await compileLocally(input(), { runner: local });

    expect(outcome.status).toBe("ok");
    expect(outcome.problems).toMatchObject([{ severity: "warning" }]);
  });

  it("says something rather than nothing when no document appears and no error was logged", async () => {
    const local = runner({ pdf: null, output: "nothing useful here" });
    const outcome = await compileLocally(input(), { runner: local });

    expect(outcome.status).toBe("failed");
    expect(outcome.problems.at(-1)?.message).toContain("no document");
  });

  it("cleans up after itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "kiwi-latex-test-"));
    scratchDirs.push(root);
    await compileLocally(input(), { runner: runner(), scratchRoot: root });
    expect(await readdir(root)).toEqual([]);
  });

  it("cleans up even when the compiler throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "kiwi-latex-test-"));
    scratchDirs.push(root);
    const failing: LocalRunner = {
      run: vi.fn(async () => {
        throw new Error("spawn failed");
      }),
      readOutput: vi.fn(async () => new Uint8Array()),
    };

    await expect(
      compileLocally(input(), { runner: failing, scratchRoot: root }),
    ).rejects.toBeTruthy();
    expect(await readdir(root)).toEqual([]);
  });
});

describe("localCompilerAvailable", () => {
  it("is true when latexmk answers", async () => {
    expect(await localCompilerAvailable({ runner: runner() })).toBe(true);
  });

  it("is false when it is not installed", async () => {
    expect(await localCompilerAvailable({ runner: runner({ code: 127 }) })).toBe(false);
  });

  it("is false rather than throwing when the command cannot be spawned", async () => {
    const failing: LocalRunner = {
      run: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
      readOutput: vi.fn(async () => new Uint8Array()),
    };
    expect(await localCompilerAvailable({ runner: failing })).toBe(false);
  });
});

describe("compileDocument", () => {
  function cloud(outcome: Partial<CompileOutcome> | null): CloudCompiler {
    return {
      compile: vi.fn(async () => {
        if (outcome === null) throw new Error("unreachable");
        return {
          status: "ok",
          ran: "cloud",
          pdf: new Uint8Array([1]),
          problems: [],
          log: "",
          ...outcome,
        } as CompileOutcome;
      }),
    };
  }

  it("uses the hosted compiler first", async () => {
    // One TeX installation the project controls means every author gets the same result.
    const outcome = await compileDocument(input(), {
      cloud: cloud({}),
      runner: runner(),
    });
    expect(outcome.ran).toBe("cloud");
  });

  it("falls back to a local installation when the service cannot be reached", async () => {
    const outcome = await compileDocument(input(), {
      cloud: cloud(null),
      runner: runner(),
    });
    expect(outcome.ran).toBe("local");
    expect(outcome.status).toBe("ok");
  });

  it("does not recompile locally when the document itself is broken", async () => {
    // Compiling a broken document somewhere else produces the same errors more slowly and
    // hides which compiler the author was actually using.
    const local = runner();
    const outcome = await compileDocument(input(), {
      cloud: cloud({
        status: "failed",
        pdf: null,
        problems: [{ severity: "error", file: null, line: 3, message: "Missing $" }],
      }),
      runner: local,
    });

    expect(outcome.ran).toBe("cloud");
    expect(local.run).not.toHaveBeenCalled();
  });

  it("compiles locally when asked to, without consulting the service", async () => {
    const hosted = cloud({});
    const outcome = await compileDocument(input(), {
      prefer: "local",
      cloud: hosted,
      runner: runner(),
    });
    expect(outcome.ran).toBe("local");
    expect(hosted.compile).not.toHaveBeenCalled();
  });

  it("falls back to the service when local TeX is asked for and absent", async () => {
    const outcome = await compileDocument(input(), {
      prefer: "local",
      cloud: cloud({}),
      runner: runner({ code: 127 }),
    });
    expect(outcome.ran).toBe("cloud");
  });

  it("says how to get a compiler when there is none", async () => {
    const outcome = await compileDocument(input(), { cloud: null, runner: runner({ code: 127 }) });

    expect(outcome.status).toBe("failed");
    expect(outcome.problems[0]?.message).toContain("TeX Live or MiKTeX");
  });
});
