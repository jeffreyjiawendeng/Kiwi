const nodeBuiltins = [
  "node:*",
  "fs",
  "fs/*",
  "path",
  "os",
  "child_process",
  "worker_threads",
  "net",
  "http",
  "https",
  "dns",
  "tls",
  "cluster",
  "vm",
  "module",
  "process",
];

const electron = ["electron", "electron/*"];
const reactPackages = ["react", "react/*", "react-dom", "react-dom/*"];
const persistence = ["better-sqlite3", "node:sqlite", "@kiwi/persistence", "@kiwi/workspace"];
const network = ["undici", "axios", "node-fetch", "ws"];
const platform = ["@kiwi/platform-windows", "@kiwi/platform-windows/*"];

const platformRule = {
  id: "ENG-REPO-006",
  patterns: platform,
  message:
    "ENG-REPO-006: platform-specific code stays behind a platform-* interface so shared packages test on any OS.",
};

// Flat config replaces a rule entry rather than merging it, so every config that sets
// no-restricted-imports must carry the full set of denials that apply to its files.
const boundaries = [
  {
    files: ["**/packages/!(platform-windows)/src/**/*.{ts,tsx}"],
    rules: [platformRule],
  },
  {
    files: ["**/packages/domain/src/**/*.ts"],
    rules: [
      platformRule,
      {
        id: "ENG-REPO-001",
        patterns: [...nodeBuiltins, ...electron, ...reactPackages, ...persistence, ...network],
        message:
          "ENG-REPO-001: domain must stay deterministic and side-effect free. Depend on an injected port instead.",
      },
    ],
  },
  {
    files: ["**/packages/contracts/src/**/*.ts"],
    rules: [
      platformRule,
      {
        id: "ENG-REPO-002",
        patterns: [...nodeBuiltins, ...electron, ...reactPackages, ...persistence, ...network],
        message:
          "ENG-REPO-002: contracts must stay portable. It may not depend on a runtime-specific package.",
      },
    ],
  },
  {
    files: ["**/packages/ui/src/**/*.{ts,tsx}"],
    rules: [
      platformRule,
      {
        id: "ENG-REPO-004",
        patterns: [...nodeBuiltins, ...electron, ...persistence, ...network],
        message:
          "ENG-REPO-004: ui may not import workspace, persistence, Node, Electron main, or a provider SDK.",
      },
    ],
  },
  {
    files: ["**/apps/desktop/src/renderer/**/*.{ts,tsx}"],
    rules: [
      {
        id: "ENG-ARCH-001",
        patterns: [...nodeBuiltins, ...electron, ...persistence, ...network, ...platform],
        message:
          "ENG-ARCH-001: the renderer is unprivileged. Reach main only through the preload bridge.",
      },
    ],
  },
  {
    files: ["**/extensions/**/src/**/*.ts"],
    rules: [
      {
        id: "ENG-REPO-005",
        patterns: [...nodeBuiltins, ...electron, ...persistence, ...network, ...platform],
        message:
          "ENG-REPO-005: an extension may depend only on @kiwi/extension-api and @kiwi/contracts.",
      },
    ],
  },
];

// Boundary rules constrain shipped code. Test files are excluded from every package
// build and from the published files list, and they legitimately reach for a filesystem
// or a mocked Electron module.
const TEST_FILES = ["**/*.test.ts", "**/*.test.tsx"];

export function boundaryConfigs() {
  return boundaries.map(({ files, rules }) => ({
    files,
    ignores: TEST_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: rules.flatMap(({ id, patterns, message }) =>
            patterns.map((pattern) => ({ group: [pattern], message: `${id} | ${message}` })),
          ),
        },
      ],
    },
  }));
}
