import { StudioGatewayError } from "./errors";

export const STUDIO_SESSION_HEADER = "x-routego-session";
export const STUDIO_SESSION_QUERY_PARAMETER = "token";
export const STUDIO_SESSION_BOOTSTRAP_GLOBAL = "__ROUTEGO_STUDIO_SESSION__";

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;

export interface StudioSession {
  apply(headers?: HeadersInit): Headers;
}

export class InMemoryStudioSession implements StudioSession {
  readonly #token: string;

  constructor(token: string) {
    if (!SESSION_TOKEN_PATTERN.test(token)) {
      throw new StudioGatewayError(
        "session_missing",
        "The local Studio session is missing or invalid. Reopen Studio from Routego Image."
      );
    }
    this.#token = token;
  }

  apply(initial?: HeadersInit): Headers {
    const headers = new Headers(initial);
    headers.set(STUDIO_SESSION_HEADER, this.#token);
    return headers;
  }

  toJSON(): Readonly<{ session: "[REDACTED]" }> {
    return { session: "[REDACTED]" };
  }
}

export type StudioSessionBootstrap =
  | { readonly status: "ready"; readonly session: StudioSession }
  | { readonly status: "missing" | "invalid" };

export interface StudioSessionBootstrapTarget {
  readonly href: string;
  readonly injectedSession?: unknown;
  replaceUrl(nextUrl: string): void;
}

interface InjectedStudioSession {
  readonly sessionToken: string;
  readonly expiresAt: string;
}

function injectedSessionBootstrap(value: unknown): StudioSessionBootstrap | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid" };
  }
  const candidate = value as Partial<InjectedStudioSession>;
  const expiresAt =
    typeof candidate.expiresAt === "string" ? Date.parse(candidate.expiresAt) : Number.NaN;
  if (
    typeof candidate.sessionToken !== "string" ||
    !SESSION_TOKEN_PATTERN.test(candidate.sessionToken) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    return { status: "invalid" };
  }
  return { status: "ready", session: new InMemoryStudioSession(candidate.sessionToken) };
}

export function bootstrapStudioSession(
  target: StudioSessionBootstrapTarget
): StudioSessionBootstrap {
  const launchUrl = new URL(target.href);
  const tokens = launchUrl.searchParams.getAll(STUDIO_SESSION_QUERY_PARAMETER);
  launchUrl.searchParams.delete(STUDIO_SESSION_QUERY_PARAMETER);
  target.replaceUrl(`${launchUrl.pathname}${launchUrl.search}${launchUrl.hash}`);

  const injected = injectedSessionBootstrap(target.injectedSession);
  if (injected !== undefined) return injected;

  if (tokens.length === 0) {
    return { status: "missing" };
  }
  if (tokens.length !== 1 || !SESSION_TOKEN_PATTERN.test(tokens[0] ?? "")) {
    return { status: "invalid" };
  }
  return { status: "ready", session: new InMemoryStudioSession(tokens[0]!) };
}

export function bootstrapStudioSessionFromWindow(): StudioSessionBootstrap {
  return bootstrapStudioSession({
    href: window.location.href,
    injectedSession: (globalThis as Record<string, unknown>)[STUDIO_SESSION_BOOTSTRAP_GLOBAL],
    replaceUrl: (nextUrl) => window.history.replaceState(window.history.state, "", nextUrl)
  });
}
