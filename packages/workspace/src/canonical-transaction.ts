import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { canonicalJson, prettyJson, sha256Text } from "./canonical-json.js";
import { writeFileAtomic } from "./atomic.js";

const workspaceQueues = new Map<string, Promise<void>>();

/** Serializes canonical mutations per workspace within this process. */
export async function withCanonicalWrite<T>(root: string, work: () => Promise<T>): Promise<T> {
  const resolved = resolve(root);
  const key = process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  const previous = workspaceQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  workspaceQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (workspaceQueues.get(key) === tail) workspaceQueues.delete(key);
  }
}

export type TransactionTarget =
  | { relativePath: string; after: string | null }
  | { relativePath: string; stagedFile: { path: string; hash: string } };

interface StoredTarget {
  relative_path: string;
  after_hash: string | null;
  had_before: boolean;
  staged_binary?: boolean;
}

interface TransactionManifest {
  transaction_id: string;
  state: "preparing" | "prepared" | "committed";
  created_at: string;
  targets: StoredTarget[];
}

export interface CanonicalEvent extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  transaction_id: string;
  schema_version: "1.0.0";
  event_type: string;
  occurred_at: string;
  recorded_at: string;
  actor: string;
  origin: string;
  request_id: string;
}

export interface CommitCanonicalInput {
  root: string;
  workspaceId: string;
  transactionId: string;
  now: string;
  actor: string;
  origin: string;
  requestId: string;
  preparedEventId: string;
  committedEventId: string;
  domainEvents: CanonicalEvent[];
  targets: TransactionTarget[];
  faultAfterTarget?: number;
}

