import { CommandError, defineCommand, type CommandDefinition } from "@kiwi/commands";
import {
  ManagedAssetImportError,
  assetBytesOnDisk,
  importManagedAsset,
  readManagedAsset,
  runsWhenOpened,
} from "./assets.js";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

export interface AssetCommandDeps {
  newId(): string;
  now(): string;
  revealFile?(root: string, relativePath: string): Promise<void>;
  openFile?(root: string, relativePath: string): Promise<void>;
}

function workspaceId(context: { workspaceId: string | null }): string {
  if (context.workspaceId === null)
    throw new CommandError("KIWI_INVALID_REQUEST", "Open a workspace before importing a file.");
  return context.workspaceId;
}

function importFailure(cause: unknown): never {
  if (cause instanceof ManagedAssetImportError)
    throw new CommandError(
      cause.kind === "source_changed" ? "KIWI_CONFLICT_VERSION" : "KIWI_INVALID_ARGUMENTS",
      cause.message,
      { recoveryActions: [cause.kind === "source_changed" ? "retry" : "correct_input"] },
    );
  const code = (cause as NodeJS.ErrnoException).code;
  if (code === "ENOENT")
    throw new CommandError(
      "KIWI_NOT_FOUND",
      "The selected file is no longer available. Choose it again.",
      { recoveryActions: ["retry"] },
    );
  if (code === "EACCES" || code === "EPERM")
    throw new CommandError(
      "KIWI_PATH_DENIED",
      "Kiwi cannot read the selected file or write to this workspace.",
      { recoveryActions: ["retry"] },
    );
  if (code === "ENOSPC")
    throw new CommandError(
      "KIWI_UNAVAILABLE",
      "The workspace volume does not have enough free space for this file.",
      { recoveryActions: ["retry"] },
    );
  throw cause;
}

