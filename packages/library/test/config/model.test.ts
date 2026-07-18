import { describe, expect, it } from "vitest";

import {
  createEmptyConfigDocument,
  createEmptyCredentialsDocument,
  parseConfigDocument,
  parseCredentialsDocument,
  validateConfigurationPair
} from "../../src/config/model";

const timestamp = "2026-01-01T00:00:00.000Z";

function profile() {
  return {
    id: "provider-a",
    name: "Synthetic relay",
    endpoints: {
      generation: {
        mode: "exact-generation-endpoint" as const,
        value: "https://relay.example/v1/images/generations?api-version=synthetic"
      }
    },
    models: [],
    capabilities: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

describe("versioned configuration models", () => {
  it("creates complete version-1 empty documents", () => {
    expect(parseConfigDocument(createEmptyConfigDocument())).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      profiles: [],
      outputDirectory: { mode: "default" }
    });
    expect(parseCredentialsDocument(createEmptyCredentialsDocument())).toEqual({
      schemaVersion: 1,
      revision: 0,
      apiKeys: {}
    });
  });

  it("rejects corrupt and future documents without defaulting them", () => {
    expect(() => parseConfigDocument({ schemaVersion: 1, revision: 0 })).toThrowError(
      expect.objectContaining({ code: "config_corrupt" })
    );
    expect(() => parseConfigDocument({ schemaVersion: 2 })).toThrowError(
      expect.objectContaining({ code: "unsupported_version" })
    );
    expect(() => parseCredentialsDocument({ schemaVersion: 9 })).toThrowError(
      expect.objectContaining({ code: "unsupported_version" })
    );
  });

  it("rejects capability records owned by another provider", () => {
    expect(() =>
      parseConfigDocument({
        ...createEmptyConfigDocument(),
        profiles: [
          {
            ...profile(),
            capabilities: [
              {
                capability: "single-image-input",
                scope: {
                  providerId: "provider-b",
                  model: "synthetic-model",
                  endpointFingerprint: "a".repeat(64),
                  transport: "single-endpoint-json",
                  requestShape: "single-endpoint-json:image"
                },
                state: "unknown",
                evidence: []
              }
            ]
          }
        ]
      })
    ).toThrowError(expect.objectContaining({ code: "config_corrupt" }));
  });

  it("rejects credential entries that no profile owns", () => {
    const config = parseConfigDocument({
      ...createEmptyConfigDocument(),
      profiles: [profile()]
    });
    const credentials = parseCredentialsDocument({
      schemaVersion: 1,
      revision: 1,
      apiKeys: { "provider-b": "synthetic-credential" }
    });
    expect(() => validateConfigurationPair(config, credentials)).toThrowError(
      expect.objectContaining({ code: "config_corrupt" })
    );
  });
});