function inside(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !path.includes(":");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function appendEvents(path: string, events: CanonicalEvent[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.write(
      events.map((event) => `${canonicalJson(event)}\n`).join(""),
      undefined,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function eventPath(root: string, now: string): string {
  const date = new Date(now);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return join(root, ".kiwi", "events", year, month, "events.jsonl");
}

function lifecycleEvent(
  input: CommitCanonicalInput,
  id: string,
  eventType: string,
): CanonicalEvent {
  return {
    id,
    workspace_id: input.workspaceId,
    transaction_id: input.transactionId,
    schema_version: "1.0.0",
    event_type: eventType,
    occurred_at: input.now,
    recorded_at: input.now,
    actor: input.actor,
    origin: input.origin,
    request_id: input.requestId,
  };
}

export async function commitCanonical(input: CommitCanonicalInput): Promise<void> {
  const transactionRoot = join(input.root, ".kiwi", "transactions", input.transactionId);
  const manifestPath = join(transactionRoot, "manifest.json");
  const storedTargets: StoredTarget[] = [];
  await mkdir(join(transactionRoot, "staged"), { recursive: true });
  await mkdir(join(transactionRoot, "before"), { recursive: true });

  for (const [index, target] of input.targets.entries()) {
    const destination = join(input.root, target.relativePath);
    if (!inside(input.root, destination)) throw new Error("Canonical target escaped workspace.");
    if ("stagedFile" in target) {
      if (!inside(transactionRoot, target.stagedFile.path))
        throw new Error("Staged binary target escaped its transaction.");
      if (await exists(destination))
        throw new Error("A staged binary target cannot replace an existing canonical file.");
      if ((await sha256File(target.stagedFile.path)) !== target.stagedFile.hash)
        throw new Error("Staged binary hash changed before commit.");
      const stagedPath = join(transactionRoot, "staged", `${index}.data`);
      if (target.stagedFile.path !== stagedPath) await rename(target.stagedFile.path, stagedPath);
      storedTargets.push({
        relative_path: target.relativePath.replaceAll("\\", "/"),
        after_hash: target.stagedFile.hash,
        had_before: false,
        staged_binary: true,
      });
      continue;
    }
    const before = await readFile(destination, "utf8").catch(() => null);
    if (before !== null)
      await writeFileAtomic(join(transactionRoot, "before", `${index}.json`), before);
    if (target.after !== null)
      await writeFileAtomic(join(transactionRoot, "staged", `${index}.json`), target.after);
    storedTargets.push({
      relative_path: target.relativePath.replaceAll("\\", "/"),
      after_hash: target.after === null ? null : sha256Text(target.after),
      had_before: before !== null,
    });
  }

  const manifest: TransactionManifest = {
    transaction_id: input.transactionId,
    state: "preparing",
    created_at: input.now,
    targets: storedTargets,
  };
  await writeFileAtomic(manifestPath, prettyJson(manifest));
  await writeFileAtomic(join(transactionRoot, "prepared"), `${input.now}\n`);
  manifest.state = "prepared";
  await writeFileAtomic(manifestPath, prettyJson(manifest));
  await appendEvents(eventPath(input.root, input.now), [
    lifecycleEvent(input, input.preparedEventId, "transaction.prepared"),
    ...input.domainEvents,
  ]);

  for (const [index, target] of input.targets.entries()) {
    const destination = join(input.root, target.relativePath);
    if (!("stagedFile" in target) && target.after === null) {
      await unlink(destination).catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      });
    } else {
      await mkdir(dirname(destination), { recursive: true });
      await rename(
        join(transactionRoot, "staged", `${index}.${"stagedFile" in target ? "data" : "json"}`),
        destination,
      );
    }
    if (input.faultAfterTarget === index + 1) throw new Error("Injected canonical interruption.");
  }

  await appendEvents(eventPath(input.root, input.now), [
    lifecycleEvent(input, input.committedEventId, "transaction.committed"),
  ]);
  manifest.state = "committed";
  await writeFileAtomic(manifestPath, prettyJson(manifest));

  for (const [index, target] of input.targets.entries()) {
    const currentPath = join(input.root, target.relativePath);
    const currentExists = await exists(currentPath);
    const expected = storedTargets[index]?.after_hash;
    if (
      (expected === null && currentExists) ||
      (expected !== null && (!currentExists || (await sha256File(currentPath)) !== expected))
    )
      throw new Error("Canonical verification failed after commit.");
  }
  await rm(transactionRoot, { recursive: true, force: true });
}

export interface RecoveryReport {
  transaction_id: string;
  action: "removed_unprepared" | "rolled_back" | "cleaned_committed" | "quarantined";
  event_id?: string;
}

export interface RecoveryAuditInput {
  workspaceId: string;
  actor: string;
  origin: string;
  requestId: string;
  now: string;
  newId(): string;
}

function readManifest(value: string): TransactionManifest | null {
  try {
    const parsed = JSON.parse(value) as TransactionManifest;
    return parsed !== null && Array.isArray(parsed.targets) ? parsed : null;
  } catch {
    return null;
  }
}

async function hasCommittedEvent(root: string, transactionId: string): Promise<boolean> {
  const years = await readdir(join(root, ".kiwi", "events"), { withFileTypes: true }).catch(
    () => [],
  );
  for (const year of years) {
    if (!year.isDirectory()) continue;
    const months = await readdir(join(root, ".kiwi", "events", year.name), {
      withFileTypes: true,
    }).catch(() => []);
    for (const month of months) {
      if (!month.isDirectory()) continue;
      const raw = await readFile(
        join(root, ".kiwi", "events", year.name, month.name, "events.jsonl"),
        "utf8",
      ).catch(() => "");
      for (const line of raw.split("\n")) {
        if (!line.includes(transactionId) || !line.includes("transaction.committed")) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (
            event["transaction_id"] === transactionId &&
            event["event_type"] === "transaction.committed"
          )
            return true;
        } catch {
          // A malformed line is handled by diagnostics elsewhere and is never proof of commit.
        }
      }
    }
  }
  return false;
}

async function auditRecovery(
  root: string,
  report: RecoveryReport,
  audit: RecoveryAuditInput | undefined,
): Promise<RecoveryReport> {
  if (audit === undefined) return report;
  const eventId = audit.newId();
  await appendEvents(eventPath(root, audit.now), [
    {
      id: eventId,
      workspace_id: audit.workspaceId,
      transaction_id: audit.newId(),
      schema_version: "1.0.0",
      event_type: "transaction.recovered",
      occurred_at: audit.now,
      recorded_at: audit.now,
      actor: audit.actor,
      origin: audit.origin,
      request_id: audit.requestId,
      recovered_transaction_id: report.transaction_id,
      recovery_action: report.action,
    },
  ]);
  return { ...report, event_id: eventId };
}

export async function recoverCanonicalTransactions(
  root: string,
  audit?: RecoveryAuditInput,
): Promise<RecoveryReport[]> {
  return withCanonicalWrite(root, () => recoverCanonicalTransactionsUnlocked(root, audit));
}

async function recoverCanonicalTransactionsUnlocked(
  root: string,
  audit?: RecoveryAuditInput,
): Promise<RecoveryReport[]> {
  const transactionsRoot = join(root, ".kiwi", "transactions");
  const entries = await readdir(transactionsRoot, { withFileTypes: true }).catch(() => []);
  const reports: RecoveryReport[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const transactionRoot = join(transactionsRoot, entry.name);
    const raw = await readFile(join(transactionRoot, "manifest.json"), "utf8").catch(() => null);
    const manifest = raw === null ? null : readManifest(raw);
    if (manifest === null) {
      const quarantine = join(root, ".kiwi", "recovery", "quarantine");
      await mkdir(quarantine, { recursive: true });
      await rename(transactionRoot, join(quarantine, entry.name));
      reports.push(
        await auditRecovery(root, { transaction_id: entry.name, action: "quarantined" }, audit),
      );
      continue;
    }
    if (manifest.state === "preparing" || !(await exists(join(transactionRoot, "prepared")))) {
      await rm(transactionRoot, { recursive: true, force: true });
      reports.push(
        await auditRecovery(
          root,
          { transaction_id: manifest.transaction_id, action: "removed_unprepared" },
          audit,
        ),
      );
      continue;
    }
    if (
      manifest.state === "committed" ||
      (await hasCommittedEvent(root, manifest.transaction_id))
    ) {
      await rm(transactionRoot, { recursive: true, force: true });
      reports.push(
        await auditRecovery(
          root,
          { transaction_id: manifest.transaction_id, action: "cleaned_committed" },
          audit,
        ),
      );
      continue;
    }
    for (const [index, target] of manifest.targets.entries()) {
      const destination = join(root, target.relative_path);
      if (!inside(root, destination)) continue;
      if (target.had_before) {
        const before = await readFile(join(transactionRoot, "before", `${index}.json`), "utf8");
        await writeFileAtomic(destination, before);
      } else {
        const currentExists = await exists(destination);
        if (
          currentExists &&
          target.after_hash !== null &&
          (await sha256File(destination)) === target.after_hash
        ) {
          await unlink(destination);
          if (target.staged_binary === true)
            await rmdir(dirname(destination)).catch(() => undefined);
        }
      }
    }
    await rm(transactionRoot, { recursive: true, force: true });
    reports.push(
      await auditRecovery(
        root,
        { transaction_id: manifest.transaction_id, action: "rolled_back" },
        audit,
      ),
    );
  }
  return reports;
}
