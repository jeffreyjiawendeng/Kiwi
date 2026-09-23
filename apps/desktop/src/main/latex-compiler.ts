import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPILE_LIMITS,
  DEFAULT_LATEX_ENGINE,
  compileFailed,
  parseLatexLog,
  type LatexEngine,
  type LatexProblem,
} from "@kiwi/contracts";

/**
 * Turning LaTeX into a PDF.
 *
 * Cloud first, local second. The hosted compiler is preferred because it is one TeX
 * installation the project controls: every author gets the same packages, the same fonts, and
 * the same result, which is what makes "it compiles on my machine" stop being a sentence
 * anyone has to say.
 *
 * A local installation is the fallback rather than the default because it is whatever that
 * person happens to have. It is still worth having: it works with no network, it costs
 * nothing, it keeps an unpublished manuscript on the machine, and most people who write LaTeX
 * already have MiKTeX or TeX Live installed.
 */

export interface CompileInput {
  source: string;
  engine: LatexEngine;
  /** Figures, by the name the source refers to them by. */
  files: Array<{ name: string; bytes: Uint8Array }>;
}

export interface CompileOutcome {
  status: "ok" | "failed";
  /** Where the compile ran, so the interface can say so rather than guessing. */
  ran: "cloud" | "local";
  pdf: Uint8Array | null;
  problems: LatexProblem[];
  log: string;
}

export interface LocalRunner {
  /** Runs a command and returns its combined output, whatever the exit status. */
  run(
    command: string,
    args: string[],
    options: { cwd: string; timeoutMs: number },
  ): Promise<{ code: number; output: string }>;
  readOutput(path: string): Promise<Uint8Array>;
}

export const defaultRunner: LocalRunner = {
  run(command, args, options) {
    return new Promise((resolve) => {
      execFile(
        command,
        args,
        { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const output = `${stdout}\n${stderr}`;
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ code, output });
        },
      );
    });
  },
  readOutput: (path) => readFile(path),
};

/**
 * `latexmk` rather than the engine directly.
 *
 * A LaTeX document usually has to be compiled more than once: the first run writes the
 * cross-references and the bibliography, the second reads them back. Running the engine once
 * produces a PDF full of `??` where the citations should be, which looks like a working
 * compile and is not one. latexmk is what knows how many runs are needed.
 */
export function latexmkArguments(engine: LatexEngine, jobName: string): string[] {
  const flag = engine === "lualatex" ? "-lualatex" : engine === "xelatex" ? "-xelatex" : "-pdf";
  return [
    flag,
    // Never stop for input. A missing file otherwise hangs the process on a prompt nobody
    // can see, and the compile only ends when it times out.
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    `-jobname=${jobName}`,
    `${jobName}.tex`,
  ];
}

export interface LocalCompilerOptions {
  runner?: LocalRunner;
  /** Where scratch directories are made. Injected by tests. */
  scratchRoot?: string;
  latexmk?: string;
}

/** True when a local TeX installation can be found and run. */
export async function localCompilerAvailable(options: LocalCompilerOptions = {}): Promise<boolean> {
  const runner = options.runner ?? defaultRunner;
  const result = await runner
    .run(options.latexmk ?? "latexmk", ["-version"], { cwd: process.cwd(), timeoutMs: 10_000 })
    .catch(() => null);
  return result !== null && result.code === 0;
}

export async function compileLocally(
  input: CompileInput,
  options: LocalCompilerOptions = {},
): Promise<CompileOutcome> {
  const runner = options.runner ?? defaultRunner;
  const jobName = "kiwi-document";
  const directory = await mkdtemp(join(options.scratchRoot ?? tmpdir(), "kiwi-latex-"));
  try {
    await writeFile(join(directory, `${jobName}.tex`), input.source, "utf8");
    for (const file of input.files) {
      // The name comes from the document, which is editable on disk, so it is never allowed
      // to reach outside the scratch directory.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(file.name)) continue;
      await writeFile(join(directory, file.name), file.bytes);
    }

    const { output } = await runner.run(
      options.latexmk ?? "latexmk",
      latexmkArguments(input.engine, jobName),
      { cwd: directory, timeoutMs: COMPILE_LIMITS.timeoutSeconds * 1_000 },
    );
    const problems = parseLatexLog(output);
    const pdf = await runner.readOutput(join(directory, `${jobName}.pdf`)).catch(() => null);

    // A PDF that exists is a result even when the log carried warnings, and a log with no
    // error but no PDF is still a failure. The artifact decides.
    return {
      status: pdf === null ? "failed" : "ok",
      ran: "local",
      pdf,
      problems:
        pdf === null && !compileFailed(problems)
          ? [
              ...problems,
              {
                severity: "error" as const,
                file: null,
                line: null,
                message: "The compiler produced no document and gave no reason.",
              },
            ]
          : problems,
      log: output,
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface CloudCompiler {
  compile(input: CompileInput): Promise<CompileOutcome>;
}

export interface CompilerOptions extends LocalCompilerOptions {
  cloud?: CloudCompiler | null;
  /** Overrides the default preference. Used when someone insists on compiling locally. */
  prefer?: "cloud" | "local";
}

/**
 * Compiles with the preferred compiler and falls back to the other one.
 *
 * A cloud failure that is the network's fault falls back to local. A cloud failure that is the
 * document's fault does not: recompiling a broken document somewhere else produces the same
 * errors more slowly, and hides which compiler the author was actually using.
 */
export async function compileDocument(
  input: CompileInput,
  options: CompilerOptions = {},
): Promise<CompileOutcome> {
  const prefer = options.prefer ?? "cloud";
  const cloud = options.cloud ?? null;

  if (prefer === "cloud" && cloud !== null) {
    const outcome = await cloud.compile(input).catch(() => null);
    if (outcome !== null) return outcome;
  }

  if (await localCompilerAvailable(options)) {
    return compileLocally(input, options);
  }

  if (prefer === "local" && cloud !== null) {
    const outcome = await cloud.compile(input).catch(() => null);
    if (outcome !== null) return outcome;
  }

  return {
    status: "failed",
    ran: prefer,
    pdf: null,
    problems: [
      {
        severity: "error",
        file: null,
        line: null,
        message:
          "No LaTeX compiler is available. Connect to the Kiwi service, or install TeX Live or MiKTeX to compile on this computer.",
      },
    ],
    log: "",
  };
}

export const DEFAULT_ENGINE = DEFAULT_LATEX_ENGINE;
