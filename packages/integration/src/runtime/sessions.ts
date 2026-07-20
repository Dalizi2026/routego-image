import { randomUUID } from "node:crypto";

import {
  constantTimeSessionTokenEqual,
  generateSessionToken
} from "@routego-image/foundation";

const DEFAULT_MAXIMUM_ACTIVE_SESSIONS = 16;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_LAUNCH_TTL_MS = 60 * 1_000;
const DEFAULT_TOKEN_BYTES = 32;
const MAXIMUM_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_ACTIVE_SESSIONS = 128;

export interface StudioSessionManagerOptions {
  readonly maximumActiveSessions?: number;
  readonly sessionTtlMs?: number;
  readonly launchTtlMs?: number;
  readonly tokenBytes?: number;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly createToken?: () => string;
}

export interface StudioSessionDescriptor {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface IssuedStudioSession extends StudioSessionDescriptor {
  readonly sessionToken: string;
  readonly launchToken: string;
  readonly launchExpiresAt: string;
}

export interface ActivatedStudioSession extends StudioSessionDescriptor {
  readonly sessionToken: string;
}

interface SessionRecord {
  readonly id: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly launchExpiresAtMs: number;
  readonly sessionToken: string;
  readonly launchToken: string;
}

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function timestamp(value: number): string {
  return new Date(value).toISOString();
}

function descriptor(record: SessionRecord): StudioSessionDescriptor {
  return {
    id: record.id,
    createdAt: timestamp(record.createdAtMs),
    expiresAt: timestamp(record.expiresAtMs)
  };
}

/**
 * Owns the bounded set of sessions for one loopback listener. Launch tokens are
 * short-lived URL credentials and are deliberately distinct from API session
 * tokens, which exist only in the returned bootstrap document and browser
 * memory. Repeated bootstrap reads return the same session so link previews do
 * not consume the user's launch.
 */
export class StudioSessionManager {
  readonly #maximumActiveSessions: number;
  readonly #sessionTtlMs: number;
  readonly #launchTtlMs: number;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #createToken: () => string;
  #records: SessionRecord[] = [];
  #closed = false;

  constructor(options: StudioSessionManagerOptions = {}) {
    this.#maximumActiveSessions = positiveInteger(
      "maximumActiveSessions",
      options.maximumActiveSessions ?? DEFAULT_MAXIMUM_ACTIVE_SESSIONS,
      MAXIMUM_ACTIVE_SESSIONS
    );
    this.#sessionTtlMs = positiveInteger(
      "sessionTtlMs",
      options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      MAXIMUM_SESSION_TTL_MS
    );
    this.#launchTtlMs = positiveInteger(
      "launchTtlMs",
      options.launchTtlMs ?? DEFAULT_LAUNCH_TTL_MS,
      this.#sessionTtlMs
    );
    const tokenBytes = positiveInteger(
      "tokenBytes",
      options.tokenBytes ?? DEFAULT_TOKEN_BYTES,
      128
    );
    if (tokenBytes < 24) {
      throw new Error("tokenBytes must contain at least 24 random bytes");
    }
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#createToken = options.createToken ?? (() => generateSessionToken(tokenBytes));
  }

  get size(): number {
    this.#pruneExpired(this.#now());
    return this.#records.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  issue(): IssuedStudioSession {
    this.#assertOpen();
    const now = this.#now();
    this.#pruneExpired(now);
    if (this.#records.length >= this.#maximumActiveSessions) {
      throw new Error("The loopback listener has reached its active session limit.");
    }

    const generatedSessionValue = this.#uniqueToken();
    const launchToken = this.#uniqueToken(generatedSessionValue);
    const id = this.#createId();
    if (id.length === 0 || this.#records.some((record) => record.id === id)) {
      throw new Error("The session identifier generator did not produce a unique identifier.");
    }
    const record: SessionRecord = {
      id,
      createdAtMs: now,
      expiresAtMs: now + this.#sessionTtlMs,
      launchExpiresAtMs: now + this.#launchTtlMs,
      sessionToken: generatedSessionValue,
      launchToken
    };
    this.#records.push(record);
    return {
      ...descriptor(record),
      sessionToken: generatedSessionValue,
      launchToken,
      launchExpiresAt: timestamp(record.launchExpiresAtMs)
    };
  }

  /** Authorizes repeat bootstrap reads only during the short launch window. */
  authorizeLaunchToken(candidate: string): ActivatedStudioSession | undefined {
    if (this.#closed) return undefined;
    const now = this.#now();
    this.#pruneExpired(now);
    const record = this.#findMatching(candidate, "launch");
    if (
      record === undefined || record.launchExpiresAtMs <= now
    ) {
      return undefined;
    }
    return { ...descriptor(record), sessionToken: record.sessionToken };
  }

  /** Validates an API token by scanning every bounded record. */
  authorizeSessionToken(candidate: string): StudioSessionDescriptor | undefined {
    if (this.#closed) return undefined;
    const now = this.#now();
    this.#pruneExpired(now);
    const record = this.#findMatching(candidate, "session");
    return record === undefined ? undefined : descriptor(record);
  }

  getSession(id: string): StudioSessionDescriptor | undefined {
    if (this.#closed) return undefined;
    this.#pruneExpired(this.#now());
    const record = this.#records.find((candidate) => candidate.id === id);
    return record === undefined ? undefined : descriptor(record);
  }

  latestSession(): StudioSessionDescriptor | undefined {
    if (this.#closed) return undefined;
    this.#pruneExpired(this.#now());
    const record = this.#records.at(-1);
    return record === undefined ? undefined : descriptor(record);
  }

  /** Used only to construct a Creation dispatcher for CORS preflight. */
  firstActiveSessionToken(): string | undefined {
    if (this.#closed) return undefined;
    this.#pruneExpired(this.#now());
    return this.#records[0]?.sessionToken;
  }

  revoke(id: string): boolean {
    const before = this.#records.length;
    this.#records = this.#records.filter((record) => record.id !== id);
    return this.#records.length !== before;
  }

  close(): void {
    this.#records = [];
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("The Studio session manager is closed.");
  }

  #pruneExpired(now: number): void {
    this.#records = this.#records.filter((record) => record.expiresAtMs > now);
  }

  #findMatching(candidate: string, kind: "launch" | "session"): SessionRecord | undefined {
    let matched: SessionRecord | undefined;
    for (const record of this.#records) {
      const expected = kind === "launch" ? record.launchToken : record.sessionToken;
      if (constantTimeSessionTokenEqual(candidate, expected)) matched = record;
    }
    return matched;
  }

  #uniqueToken(otherToken?: string): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.#createToken();
      if (token.length === 0) throw new Error("The session token generator returned an empty token.");
      let duplicate = otherToken !== undefined && constantTimeSessionTokenEqual(token, otherToken);
      for (const record of this.#records) {
        duplicate = constantTimeSessionTokenEqual(token, record.sessionToken) || duplicate;
        duplicate = constantTimeSessionTokenEqual(token, record.launchToken) || duplicate;
      }
      if (!duplicate) return token;
    }
    throw new Error("The session token generator did not produce a unique token.");
  }
}
