import { StudioGatewayError } from "./errors";

export const STUDIO_SESSION_HEADER = "x-routego-session";
export const STUDIO_SESSION_QUERY_PARAMETER = "token";

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
  replaceUrl(nextUrl: string): void;
}

export function bootstrapStudioSession(
  target: StudioSessionBootstrapTarget
): StudioSessionBootstrap {
  const launchUrl = new URL(target.href);
  const tokens = launchUrl.searchParams.getAll(STUDIO_SESSION_QUERY_PARAMETER);
  launchUrl.searchParams.delete(STUDIO_SESSION_QUERY_PARAMETER);
  target.replaceUrl(`${launchUrl.pathname}${launchUrl.search}${launchUrl.hash}`);

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
    replaceUrl: (nextUrl) => window.history.replaceState(window.history.state, "", nextUrl)
  });
}
