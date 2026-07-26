import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { access, readFile, rename } from "node:fs/promises";
import { TextDecoder } from "node:util";

import {
  capabilityProbeResultSchema,
  identifierSchema,
  providerCapabilityRecordSchema,
  readSettingsInputSchema,
  readSettingsResultSchema,
  refreshModelsResultSchema,
  removeProviderProfileInputSchema,
  removeProviderProfileResultSchema,
  setActiveProviderProfileInputSchema,
  setActiveProviderProfileResultSchema,
  studioProviderSwitchInputSchema,
  studioProviderSwitchResultSchema,
  updateSettingsInputSchema,
  updateSettingsResultSchema,
  upsertProviderProfileInputSchema,
  upsertProviderProfileResultSchema,
  type CapabilityProbeResult,
  type ProviderCapabilityRecord,
  type ProviderEndpointSet,
  type ProviderProfileDescriptor,
  type ReadSettingsInput,
  type ReadSettingsResult,
  type RefreshModelsResult,
  type RemoveProviderProfileInput,
  type RemoveProviderProfileResult,
  type SetActiveProviderProfileInput,
  type SetActiveProviderProfileResult,
  type StudioProviderSwitchInput,
  type StudioProviderSwitchResult,
  type UpdateSettingsInput,
  type UpdateSettingsResult,
  type UpsertProviderProfileInput,
  type UpsertProviderProfileResult
} from "@routego-image/contracts";
import {
  describeProviderEndpoint,
  normalizeProviderEndpoints,
  type NormalizedProviderEndpointSet
} from "@routego-image/foundation";

import { LibraryError, isNodeError } from "../errors";
import { cleanupAtomicJsonTemporaryFiles, writeJsonAtomic } from "../fs/atomic-json";
import { acquireFileLock, type AcquireFileLockOptions } from "../fs/lock";
import {
  listTransactionJournals,
  markTransactionJournalCommitted,
  removeTransactionJournal,
  writeTransactionJournal,
  type FileTransactionJournal
} from "../fs/journal";
import { ensurePrivateDirectory, restrictFileToCurrentUser } from "../fs/permissions";
import {
  canonicalizeOutputDirectorySyntax,
  defaultOutputDirectoryDisplay,
  redactOutputDirectoryDisplay,
  validateOutputDirectory,
  type ValidateOutputDirectoryOptions
} from "./output-directory";
import {
  capabilityRecordKey,
  createEmptyConfigDocument,
  createEmptyCredentialsDocument,
  parseConfigDocument,
  parseCredentialsDocument,
  validateConfigurationPair,
  type ConfigDocument,
  type CredentialsDocument,
  type StoredProviderProfile
} from "./model";

export const CONFIG_SECRET_TRANSACTION_KIND = "library-config-secret-mutation";

export interface ConfigStoragePaths {
  readonly root: string;
  readonly config: string;
  readonly credentials: string;
  readonly configLock: string;
  readonly credentialsLock: string;
}

export interface RuntimeProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly endpoints: ProviderEndpointSet;
  readonly normalizedEndpoints: NormalizedProviderEndpointSet;
  readonly defaultModel?: string;
  readonly models: readonly string[];
  readonly capabilities: readonly ProviderCapabilityRecord[];
  readonly credential?: string;
}

export interface LibrarySettingsStoreOptions {
  readonly dataRoot?: string;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly lockOptions?: AcquireFileLockOptions;
  readonly protectCredentialFile?: (filePath: string) => Promise<void>;
  readonly outputDirectory?: Omit<ValidateOutputDirectoryOptions, "homeDirectory" | "platform">;
}

interface LoadedState {
  readonly config: ConfigDocument;
  readonly credentials: CredentialsDocument;
}

interface ConfigTransactionMetadata {
  readonly configRevisionBefore: number;
  readonly configRevisionAfter: number;
  readonly credentialsRevisionBefore: number;
  readonly credentialsRevisionAfter: number;
}

function selectedPathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function createConfigStoragePaths(options: {
  readonly dataRoot?: string;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
} = {}): ConfigStoragePaths {
  const platform = options.platform ?? process.platform;
  const pathApi = selectedPathApi(platform);
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const root = pathApi.resolve(
    options.dataRoot ?? pathApi.join(homeDirectory, ".codex", "routego-image")
  );
  return {
    root,
    config: pathApi.join(root, "config.json"),
    credentials: pathApi.join(root, "credentials.json"),
    configLock: pathApi.join(root, ".locks", "config.lock"),
    credentialsLock: pathApi.join(root, ".locks", "credentials.lock")
  };
}

function timestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new LibraryError("invalid_input", "The settings clock is invalid.");
  }
  return date.toISOString();
}

function safeDocumentError(label: string): LibraryError {
  return new LibraryError("config_corrupt", `${label} is malformed or invalid.`);
}

async function readJsonValue(filePath: string, label: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw error;
    throw safeDocumentError(label);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw safeDocumentError(label);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw safeDocumentError(label);
  }
}

async function readVersionedDocument<T>(options: {
  readonly filePath: string;
  readonly label: string;
  readonly parse: (value: unknown) => T;
  readonly writeOptions?: { readonly applyPermissions?: (filePath: string) => Promise<void> };
}): Promise<T | undefined> {
  let primaryError: unknown;
  try {
    return options.parse(await readJsonValue(options.filePath, options.label));
  } catch (error) {
    if (error instanceof LibraryError && error.code === "unsupported_version") throw error;
    primaryError = error;
  }

  const backupPath = `${options.filePath}.bak`;
  try {
    const recovered = options.parse(await readJsonValue(backupPath, `${options.label} backup`));
    if (!isNodeError(primaryError, "ENOENT")) {
      const preserved = `${options.filePath}.corrupt-${randomUUID()}`;
      try {
        await rename(options.filePath, preserved);
        if (options.writeOptions?.applyPermissions) {
          try {
            await options.writeOptions.applyPermissions(preserved);
          } catch {
            await rename(preserved, options.filePath).catch(() => undefined);
            throw safeDocumentError(options.label);
          }
        }
      } catch {
        throw safeDocumentError(options.label);
      }
    }
    await writeJsonAtomic(options.filePath, recovered, options.writeOptions);
    return recovered;
  } catch (backupError) {
    if (backupError instanceof LibraryError && backupError.code === "unsupported_version") {
      throw backupError;
    }
    if (isNodeError(primaryError, "ENOENT") && isNodeError(backupError, "ENOENT")) {
      return undefined;
    }
    if (isNodeError(primaryError, "ENOENT")) throw safeDocumentError(`${options.label} backup`);
    throw primaryError;
  }
}

function apiKeyPreview(credential: string): string {
  return `key-${createHash("sha256").update(credential, "utf8").digest("hex").slice(0, 10)}`;
}

function descriptorEndpoints(endpoints: ProviderEndpointSet): ProviderProfileDescriptor["endpoints"] {
  return {
    generation: describeProviderEndpoint(endpoints.generation.value, endpoints.generation.mode),
    ...(endpoints.models === undefined
      ? {}
      : { models: describeProviderEndpoint(endpoints.models, "exact-generation-endpoint") }),
    ...(endpoints.edits === undefined
      ? {}
      : { edits: describeProviderEndpoint(endpoints.edits, "exact-generation-endpoint") }),
    ...(endpoints.responses === undefined
      ? {}
      : { responses: describeProviderEndpoint(endpoints.responses, "exact-generation-endpoint") })
  };
}

function parseTransactionMetadata(journal: FileTransactionJournal): ConfigTransactionMetadata {
  const metadata = journal.metadata;
  const values = [
    metadata?.["configRevisionBefore"],
    metadata?.["configRevisionAfter"],
    metadata?.["credentialsRevisionBefore"],
    metadata?.["credentialsRevisionAfter"]
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new LibraryError("config_corrupt", "Configuration recovery metadata is invalid.");
  }
  return {
    configRevisionBefore: values[0] as number,
    configRevisionAfter: values[1] as number,
    credentialsRevisionBefore: values[2] as number,
    credentialsRevisionAfter: values[3] as number
  };
}

