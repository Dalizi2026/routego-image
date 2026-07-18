import path from "node:path";
import { mkdir, readdir, unlink } from "node:fs/promises";

import { LibraryError, isNodeError } from "../errors";
import { readJsonRecovering, writeJsonAtomic } from "./atomic-json";
import { resolveApprovedPath } from "./paths";

export interface FileTransactionJournal {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: string;
  readonly state: "prepared" | "committed";
  readonly createdAt: string;
  readonly createdPaths: readonly string[];
  readonly deleteAfterCommitPaths: readonly string[];
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface FileTransactionRecoveryPlan {
  readonly journalId: string;
  readonly phase: FileTransactionJournal["state"];
  readonly removePaths: readonly string[];
}

function parseStringArray(value: unknown, name: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item === "" || item.includes("\0"))
  ) {
    throw new LibraryError("config_corrupt", `Transaction journal ${name} is invalid.`);
  }
  return value;
}

function parseMetadata(
  value: unknown
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LibraryError("config_corrupt", "Transaction journal metadata is invalid.");
  }
  const entries = Object.entries(value);
  if (
    entries.some(
      ([key, item]) =>
        key.includes("\0") ||
        (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") ||
        (typeof item === "number" && !Number.isFinite(item)) ||
        (typeof item === "string" && (item.includes("\0") || item.length > 2_000))
    )
  ) {
    throw new LibraryError("config_corrupt", "Transaction journal metadata is invalid.");
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string | number | boolean>>;
}

export function parseFileTransactionJournal(value: unknown): FileTransactionJournal {
  if (value === null || typeof value !== "object") {
    throw new LibraryError("config_corrupt", "Transaction journal is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    record["schemaVersion"] !== 1 ||
    typeof record["id"] !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(record["id"]) ||
    typeof record["kind"] !== "string" ||
    record["kind"].length === 0 ||
    record["kind"].length > 160 ||
    record["kind"].includes("\0") ||
    (record["state"] !== "prepared" && record["state"] !== "committed") ||
    typeof record["createdAt"] !== "string" ||
    !Number.isFinite(Date.parse(record["createdAt"]))
  ) {
    throw new LibraryError("config_corrupt", "Transaction journal fields are invalid.");
  }
  const metadata = parseMetadata(record["metadata"]);
  return {
    schemaVersion: 1,
    id: record["id"],
    kind: record["kind"],
    state: record["state"],
    createdAt: record["createdAt"],
    createdPaths: parseStringArray(record["createdPaths"], "createdPaths"),
    deleteAfterCommitPaths: parseStringArray(
      record["deleteAfterCommitPaths"],
      "deleteAfterCommitPaths"
    ),
    ...(metadata === undefined ? {} : { metadata })
  };
}

export function transactionJournalPath(root: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(id)) {
    throw new LibraryError("invalid_input", "Transaction identifier is invalid.");
  }
  return resolveApprovedPath({
    root,
    candidate: path.join(".transactions", `${id}.json`),
    operation: "create"
  });
}

export async function writeTransactionJournal(
  root: string,
  journal: FileTransactionJournal
): Promise<void> {
  const validated = parseFileTransactionJournal(journal);
  await mkdir(path.dirname(transactionJournalPath(root, journal.id)), { recursive: true });
  await writeJsonAtomic(transactionJournalPath(root, journal.id), validated);
}

export async function markTransactionJournalCommitted(
  root: string,
  journal: FileTransactionJournal
): Promise<FileTransactionJournal> {
  const committed: FileTransactionJournal = { ...journal, state: "committed" };
  await writeTransactionJournal(root, committed);
  return committed;
}

export function createTransactionRecoveryPlan(
  root: string,
  journal: FileTransactionJournal
): FileTransactionRecoveryPlan {
  const validated = parseFileTransactionJournal(journal);
  const relativePaths =
    validated.state === "prepared"
      ? validated.createdPaths
      : validated.deleteAfterCommitPaths;
  return {
    journalId: validated.id,
    phase: validated.state,
    removePaths: relativePaths.map((candidate) =>
      resolveApprovedPath({ root, candidate, operation: "delete" })
    )
  };
}

export async function listTransactionJournals(root: string): Promise<FileTransactionJournal[]> {
  const directory = resolveApprovedPath({
    root,
    candidate: ".transactions",
    operation: "read"
  });
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const journals: FileTransactionJournal[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    journals.push(
      await readJsonRecovering(path.join(directory, name), parseFileTransactionJournal)
    );
  }
  return journals;
}

export async function removeTransactionJournal(root: string, id: string): Promise<void> {
  const journalPath = transactionJournalPath(root, id);
  for (const candidate of [journalPath, `${journalPath}.bak`]) {
    try {
      await unlink(candidate);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}