export function assetCommands(deps: AssetCommandDeps): CommandDefinition[] {
  return [
    defineCommand<{
      root: string;
      source_path: string;
      declared_media_type: string | null;
    }>({
      name: "kiwi.asset.import-managed",
      summary: "Copy one selected file into the workspace as a managed asset",
      idempotency: "idempotent",
      cancellation: "cancellable",
      origins: ["ui"],
      argsSchema: {
        $schema: SCHEMA,
        type: "object",
        required: ["root", "source_path", "declared_media_type"],
        additionalProperties: false,
        properties: {
          root: { type: "string", minLength: 3, maxLength: 32_767 },
          source_path: { type: "string", minLength: 1, maxLength: 32_767 },
          declared_media_type: {
            anyOf: [
              {
                type: "string",
                minLength: 3,
                maxLength: 255,
                pattern: "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$",
              },
              { type: "null" },
            ],
          },
        },
      },
      resultSchema: { $schema: SCHEMA, type: "object" },
      async handler(args, context) {
        const transactionId = deps.newId();
        const preparedEventId = deps.newId();
        const domainEventId = deps.newId();
        const committedEventId = deps.newId();
        const receipt = await importManagedAsset({
          root: args.root,
          workspaceId: workspaceId(context),
          assetId: deps.newId(),
          sourcePath: args.source_path,
          declaredMediaType: args.declared_media_type,
          actor: context.actor.id,
          requestId: context.requestId,
          now: deps.now(),
          signal: context.signal,
          transactionId,
          preparedEventId,
          domainEventId,
          committedEventId,
        }).catch(importFailure);
        return {
          transactionId,
          eventIds: [preparedEventId, domainEventId, committedEventId],
          data: { ...receipt },
          ...(receipt.duplicate_assets.length === 0
            ? {}
            : {
                warnings: [
                  `Kiwi found ${receipt.duplicate_assets.length} existing logical ${receipt.duplicate_assets.length === 1 ? "asset" : "assets"} with identical bytes.`,
                ],
              }),
        };
      },
    }),
    defineCommand<{ root: string; asset_id: string }>({
      name: "kiwi.asset.open-managed",
      summary: "Open an imported managed file in whatever application the system uses for it",
      idempotency: "idempotent",
      cancellation: "not_cancellable",
      origins: ["ui"],
      argsSchema: {
        $schema: SCHEMA,
        type: "object",
        required: ["root", "asset_id"],
        additionalProperties: false,
        properties: {
          root: { type: "string", minLength: 3, maxLength: 32_767 },
          asset_id: { type: "string", minLength: 1, maxLength: 100 },
        },
      },
      resultSchema: { $schema: SCHEMA, type: "object" },
      /**
       * The escape hatch: the file as its own application shows it, when Kiwi cannot.
       *
       * Kiwi reads PDFs and nothing else, and even a PDF can be one PDF.js draws badly. Without a
       * way out, a file somebody imported is a file they can no longer read, which is a worse
       * position than they were in before they filed it here.
       *
       * It reads nothing and writes nothing, so it answers `no_change`.
       */
      async handler(args, context) {
        workspaceId(context);
        const asset = await readManagedAsset(args.root, args.asset_id);
        if (asset === null)
          throw new CommandError("KIWI_NOT_FOUND", "The managed asset is not available.");
        // Checked before the disk is asked, because this refusal is about the kind of file and
        // stays true whether or not the bytes are there today.
        if (runsWhenOpened(asset.storage.relative_path))
          throw new CommandError(
            "KIWI_PATH_DENIED",
            "Kiwi does not hand this kind of file to the system, because the system would run it rather than show it. Reveal it in its folder instead.",
            { recoveryActions: ["correct_input"] },
          );
        if (!(await assetBytesOnDisk(args.root, asset)))
          throw new CommandError(
            "KIWI_NOT_FOUND",
            "That file is no longer in the workspace folder, so there is nothing to open.",
            { recoveryActions: ["retry"] },
          );
        if (deps.openFile === undefined)
          throw new CommandError(
            "KIWI_UNAVAILABLE",
            "Opening a file outside Kiwi is unavailable in this application context.",
          );
        // Whatever the system said went wrong is not repeated: it names the absolute path, and a
        // path from outside the workspace session is the one thing the interface never learns.
        await deps.openFile(args.root, asset.storage.relative_path).catch(() => {
          throw new CommandError(
            "KIWI_UNAVAILABLE",
            "The system would not open this file. There may be no application set up for this kind of file.",
            { recoveryActions: ["retry"] },
          );
        });
        return {
          data: { asset_id: asset.id, sha256: asset.sha256 },
          noChange: true,
        };
      },
    }),
    defineCommand<{ root: string; asset_id: string }>({
      name: "kiwi.asset.reveal-managed",
      summary: "Reveal an imported managed file through the trusted desktop shell",
      idempotency: "idempotent",
      cancellation: "not_cancellable",
      origins: ["ui"],
      argsSchema: {
        $schema: SCHEMA,
        type: "object",
        required: ["root", "asset_id"],
        additionalProperties: false,
        properties: {
          root: { type: "string", minLength: 3, maxLength: 32_767 },
          asset_id: { type: "string", minLength: 1, maxLength: 100 },
        },
      },
      resultSchema: { $schema: SCHEMA, type: "object" },
      async handler(args, context) {
        workspaceId(context);
        const asset = await readManagedAsset(args.root, args.asset_id);
        if (asset === null)
          throw new CommandError("KIWI_NOT_FOUND", "The managed asset is not available.");
        if (deps.revealFile === undefined)
          throw new CommandError(
            "KIWI_UNAVAILABLE",
            "Reveal in File Explorer is unavailable in this application context.",
          );
        await deps.revealFile(args.root, asset.storage.relative_path);
        return {
          data: {
            asset_id: asset.id,
            relative_path: asset.storage.relative_path,
            sha256: asset.sha256,
          },
          noChange: true,
        };
      },
    }),
  ];
}