function capabilityEvidenceKey(record: ProviderCapabilityRecord): string {
  return capabilityRecordKey(record);
}

export class LibrarySettingsStore {
  readonly #platform: NodeJS.Platform;
  readonly #homeDirectory: string;
  readonly #paths: ConfigStoragePaths;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #lockOptions: AcquireFileLockOptions | undefined;
  readonly #protectCredentialFile: (filePath: string) => Promise<void>;
  readonly #outputDirectoryOptions:
    | Omit<ValidateOutputDirectoryOptions, "homeDirectory" | "platform">
    | undefined;

  constructor(options: LibrarySettingsStoreOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#homeDirectory = options.homeDirectory ?? os.homedir();
    this.#paths = createConfigStoragePaths({
      ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
      homeDirectory: this.#homeDirectory,
      platform: this.#platform
    });
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => `provider-${randomUUID()}`);
    this.#lockOptions = options.lockOptions;
    this.#protectCredentialFile =
      options.protectCredentialFile ??
      ((filePath) => restrictFileToCurrentUser({ filePath, platform: this.#platform }));
    this.#outputDirectoryOptions = options.outputDirectory;
  }

  get paths(): ConfigStoragePaths {
    return this.#paths;
  }

  async #withLocks<T>(callback: () => Promise<T>): Promise<T> {
    await ensurePrivateDirectory(this.#paths.root, this.#platform);
    const configLock = await acquireFileLock(
      this.#paths.configLock,
      "routego-image-config",
      this.#lockOptions
    );
    let credentialsLock: Awaited<ReturnType<typeof acquireFileLock>> | undefined;
    try {
      credentialsLock = await acquireFileLock(
        this.#paths.credentialsLock,
        "routego-image-credentials",
        this.#lockOptions
      );
      return await callback();
    } finally {
      await credentialsLock?.release();
      await configLock.release();
    }
  }

  async #protectExistingCredentialFiles(): Promise<void> {
    for (const candidate of [this.#paths.credentials, `${this.#paths.credentials}.bak`]) {
      try {
        await access(candidate);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) continue;
        throw new LibraryError("access_denied", "Credential permissions cannot be verified.");
      }
      await this.#protectCredentialFile(candidate);
    }
  }

  async #readConfig(): Promise<ConfigDocument | undefined> {
    return readVersionedDocument({
      filePath: this.#paths.config,
      label: "Configuration document",
      parse: parseConfigDocument
    });
  }

  async #readCredentials(): Promise<CredentialsDocument | undefined> {
    return readVersionedDocument({
      filePath: this.#paths.credentials,
      label: "Credential document",
      parse: parseCredentialsDocument,
      writeOptions: { applyPermissions: this.#protectCredentialFile }
    });
  }

  async #readConfigBackup(): Promise<ConfigDocument> {
    try {
      return parseConfigDocument(
        await readJsonValue(`${this.#paths.config}.bak`, "Configuration backup")
      );
    } catch (error) {
      if (error instanceof LibraryError && error.code === "unsupported_version") throw error;
      throw new LibraryError("config_corrupt", "Configuration recovery backup is unavailable.");
    }
  }

  async #recoverConfigTransaction(): Promise<void> {
    const journals = (await listTransactionJournals(this.#paths.root)).filter(
      (journal) => journal.kind === CONFIG_SECRET_TRANSACTION_KIND
    );
    if (journals.length > 1) {
      throw new LibraryError("config_corrupt", "Multiple configuration recoveries are pending.");
    }
    const journal = journals[0];
    if (!journal) return;
    const metadata = parseTransactionMetadata(journal);
    const config = await this.#readConfig();
    const credentials = await this.#readCredentials();
    if (!config || !credentials) {
      throw new LibraryError("config_corrupt", "Configuration recovery documents are missing.");
    }
    if (credentials.revision === metadata.credentialsRevisionAfter) {
      if (config.revision !== metadata.configRevisionAfter) {
        throw new LibraryError("config_corrupt", "Configuration recovery revisions disagree.");
      }
      await removeTransactionJournal(this.#paths.root, journal.id);
      return;
    }
    if (journal.state === "committed") {
      throw new LibraryError("config_corrupt", "Committed credential recovery is incomplete.");
    }
    if (credentials.revision !== metadata.credentialsRevisionBefore) {
      throw new LibraryError("config_corrupt", "Credential recovery revision is unknown.");
    }
    const previous = await this.#readConfigBackup();
    if (previous.revision !== metadata.configRevisionBefore) {
      throw new LibraryError("config_corrupt", "Configuration recovery backup revision is invalid.");
    }
    await writeJsonAtomic(this.#paths.config, previous);
    await removeTransactionJournal(this.#paths.root, journal.id);
  }

  async #loadUnderLocks(): Promise<LoadedState> {
    await ensurePrivateDirectory(this.#paths.root, this.#platform);
    await Promise.all([
      cleanupAtomicJsonTemporaryFiles(this.#paths.config, { olderThanMs: 0 }),
      cleanupAtomicJsonTemporaryFiles(this.#paths.credentials, { olderThanMs: 0 })
    ]);
    let config = await this.#readConfig();
    let credentials = await this.#readCredentials();
    if (!config) {
      if (credentials && Object.keys(credentials.apiKeys).length > 0) {
        throw new LibraryError("config_corrupt", "Configuration document is missing.");
      }
      config = createEmptyConfigDocument();
      await writeJsonAtomic(this.#paths.config, config);
    }
    if (!credentials) {
      credentials = createEmptyCredentialsDocument();
      await writeJsonAtomic(this.#paths.credentials, credentials, {
        applyPermissions: this.#protectCredentialFile
      });
    }
    await this.#protectExistingCredentialFiles();
    await this.#recoverConfigTransaction();
    config = await this.#readConfig();
    credentials = await this.#readCredentials();
    if (!config || !credentials) {
      throw new LibraryError("config_corrupt", "Configuration documents are unavailable.");
    }
    if (config.outputDirectory.mode === "custom") {
      try {
        canonicalizeOutputDirectorySyntax(config.outputDirectory.path, {
          homeDirectory: this.#homeDirectory,
          platform: this.#platform === "win32" ? "win32" : "posix",
          ...this.#outputDirectoryOptions
        });
      } catch {
        throw new LibraryError("config_corrupt", "Stored output-directory state is unsafe.");
      }
    }
    validateConfigurationPair(config, credentials);
    return { config, credentials };
  }

  async #load(): Promise<LoadedState> {
    return this.#withLocks(() => this.#loadUnderLocks());
  }

  #descriptor(
    profile: StoredProviderProfile,
    state: LoadedState
  ): ProviderProfileDescriptor {
    const credential = state.credentials.apiKeys[profile.id];
    return {
      id: profile.id,
      name: profile.name,
      endpoints: descriptorEndpoints(profile.endpoints),
      ...(profile.defaultModel === undefined ? {} : { defaultModel: profile.defaultModel }),
      models: [...profile.models],
      hasApiKey: credential !== undefined,
      ...(credential === undefined ? {} : { apiKeyPreview: apiKeyPreview(credential) }),
      isActive: state.config.activeProviderId === profile.id,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt
    };
  }

  #settingsResult(state: LoadedState): ReadSettingsResult {
    const outputDirectory =
      state.config.outputDirectory.mode === "clear"
        ? { configured: false as const }
        : state.config.outputDirectory.mode === "default"
          ? { configured: true as const, display: defaultOutputDirectoryDisplay() }
          : {
              configured: true as const,
              display: redactOutputDirectoryDisplay(
                state.config.outputDirectory.path,
                this.#platform === "win32" ? "win32" : "posix"
              )
            };
    return readSettingsResultSchema.parse({
      schemaVersion: 1,
      ...(state.config.activeProviderId === undefined
        ? {}
        : { activeProviderId: state.config.activeProviderId }),
      profiles: state.config.profiles.map((profile) => this.#descriptor(profile, state)),
      defaults: state.config.defaults,
      outputDirectory
    });
  }

  async #commitConfig(previous: ConfigDocument, next: ConfigDocument): Promise<ConfigDocument> {
    if (next.revision !== previous.revision + 1) {
      throw new LibraryError("internal_contract", "Configuration revision did not advance.");
    }
    const validated = parseConfigDocument(next);
    await writeJsonAtomic(this.#paths.config, validated);
    return validated;
  }

  async #commitConfigAndCredentials(
    previous: LoadedState,
    nextConfig: ConfigDocument,
    nextCredentials: CredentialsDocument
  ): Promise<void> {
    if (
      nextConfig.revision !== previous.config.revision + 1 ||
      nextCredentials.revision !== previous.credentials.revision + 1
    ) {
      throw new LibraryError("internal_contract", "Configuration transaction revision is invalid.");
    }
    const validatedConfig = parseConfigDocument(nextConfig);
    const validatedCredentials = parseCredentialsDocument(nextCredentials);
    validateConfigurationPair(validatedConfig, validatedCredentials);
    const id = `config-${randomUUID()}`;
    const journal: FileTransactionJournal = {
      schemaVersion: 1,
      id,
      kind: CONFIG_SECRET_TRANSACTION_KIND,
      state: "prepared",
      createdAt: timestamp(this.#now()),
      createdPaths: [],
      deleteAfterCommitPaths: [],
      metadata: {
        configRevisionBefore: previous.config.revision,
        configRevisionAfter: nextConfig.revision,
        credentialsRevisionBefore: previous.credentials.revision,
        credentialsRevisionAfter: nextCredentials.revision
      }
    };
    await writeTransactionJournal(this.#paths.root, journal);
    try {
      await writeJsonAtomic(this.#paths.config, validatedConfig);
    } catch (error) {
      await removeTransactionJournal(this.#paths.root, id).catch(() => undefined);
      throw error;
    }

    let credentialsCommitted = false;
    try {
      await writeJsonAtomic(this.#paths.credentials, validatedCredentials, {
        applyPermissions: this.#protectCredentialFile
      });
      credentialsCommitted = true;
    } catch (error) {
      const current = await this.#readCredentials().catch(() => undefined);
      credentialsCommitted = current?.revision === nextCredentials.revision;
      if (!credentialsCommitted) {
        await writeJsonAtomic(this.#paths.config, previous.config);
        await removeTransactionJournal(this.#paths.root, id).catch(() => undefined);
        if (error instanceof LibraryError) throw error;
        throw new LibraryError("access_denied", "Credential mutation could not be stored.");
      }
    }
    if (credentialsCommitted) {
      await markTransactionJournalCommitted(this.#paths.root, journal).catch(() => undefined);
      await removeTransactionJournal(this.#paths.root, id).catch(() => undefined);
    }
  }

  async readSettings(input: ReadSettingsInput = {}): Promise<ReadSettingsResult> {
    readSettingsInputSchema.parse(input);
    return this.#settingsResult(await this.#load());
  }

  async upsertProviderProfile(
    input: UpsertProviderProfileInput
  ): Promise<UpsertProviderProfileResult> {
    const parsed = upsertProviderProfileInputSchema.parse(input);
    return this.#withLocks(async () => {
      const state = await this.#loadUnderLocks();
      const now = timestamp(this.#now());
      let profileId: string;
      try {
        profileId = identifierSchema.parse(parsed.profileId ?? this.#idFactory());
      } catch {
        throw new LibraryError("invalid_input", "The provider profile identity is invalid.");
      }
      const existing = state.config.profiles.find((profile) => profile.id === profileId);
      const models =
        parsed.defaultModel === undefined
          ? (existing?.models ?? [])
          : Array.from(new Set([parsed.defaultModel, ...(existing?.models ?? [])])).slice(0, 500);
      const profile: StoredProviderProfile = {
        id: profileId,
        name: parsed.name,
        endpoints: parsed.endpoints,
        ...(parsed.defaultModel === undefined
          ? existing?.defaultModel === undefined
            ? {}
            : { defaultModel: existing.defaultModel }
          : { defaultModel: parsed.defaultModel }),
        models,
        ...(existing?.modelsRefreshedAt === undefined
          ? {}
          : { modelsRefreshedAt: existing.modelsRefreshedAt }),
        capabilities: existing?.capabilities ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      const profiles = [
        ...state.config.profiles.filter((item) => item.id !== profileId),
        profile
      ];
      const activeProviderId = parsed.setActive
        ? profileId
        : state.config.activeProviderId;
      const { activeProviderId: _previousActiveProviderId, ...configWithoutActive } =
        state.config;
      const nextConfig: ConfigDocument = {
        ...configWithoutActive,
        revision: state.config.revision + 1,
        ...(activeProviderId === undefined ? {} : { activeProviderId }),
        profiles
      };
      let nextCredentials = state.credentials;
      if (parsed.apiKey.operation !== "unchanged") {
        const apiKeys = { ...state.credentials.apiKeys };
        if (parsed.apiKey.operation === "replace") apiKeys[profileId] = parsed.apiKey.value;
        else delete apiKeys[profileId];
        nextCredentials = {
          ...state.credentials,
          revision: state.credentials.revision + 1,
          apiKeys
        };
        await this.#commitConfigAndCredentials(state, nextConfig, nextCredentials);
      } else {
        await this.#commitConfig(state.config, nextConfig);
      }
      const nextState = { config: nextConfig, credentials: nextCredentials };
      return upsertProviderProfileResultSchema.parse({
        schemaVersion: 1,
        profile: this.#descriptor(profile, nextState),
        ...(activeProviderId === undefined ? {} : { activeProviderId })
      });
    });
  }

  async removeProviderProfile(
    input: RemoveProviderProfileInput
  ): Promise<RemoveProviderProfileResult> {
    const parsed = removeProviderProfileInputSchema.parse(input);
    return this.#withLocks(async () => {
      const state = await this.#loadUnderLocks();
      if (!state.config.profiles.some((profile) => profile.id === parsed.profileId)) {
        throw new LibraryError("not_found", "The provider profile does not exist.");
      }
      const activeProviderId =
        state.config.activeProviderId === parsed.profileId
          ? undefined
          : state.config.activeProviderId;
      const { activeProviderId: _previousActiveProviderId, ...configWithoutActive } =
        state.config;
      const nextConfig: ConfigDocument = {
        ...configWithoutActive,
        revision: state.config.revision + 1,
        ...(activeProviderId === undefined ? {} : { activeProviderId }),
        profiles: state.config.profiles.filter((profile) => profile.id !== parsed.profileId)
      };
      if (state.credentials.apiKeys[parsed.profileId] !== undefined) {
        const apiKeys = { ...state.credentials.apiKeys };
        delete apiKeys[parsed.profileId];
        await this.#commitConfigAndCredentials(state, nextConfig, {
          ...state.credentials,
          revision: state.credentials.revision + 1,
          apiKeys
        });
      } else {
        await this.#commitConfig(state.config, nextConfig);
      }
      return removeProviderProfileResultSchema.parse({
        schemaVersion: 1,
        removedProfileId: parsed.profileId,
        ...(activeProviderId === undefined ? {} : { activeProviderId })
      });
    });
  }

  async setActiveProviderProfile(
    input: SetActiveProviderProfileInput
  ): Promise<SetActiveProviderProfileResult> {
    const parsed = setActiveProviderProfileInputSchema.parse(input);
    return this.#withLocks(async () => {
      const state = await this.#loadUnderLocks();
      const selected = state.config.profiles.find((profile) => profile.id === parsed.profileId);
      if (!selected) throw new LibraryError("not_found", "The provider profile does not exist.");
      const updated: StoredProviderProfile = { ...selected, updatedAt: timestamp(this.#now()) };
      const nextConfig: ConfigDocument = {
        ...state.config,
        revision: state.config.revision + 1,
        activeProviderId: parsed.profileId,
        profiles: state.config.profiles.map((profile) =>
          profile.id === parsed.profileId ? updated : profile
        )
      };
      await this.#commitConfig(state.config, nextConfig);
      const nextState = { config: nextConfig, credentials: state.credentials };
      return setActiveProviderProfileResultSchema.parse({
        schemaVersion: 1,
        activeProviderId: parsed.profileId,
        profile: this.#descriptor(updated, nextState)
      });
    });
  }

  async studioProviderSwitch(
    input: StudioProviderSwitchInput
  ): Promise<StudioProviderSwitchResult> {
    const parsed = studioProviderSwitchInputSchema.parse(input);
    return this.#withLocks(async () => {
      const state = await this.#loadUnderLocks();
      const selected = state.config.profiles.find((profile) => profile.id === parsed.profileId);
      if (!selected) throw new LibraryError("not_found", "The provider profile does not exist.");

      const preferredModel = parsed.preferredModel ?? state.config.defaults.model;
      const modelPreserved =
        preferredModel !== undefined && selected.models.includes(preferredModel);
      const selectedModel = modelPreserved ? preferredModel : selected.defaultModel;
      if (selectedModel === undefined || !selected.models.includes(selectedModel)) {
        throw new LibraryError("invalid_input", "The target provider has no valid default model.");
      }

      const updated: StoredProviderProfile = { ...selected, updatedAt: timestamp(this.#now()) };
      const nextConfig: ConfigDocument = {
        ...state.config,
        revision: state.config.revision + 1,
        activeProviderId: selected.id,
        profiles: state.config.profiles.map((profile) => profile.id === selected.id ? updated : profile),
        defaults: { ...state.config.defaults, model: selectedModel }
      };
      await this.#commitConfig(state.config, nextConfig);
      const nextState = { config: nextConfig, credentials: state.credentials };
      return studioProviderSwitchResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        activeProviderId: selected.id,
        selectedModel,
        modelPreserved,
        profile: this.#descriptor(updated, nextState),
        appliesToFutureSubmissionsOnly: true
      });
    });
  }

  async updateSettings(input: UpdateSettingsInput): Promise<UpdateSettingsResult> {
    const parsed = updateSettingsInputSchema.parse(input);
    let customPath: string | undefined;
    if (parsed.outputDirectory?.operation === "replace") {
      customPath = await validateOutputDirectory(parsed.outputDirectory.path, {
        homeDirectory: this.#homeDirectory,
        platform: this.#platform === "win32" ? "win32" : "posix",
        ...this.#outputDirectoryOptions
      });
    }
    return this.#withLocks(async () => {
      const state = await this.#loadUnderLocks();
      const outputDirectory =
        parsed.outputDirectory === undefined || parsed.outputDirectory.operation === "unchanged"
          ? state.config.outputDirectory
          : parsed.outputDirectory.operation === "default"
            ? ({ mode: "default" } as const)
            : parsed.outputDirectory.operation === "clear"
              ? ({ mode: "clear" } as const)
              : ({ mode: "custom", path: customPath! } as const);
      const nextConfig: ConfigDocument = {
        ...state.config,
        revision: state.config.revision + 1,
        defaults: parsed.defaults ?? state.config.defaults,
        outputDirectory
      };
      await this.#commitConfig(state.config, nextConfig);
      return updateSettingsResultSchema.parse(
        this.#settingsResult({ config: nextConfig, credentials: state.credentials })
      );
    });
  }

  async persistModelRefresh(result: RefreshModelsResult): Promise<void> {
    const parsed = refreshModelsResultSchema.parse(result);
    if (parsed.status !== "succeeded") return;
    const refreshedAt = parsed.refreshedAt;
    if (refreshedAt === undefined) {
      throw new LibraryError("internal_contract", "Successful model refresh lacks a timestamp.");
    }
    await this.#withLocks(async () => {
      const state = await this.#loadUnderLocks();
      const profile = state.config.profiles.find((item) => item.id === parsed.providerId);
      if (!profile) throw new LibraryError("not_found", "The provider profile does not exist.");
      const updated: StoredProviderProfile = {
        ...profile,
        models: Array.from(new Set(parsed.models)),
        modelsRefreshedAt: refreshedAt,
        updatedAt: refreshedAt
      };
      await this.#commitConfig(state.config, {
        ...state.config,
        revision: state.config.revision + 1,
        profiles: state.config.profiles.map((item) =>
          item.id === profile.id ? updated : item
        )
      });
    });
  }

  async persistCapabilityProbe(result: CapabilityProbeResult): Promise<void> {
    const parsed = capabilityProbeResultSchema.parse(result);
    await this.#withLocks(async () => {
      const state = await this.#loadUnderLocks();
      const profile = state.config.profiles.find((item) => item.id === parsed.providerId);
      if (!profile) throw new LibraryError("not_found", "The provider profile does not exist.");
      const key = capabilityEvidenceKey(parsed.record);
      const existing = profile.capabilities.find((item) => capabilityEvidenceKey(item) === key);
      let record = parsed.record;
      if (parsed.status === "failed" && existing) {
        const evidence = [...existing.evidence, ...parsed.record.evidence].slice(-32);
        record = providerCapabilityRecordSchema.parse({ ...existing, evidence });
      }
      const capabilities = [
        ...profile.capabilities.filter((item) => capabilityEvidenceKey(item) !== key),
        record
      ];
      const updated: StoredProviderProfile = {
        ...profile,
        capabilities,
        updatedAt: timestamp(this.#now())
      };
      await this.#commitConfig(state.config, {
        ...state.config,
        revision: state.config.revision + 1,
        profiles: state.config.profiles.map((item) =>
          item.id === profile.id ? updated : item
        )
      });
    });
  }

  async getRuntimeProviderProfile(profileId?: string): Promise<RuntimeProviderProfile> {
    const state = await this.#load();
    const selectedId = profileId ?? state.config.activeProviderId;
    if (!selectedId) throw new LibraryError("config_missing", "No active provider is configured.");
    const profile = state.config.profiles.find((item) => item.id === selectedId);
    if (!profile) throw new LibraryError("config_corrupt", "The active provider is unavailable.");
    const credential = state.credentials.apiKeys[profile.id];
    return {
      id: profile.id,
      name: profile.name,
      endpoints: profile.endpoints,
      normalizedEndpoints: normalizeProviderEndpoints(profile.endpoints),
      ...(profile.defaultModel === undefined ? {} : { defaultModel: profile.defaultModel }),
      models: profile.models,
      capabilities: profile.capabilities,
      ...(credential === undefined ? {} : { credential })
    };
  }

  async resolveOutputDirectory(): Promise<string | undefined> {
    const state = await this.#load();
    if (state.config.outputDirectory.mode === "clear") return undefined;
    if (state.config.outputDirectory.mode === "custom") {
      return validateOutputDirectory(state.config.outputDirectory.path, {
        homeDirectory: this.#homeDirectory,
        platform: this.#platform === "win32" ? "win32" : "posix",
        ...this.#outputDirectoryOptions
      });
    }
    return selectedPathApi(this.#platform).join(
      this.#homeDirectory,
      "Pictures",
      "routego-image",
      "library"
    );
  }
}
