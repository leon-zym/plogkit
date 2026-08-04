import { importedAssetId } from "@/core/document";
import { editIntents } from "@/core/editing";
import {
  createDraftLibrary,
  draftId,
  type DraftId,
  type DraftLibrary,
  type DraftLibraryFileAdapter,
  type DraftLibraryPreviewAdapter,
  type DraftThumbnailAdapter,
  type ImportCandidate,
} from "@/services/drafts/draftLibrary";
import {
  createCurrentEditingSession,
  type CurrentEditingSession,
  type CurrentEditingSessionHandle,
} from "@/services/session/currentEditingSession";
import reliabilityEventContract from "../../../../scripts/reliability-soak/event-contract.json";

type StoredValue = string | Uint8Array;

class ReliabilityMemoryFiles implements DraftLibraryFileAdapter {
  readonly files = new Map<string, StoredValue>();
  readonly directories = new Set<string>();
  private readonly triggeredFaults = new Set<string>();
  private moveCalls = 0;
  private replacementFault: {
    readonly moveCall: number;
    readonly phase: "before" | "after-removal" | "after-copy";
    readonly interrupted: boolean;
  } | null = null;
  private interrupted = false;
  private readFailure: "read" | "probe" | "list" | null = null;
  private failNextDirectoryRemoval = false;
  private failNextDirectoryPublication = false;
  private moveGate: {
    readonly started: () => void;
    readonly completion: Promise<void>;
    readonly faultName: string;
  } | null = null;
  private readGate: {
    readonly started: () => void;
    readonly completion: Promise<void>;
    readonly faultName: string;
  } | null = null;
  private copyGate: {
    readonly started: () => void;
    readonly completion: Promise<void>;
    readonly faultName: string;
  } | null = null;
  private markerFault: {
    readonly marker: "publication" | "deletion";
    readonly phase: "before-write" | "after-write-unknown";
    readMustFail: boolean;
  } | null = null;

  armMoveInterruption(moveCall: number): void {
    this.moveCalls = 0;
    this.replacementFault = { moveCall, phase: "after-copy", interrupted: true };
  }

  acknowledgeFault(name: string): void {
    this.triggeredFaults.add(name);
  }

  clearTriggeredFaults(): void {
    this.triggeredFaults.clear();
  }

  consumeTriggeredFaults(): readonly string[] {
    const faults = [...this.triggeredFaults].sort();
    this.triggeredFaults.clear();
    return faults;
  }

  armReadFailure(kind: "read" | "probe" | "list"): void {
    this.readFailure = kind;
  }

  armReplacementFailure(phase: "before" | "after-removal" | "after-copy"): void {
    this.moveCalls = 0;
    this.replacementFault = { moveCall: 2, phase, interrupted: false };
  }

  armDirectoryRemovalFailure(): void {
    this.failNextDirectoryRemoval = true;
  }

  armDirectoryPublicationFailure(): void {
    this.failNextDirectoryPublication = true;
  }

  gateNextMove(faultName = "dirty-save-new-edit"): {
    readonly started: Promise<void>;
    readonly release: () => void;
  } {
    return this.installGate("move", faultName);
  }

  gateNextRead(): { readonly started: Promise<void>; readonly release: () => void } {
    return this.installGate("read", "switch-validation-new-edit");
  }

  gateNextCopy(): { readonly started: Promise<void>; readonly release: () => void } {
    return this.installGate("copy", "ingest-switch-delete");
  }

  private installGate(
    kind: "move" | "read" | "copy",
    faultName: string,
  ): {
    readonly started: Promise<void>;
    readonly release: () => void;
  } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = { started: markStarted, completion, faultName };
    if (kind === "move") this.moveGate = gate;
    else if (kind === "read") this.readGate = gate;
    else this.copyGate = gate;
    return { started, release };
  }

  armMarkerFailure(
    marker: "publication" | "deletion",
    phase: "before-write" | "after-write-unknown",
  ): void {
    this.markerFault = { marker, phase, readMustFail: false };
  }

  clearTransientFaults(): void {
    this.readFailure = null;
    this.replacementFault = null;
    this.failNextDirectoryRemoval = false;
    this.failNextDirectoryPublication = false;
    this.markerFault = null;
  }

  restartProcess(): void {
    this.interrupted = false;
    this.replacementFault = null;
    this.moveCalls = 0;
    this.clearTransientFaults();
  }

  private assertAvailable(): void {
    if (this.interrupted) throw new Error("simulated process interruption");
  }

  private markerFor(uri: string): "publication" | "deletion" | null {
    if (uri.endsWith("/publication.json")) return "publication";
    if (uri.includes("/deletions/") && uri.endsWith(".json")) return "deletion";
    return null;
  }

  private assertReadable(uri: string, kind: "read" | "probe" | "list"): void {
    this.assertAvailable();
    if (this.readFailure === kind) {
      this.acknowledgeFault(kind);
      throw new Error(`simulated ${kind} failure`);
    }
    const marker = this.markerFor(uri);
    if (this.markerFault?.readMustFail && marker === this.markerFault.marker) {
      throw new Error("simulated unknown marker result");
    }
  }

  async fileExists(uri: string): Promise<boolean> {
    this.assertReadable(uri, "probe");
    return this.files.has(uri);
  }

  async directoryExists(uri: string): Promise<boolean> {
    this.assertReadable(uri, "probe");
    return this.directories.has(uri);
  }

  async ensureDirectory(uri: string): Promise<void> {
    this.assertAvailable();
    this.directories.add(uri);
  }

  async readText(uri: string): Promise<string> {
    this.assertReadable(uri, "read");
    const gate = this.readGate;
    if (gate !== null) {
      this.readGate = null;
      this.acknowledgeFault(gate.faultName);
      gate.started();
      await gate.completion;
    }
    const value = this.files.get(uri);
    if (typeof value !== "string") throw new Error(`missing text ${uri}`);
    return value;
  }

  async writeText(uri: string, content: string): Promise<void> {
    this.assertAvailable();
    const marker = this.markerFor(uri);
    if (
      marker !== null &&
      this.markerFault?.marker === marker &&
      this.markerFault.phase === "before-write"
    ) {
      this.acknowledgeFault("write-before");
      this.acknowledgeFault(`${marker}-marker`);
      throw new Error(`simulated ${marker} write failure`);
    }
    this.files.set(uri, content);
    if (
      marker !== null &&
      this.markerFault?.marker === marker &&
      this.markerFault.phase === "after-write-unknown"
    ) {
      this.acknowledgeFault("write-committed-unknown");
      this.acknowledgeFault(`${marker}-marker`);
      this.markerFault.readMustFail = true;
      throw new Error(`simulated ${marker} result unavailable`);
    }
  }

  async copy(sourceUri: string, destinationUri: string): Promise<void> {
    this.assertAvailable();
    const gate = this.copyGate;
    if (gate !== null) {
      this.copyGate = null;
      this.acknowledgeFault(gate.faultName);
      gate.started();
      await gate.completion;
    }
    const source = this.files.get(sourceUri);
    if (source === undefined) throw new Error(`missing source ${sourceUri}`);
    this.files.set(destinationUri, source);
  }

  async moveFile(sourceUri: string, destinationUri: string): Promise<void> {
    this.assertAvailable();
    this.moveCalls += 1;
    const gate = this.moveGate;
    if (gate !== null) {
      this.moveGate = null;
      this.acknowledgeFault(gate.faultName);
      gate.started();
      await gate.completion;
    }
    const source = this.files.get(sourceUri);
    if (source === undefined) throw new Error(`missing source ${sourceUri}`);
    if (this.files.has(destinationUri)) throw new Error(`destination exists ${destinationUri}`);
    const fault = this.replacementFault?.moveCall === this.moveCalls ? this.replacementFault : null;
    if (fault !== null) {
      this.replacementFault = null;
      if (fault.phase === "after-removal") this.files.delete(destinationUri);
      if (fault.phase === "after-copy") this.files.set(destinationUri, source);
      this.acknowledgeFault(
        fault.interrupted
          ? "replacement-interrupted"
          : fault.phase === "after-removal"
            ? "replacement-after-remove"
            : `replacement-${fault.phase}`,
      );
      if (fault.interrupted) this.interrupted = true;
      throw new Error(`simulated ${fault.interrupted ? "interruption" : "failure"} ${fault.phase}`);
    }
    this.files.delete(sourceUri);
    this.files.set(destinationUri, source);
  }

  async moveDirectory(sourceUri: string, destinationUri: string): Promise<void> {
    this.assertAvailable();
    if (!this.directories.has(sourceUri)) throw new Error(`missing directory ${sourceUri}`);
    if (this.directories.has(destinationUri)) {
      throw new Error(`destination directory exists ${destinationUri}`);
    }
    if (this.failNextDirectoryPublication) {
      this.failNextDirectoryPublication = false;
      this.acknowledgeFault("directory-publication");
      this.directories.add(destinationUri);
      const partial = [...this.files.entries()].find(([uri]) => uri.startsWith(`${sourceUri}/`));
      if (partial !== undefined) {
        const [uri, value] = partial;
        this.files.set(`${destinationUri}${uri.slice(sourceUri.length)}`, value);
      }
      throw new Error("simulated partial directory publication");
    }
    this.directories.delete(sourceUri);
    this.directories.add(destinationUri);
    for (const directory of [...this.directories]) {
      if (!directory.startsWith(`${sourceUri}/`)) continue;
      this.directories.delete(directory);
      this.directories.add(`${destinationUri}${directory.slice(sourceUri.length)}`);
    }
    for (const [uri, value] of [...this.files]) {
      if (!uri.startsWith(`${sourceUri}/`)) continue;
      this.files.delete(uri);
      this.files.set(`${destinationUri}${uri.slice(sourceUri.length)}`, value);
    }
  }

  async removeFile(uri: string): Promise<void> {
    this.assertAvailable();
    this.files.delete(uri);
  }

  async removeDirectory(uri: string): Promise<void> {
    this.assertAvailable();
    if (this.failNextDirectoryRemoval) {
      this.failNextDirectoryRemoval = false;
      this.acknowledgeFault("cleanup");
      throw new Error("simulated directory removal failure");
    }
    this.directories.delete(uri);
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`${uri}/`)) this.files.delete(path);
    }
    for (const path of [...this.directories]) {
      if (path.startsWith(`${uri}/`)) this.directories.delete(path);
    }
  }

  async listDirectories(uri: string): Promise<readonly string[]> {
    this.assertReadable(uri, "list");
    const prefix = `${uri.replace(/\/$/, "")}/`;
    const children = new Set<string>();
    for (const path of this.directories) {
      if (!path.startsWith(prefix)) continue;
      const name = path.slice(prefix.length).split("/", 1)[0];
      if (name !== undefined && name.length > 0) children.add(`${prefix}${name}`);
    }
    return [...children];
  }

  async listFiles(uri: string): Promise<readonly string[]> {
    this.assertReadable(uri, "list");
    const prefix = `${uri.replace(/\/$/, "")}/`;
    return [...this.files.keys()].filter((path) => {
      if (!path.startsWith(prefix)) return false;
      const relative = path.slice(prefix.length);
      return relative.length > 0 && !relative.includes("/");
    });
  }
}

const candidate = (name: string): ImportCandidate => ({
  uri: `picker://${name}.jpg`,
  width: 1200,
  height: 800,
  fileName: `${name}.jpg`,
  kind: "image",
  exif: null,
});

interface ReliabilityIdentities {
  readonly seed: number;
  draftSequence: number;
  assetSequence: number;
  storageSequence: number;
  operationSequence: number;
  thumbnailSequence: number;
  clockSequence: number;
}

class ReliabilityThumbnails implements DraftThumbnailAdapter {
  private deferred: {
    readonly started: () => void;
    readonly completion: Promise<void>;
  } | null = null;

  constructor(private readonly files: ReliabilityMemoryFiles) {}

  deferNext(): { readonly started: Promise<void>; readonly release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.deferred = { started: markStarted, completion };
    return { started, release };
  }

  async generate({ squareUri, originalUri }: Parameters<DraftThumbnailAdapter["generate"]>[0]) {
    const deferred = this.deferred;
    if (deferred !== null) {
      this.deferred = null;
      deferred.started();
      await deferred.completion;
    }
    this.files.files.set(squareUri, new Uint8Array([7]));
    this.files.files.set(originalUri, new Uint8Array([8]));
    return {
      square: { width: 360, height: 360 },
      original: { width: 720, height: 480 },
    };
  }

  async inspect(uri: string) {
    return this.files.files.has(uri)
      ? uri.includes("square")
        ? { width: 360, height: 360 }
        : { width: 720, height: 480 }
      : null;
  }
}

function createIdentities(seed: number): ReliabilityIdentities {
  return {
    seed,
    draftSequence: 0,
    assetSequence: 0,
    storageSequence: 0,
    operationSequence: 0,
    thumbnailSequence: 0,
    clockSequence: 0,
  };
}

function createRuntime(
  files: ReliabilityMemoryFiles,
  identities = createIdentities(1),
  thumbnails: DraftThumbnailAdapter = new ReliabilityThumbnails(files),
  autosaveDelayMs = 60_000,
) {
  const previews: DraftLibraryPreviewAdapter = {
    generate: async (sourceUri, destinationUri) => {
      const source = files.files.get(sourceUri);
      if (!(source instanceof Uint8Array)) throw new Error("preview source unavailable");
      files.files.set(destinationUri, new Uint8Array([4, 5, 6]));
      return { width: 720, height: 480 };
    },
    isValid: async (uri) => files.files.get(uri) instanceof Uint8Array,
  };
  const library = createDraftLibrary({
    files,
    previews,
    thumbnails,
    rootUri: "memory://reliability",
    createDraftId: () => draftId(`draft:${identities.seed}:${++identities.draftSequence}`),
    createAssetId: () => importedAssetId(`asset:${identities.seed}:${++identities.assetSequence}`),
    createStorageKey: () => `asset-${identities.seed}-${++identities.storageSequence}`,
    createOperationId: () => `operation-${identities.seed}-${++identities.operationSequence}`,
    createThumbnailGenerationId: () =>
      `thumbnail-${identities.seed}-${++identities.thumbnailSequence}`,
    now: () => new Date(Date.UTC(2026, 7, 4, 8, 0, identities.clockSequence++)).toISOString(),
  });
  const session = createCurrentEditingSession({ library, autosaveDelayMs });
  return {
    library,
    session,
  };
}

async function settleBackgroundWork(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

export async function verifyInterruptedSaveRecovery(): Promise<{
  readonly status: "opened";
  readonly recovered: "new";
}> {
  const files = new ReliabilityMemoryFiles();
  const identities = createIdentities(1);
  files.files.set("picker://one.jpg", new Uint8Array([1, 2, 3]));
  const first = createRuntime(files, identities);
  const created = await first.library.create([candidate("one")], { metadataPolicy: "strip" });
  if (created.status !== "created") throw new Error("failed to create reliability Draft");
  await settleBackgroundWork();
  const opened = await first.session.open(created.draftId);
  if (opened.status !== "opened") throw new Error("failed to open reliability Draft");
  const newColor = "#112233";
  const changed = opened.handle.editing.dispatch({
    type: "commit",
    intent: editIntents.canvas.changeBackground(newColor),
  });
  if (changed.status !== "changed") throw new Error("failed to edit reliability Draft");

  files.armMoveInterruption(2);
  await first.session.flush();
  files.restartProcess();

  const restarted = createRuntime(files, identities);
  const state = await restarted.library.load();
  if (state.status !== "ready") throw new Error(`restart failed: ${state.status}`);
  const recovered = await restarted.session.open(created.draftId);
  if (recovered.status !== "opened") throw new Error(`reopen failed: ${recovered.reason}`);
  const color = recovered.handle.editing.read().document.canvas.backgroundColor;
  if (color !== newColor) {
    throw new Error(`after-copy interruption did not preserve the committed new state: ${color}`);
  }
  return { status: "opened", recovered: "new" };
}

export type ReliabilityOperation = keyof typeof reliabilityEventContract.operations;

const operationRegistry = {} as Record<
  ReliabilityOperation,
  { readonly requiredFaults: readonly string[] }
>;
for (const operation of Object.keys(
  reliabilityEventContract.operations,
) as ReliabilityOperation[]) {
  operationRegistry[operation] = {
    requiredFaults: reliabilityEventContract.operations[operation].faults,
  };
}
export const RELIABILITY_OPERATION_REGISTRY = operationRegistry;

export interface ReliabilityEvent {
  readonly seed: number;
  readonly step: number;
  readonly operation: ReliabilityOperation;
  readonly fault: string | null;
  readonly result: string;
  readonly recovery: string | null;
  readonly effects: {
    readonly simulatedRestartsDelta: number;
    readonly recoveriesDelta: number;
  };
  readonly state: {
    readonly status: string;
    readonly drafts: readonly {
      readonly draftId: string;
      readonly color: string;
      readonly photoCount: number;
      readonly contentRevision: number;
    }[];
  };
  readonly expected: {
    readonly activeDraftId: string | null;
    readonly drafts: readonly {
      readonly draftId: string;
      readonly color: string;
      readonly photoCount: number;
      readonly contentRevision: number;
    }[];
  };
}

export interface ReliabilityTraceResult {
  readonly seed: number;
  readonly stateMachineSteps: number;
  readonly digest: string;
  readonly events: readonly ReliabilityEvent[];
  readonly operationCounts: Readonly<Record<ReliabilityOperation, number>>;
  readonly faultCounts: Readonly<Record<string, number>>;
  readonly typedFailures: Readonly<Record<string, number>>;
  readonly simulatedRestarts: number;
  readonly recoveries: number;
  readonly invariantViolations: number;
}

export interface ReliabilityProfileResult {
  readonly seedCount: number;
  readonly stepsPerSeed: number;
  readonly totalStateMachineSteps: number;
  readonly digest: string;
  readonly seeds: readonly { readonly seed: number; readonly digest: string }[];
  readonly events: readonly ReliabilityEvent[];
  readonly operationCounts: Readonly<Record<string, number>>;
  readonly faultCounts: Readonly<Record<string, number>>;
  readonly typedFailures: Readonly<Record<string, number>>;
  readonly simulatedRestarts: number;
  readonly recoveries: number;
  readonly invariantViolations: number;
}

interface ReferenceDraft {
  readonly draftId: DraftId;
  color: string;
  photoCount: number;
  contentRevision: number;
}

interface ReliabilityTypedResult {
  readonly status: string;
  readonly reason?: string;
}

class DeterministicRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  pick<T>(values: readonly T[]): T {
    const value = values[this.next() % values.length];
    if (value === undefined) throw new Error("cannot pick from an empty deterministic set");
    return value;
  }
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function summarizeReliabilityEvents(events: readonly ReliabilityEvent[]): {
  readonly operationCounts: Record<ReliabilityOperation, number>;
  readonly faultCounts: Record<string, number>;
  readonly typedFailures: Record<string, number>;
  readonly simulatedRestarts: number;
  readonly recoveries: number;
} {
  const operationCounts = {} as Record<ReliabilityOperation, number>;
  const faultCounts: Record<string, number> = {};
  const typedFailures: Record<string, number> = {};
  let simulatedRestarts = 0;
  let recoveries = 0;
  for (const event of events) {
    increment(operationCounts, event.operation);
    if (event.fault !== null) {
      for (const fault of event.fault.split("+")) increment(faultCounts, fault);
    }
    if (reliabilityEventContract.typedFailureResults.includes(event.result)) {
      increment(typedFailures, event.result);
    }
    simulatedRestarts += event.effects.simulatedRestartsDelta;
    recoveries += event.effects.recoveriesDelta;
  }
  return { operationCounts, faultCounts, typedFailures, simulatedRestarts, recoveries };
}

async function digestEvents(events: readonly ReliabilityEvent[]): Promise<string> {
  const bytes = new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const FIXED_OPERATIONS: readonly ReliabilityOperation[] = [
  "create",
  "switch",
  "save",
  "ingest",
  "create",
  "switch",
  "delete",
  "restart",
  "read-failure",
  "probe-failure",
  "list-failure",
  "write-failure",
  "replacement-before",
  "replacement-after-remove",
  "replacement-after-copy",
  "publication-failure",
  "publication-unknown",
  "directory-publication",
  "deletion-failure",
  "deletion-unknown",
  "interrupted-replacement",
  "cleanup-failure",
  "stale-thumbnail",
  "noop-save",
  "switch-failure",
  "dirty-save-new-edit",
  "switch-validation-new-edit",
  "ingest-switch-delete",
  "autosave",
];

const RANDOM_OPERATIONS: readonly ReliabilityOperation[] = [
  "create",
  "save",
  "ingest",
  "switch",
  "delete",
  "restart",
  "save",
  "ingest",
  "switch",
  "read-failure",
  "replacement-before",
  "replacement-after-remove",
  "replacement-after-copy",
  "interrupted-replacement",
  "noop-save",
];

class ReliabilityWorld {
  readonly files = new ReliabilityMemoryFiles();
  readonly thumbnails = new ReliabilityThumbnails(this.files);
  readonly identities: ReliabilityIdentities;
  readonly random: DeterministicRandom;
  readonly drafts = new Map<DraftId, ReferenceDraft>();
  runtime: { readonly library: DraftLibrary; readonly session: CurrentEditingSession };
  activeDraftId: DraftId | null = null;
  activeHandle: CurrentEditingSessionHandle | null = null;
  sourceSequence = 0;
  simulatedRestarts = 0;
  recoveries = 0;
  lastTypedResult: ReliabilityTypedResult | null = null;
  lastTriggeredFaults: readonly string[] = [];

  constructor(readonly seed: number) {
    this.identities = createIdentities(seed);
    this.random = new DeterministicRandom(seed);
    this.runtime = createRuntime(this.files, this.identities, this.thumbnails);
  }

  private recordTypedResult(
    result: { readonly status: string; readonly reason?: unknown } | undefined,
  ): void {
    if (result === undefined) return;
    this.lastTypedResult = {
      status: result.status,
      ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
    };
  }

  private source(): ImportCandidate {
    const name = `source-${this.seed}-${++this.sourceSequence}`;
    this.files.files.set(`picker://${name}.jpg`, new Uint8Array([1, 2, 3]));
    return candidate(name);
  }

  private ids(): readonly DraftId[] {
    return [...this.drafts.keys()].sort();
  }

  private chooseDraft(preferDifferent = false): DraftId | null {
    const ids = this.ids();
    const candidates = preferDifferent ? ids.filter((id) => id !== this.activeDraftId) : ids;
    return candidates.length === 0 ? null : this.random.pick(candidates);
  }

  private nextColor(): string {
    return `#${(this.random.next() & 0xffffff).toString(16).padStart(6, "0")}`;
  }

  private async ensureActive(): Promise<ReferenceDraft> {
    let target = this.activeDraftId === null ? this.chooseDraft() : this.activeDraftId;
    if (target === null) {
      await this.create();
      target = this.chooseDraft();
    }
    if (target === null) throw new Error("failed to establish a Draft for the active session");
    if (this.activeDraftId !== target || this.activeHandle === null) await this.open(target);
    const reference = this.drafts.get(target);
    if (reference === undefined || this.activeHandle === null) {
      throw new Error("active session does not match the reference model");
    }
    return reference;
  }

  private async ensureTwoDrafts(): Promise<void> {
    while (this.drafts.size < 2) await this.create();
  }

  private async create(): Promise<string> {
    if (this.drafts.size >= 3) return this.switchDraft();
    const result = await this.runtime.library.create([this.source()], { metadataPolicy: "strip" });
    this.recordTypedResult(result);
    if (result.status !== "created")
      throw new Error(`create failed without a fault: ${result.status}`);
    if (
      result.document.canvas.backgroundColor !== "#FFFFFF" ||
      result.document.sourceImages.length !== 1 ||
      result.contentRevision !== 1
    ) {
      throw new Error("created Draft did not match the independent initial reference state");
    }
    this.drafts.set(result.draftId, {
      draftId: result.draftId,
      color: "#FFFFFF",
      photoCount: 1,
      contentRevision: 1,
    });
    return result.status;
  }

  private async open(id: DraftId): Promise<string> {
    const previousId = this.activeDraftId;
    const previousHandle = this.activeHandle;
    const result = await this.runtime.session.open(id);
    this.recordTypedResult(result);
    if (result.status !== "opened")
      throw new Error(`switch failed without a fault: ${result.reason}`);
    this.activeDraftId = id;
    this.activeHandle = result.handle;
    if (previousId !== null && previousId !== id && previousHandle !== null) {
      const staleEdit = previousHandle.editing.dispatch({
        type: "commit",
        intent: editIntents.canvas.changeBackground("#010101"),
      });
      if (staleEdit.status !== "unavailable") {
        throw new Error("successful switch left the previous session handle active");
      }
    }
    return result.status;
  }

  private async switchDraft(): Promise<string> {
    const target = this.chooseDraft(true) ?? this.chooseDraft();
    if (target === null) return this.create();
    return this.open(target);
  }

  private async save(): Promise<string> {
    const reference = await this.ensureActive();
    const color = this.nextColor();
    const changed = this.activeHandle?.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground(color),
    });
    if (changed?.status !== "changed") throw new Error(`edit failed: ${changed?.status}`);
    const result = await this.runtime.session.flush();
    this.recordTypedResult(result);
    if (result.status !== "flushed")
      throw new Error(`flush failed without a fault: ${result.reason}`);
    reference.color = color;
    reference.contentRevision += 1;
    const read = await this.runtime.library.read(reference.draftId);
    if (
      read.status !== "ready" ||
      read.document.canvas.backgroundColor !== reference.color ||
      read.contentRevision !== reference.contentRevision
    ) {
      throw new Error("saved Draft diverged from the independent next revision");
    }
    return result.status;
  }

  private async ingest(): Promise<string> {
    const reference = await this.ensureActive();
    if (reference.photoCount >= 9) return this.save();
    const result = await this.activeHandle?.addImages([this.source()]);
    this.recordTypedResult(result);
    if (result?.status !== "completed" || result.commit?.status !== "changed") {
      throw new Error(`ingest failed without a fault: ${result?.status}`);
    }
    const flushed = await this.runtime.session.flush();
    this.recordTypedResult(flushed);
    if (flushed.status !== "flushed") throw new Error(`ingest flush failed: ${flushed.reason}`);
    reference.photoCount += 1;
    reference.contentRevision += 1;
    const read = await this.runtime.library.read(reference.draftId);
    if (
      read.status !== "ready" ||
      read.document.sourceImages.length !== reference.photoCount ||
      read.contentRevision !== reference.contentRevision
    ) {
      throw new Error("ingested Draft diverged from the independent next revision");
    }
    return result.status;
  }

  private async deleteDraft(): Promise<string> {
    if (this.drafts.size === 0) await this.create();
    const target = this.chooseDraft();
    if (target === null) throw new Error("delete precondition did not create a Draft");
    const result = await this.runtime.session.delete(target);
    this.recordTypedResult(result);
    if (result.status !== "deleted")
      throw new Error(`delete failed without a fault: ${result.status}`);
    this.drafts.delete(target);
    if (this.activeDraftId === target) {
      this.activeDraftId = null;
      this.activeHandle = null;
    }
    return result.status;
  }

  private async restart(expectRecovery = false, verifyNow = true): Promise<string> {
    this.files.restartProcess();
    this.runtime = createRuntime(this.files, this.identities, this.thumbnails);
    this.activeDraftId = null;
    this.activeHandle = null;
    this.simulatedRestarts += 1;
    if (expectRecovery) this.recoveries += 1;
    const loaded = await this.runtime.library.load();
    this.recordTypedResult(loaded);
    if (loaded.status !== "ready") throw new Error(`restart did not converge: ${loaded.status}`);
    if (verifyNow) await this.verify();
    return loaded.status;
  }

  private async readFailure(kind: "read" | "probe" | "list"): Promise<string> {
    if (this.drafts.size === 0) await this.create();
    const target = this.chooseDraft();
    if (target === null) throw new Error(`${kind} fault precondition did not create a Draft`);
    if (kind === "list") {
      this.files.restartProcess();
      this.runtime = createRuntime(this.files, this.identities, this.thumbnails);
      this.activeDraftId = null;
      this.activeHandle = null;
      this.files.armReadFailure("list");
      const loaded = await this.runtime.library.load();
      this.recordTypedResult(loaded);
      this.files.clearTransientFaults();
      if (loaded.status !== "storage-failed") {
        throw new Error(`list fault escaped its typed boundary: ${loaded.status}`);
      }
      await this.restart(true);
      return loaded.status;
    }
    this.files.armReadFailure(kind);
    const result = await this.runtime.library.read(target);
    this.recordTypedResult(result);
    this.files.clearTransientFaults();
    if (result.status !== "recovery-failed" || result.reason !== "storage-unavailable") {
      throw new Error(`read fault escaped its typed boundary: ${result.status}`);
    }
    await this.verify();
    return `${result.status}:${result.reason}`;
  }

  private async writeFailure(): Promise<string> {
    if (this.drafts.size >= 3) await this.deleteDraft();
    this.files.armMarkerFailure("publication", "before-write");
    const result = await this.runtime.library.create([this.source()], { metadataPolicy: "strip" });
    this.recordTypedResult(result);
    this.files.clearTransientFaults();
    if (result.status !== "create-failed") {
      throw new Error(`publication write fault was not surfaced: ${result.status}`);
    }
    await this.restart(true);
    return result.status;
  }

  private async replacementFailure(
    phase: "before" | "after-removal" | "after-copy",
    interrupted: boolean,
  ): Promise<string> {
    const reference = await this.ensureActive();
    const oldColor = reference.color;
    const oldRevision = reference.contentRevision;
    const nextColor = this.nextColor();
    const changed = this.activeHandle?.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground(nextColor),
    });
    if (changed?.status !== "changed") throw new Error("faulted save edit was rejected");
    if (interrupted) this.files.armMoveInterruption(2);
    else this.files.armReplacementFailure(phase);
    const result = await this.runtime.session.flush();
    this.recordTypedResult(result);
    await this.restart(true, false);
    const read = await this.runtime.library.read(reference.draftId);
    if (read.status !== "ready") throw new Error(`faulted save did not recover: ${read.reason}`);
    const expectedColor = phase === "after-copy" ? nextColor : oldColor;
    const expectedResult = phase === "after-copy" && !interrupted ? "flushed" : "flush-failed";
    if (result.status !== expectedResult) {
      throw new Error(
        `${phase} replacement returned ${result.status}; expected typed result ${expectedResult}`,
      );
    }
    const recoveredColor = read.document.canvas.backgroundColor;
    if (recoveredColor !== expectedColor) {
      throw new Error(
        `${phase} replacement recovered ${recoveredColor}; expected ${expectedColor}`,
      );
    }
    reference.color = recoveredColor;
    reference.contentRevision = recoveredColor === nextColor ? oldRevision + 1 : oldRevision;
    if (read.contentRevision !== reference.contentRevision) {
      throw new Error(`faulted save recovered invalid revision ${read.contentRevision}`);
    }
    return result.status;
  }

  private async directoryPublicationFailure(): Promise<string> {
    if (this.drafts.size >= 3) await this.deleteDraft();
    this.files.armDirectoryPublicationFailure();
    const result = await this.runtime.library.create([this.source()], { metadataPolicy: "strip" });
    this.recordTypedResult(result);
    if (result.status !== "create-failed") {
      throw new Error(`partial directory publication became visible: ${result.status}`);
    }
    await this.restart(true);
    return result.status;
  }

  private async publicationFailure(unknown: boolean): Promise<string> {
    if (this.drafts.size >= 3) await this.deleteDraft();
    const expectedId = draftId(`draft:${this.seed}:${this.identities.draftSequence + 1}`);
    this.files.armMarkerFailure("publication", unknown ? "after-write-unknown" : "before-write");
    const result = await this.runtime.library.create([this.source()], { metadataPolicy: "strip" });
    this.recordTypedResult(result);
    if (result.status !== "create-failed") {
      throw new Error(
        `${unknown ? "unknown" : "definite"} publication failure returned ${result.status}`,
      );
    }
    if (unknown) {
      const beforeRestart = this.runtime.library.getState();
      if (beforeRestart.status !== "storage-failed") {
        throw new Error(
          `unknown publication did not enter public storage-failed state: ${beforeRestart.status}`,
        );
      }
      const unreadable = await this.runtime.library.read(expectedId);
      if (unreadable.status !== "recovery-failed" || unreadable.reason !== "storage-unavailable") {
        throw new Error("unknown publication remained readable before recovery restart");
      }
    }
    this.files.restartProcess();
    if (unknown) {
      this.drafts.set(expectedId, {
        draftId: expectedId,
        color: "#FFFFFF",
        photoCount: 1,
        contentRevision: 1,
      });
    }
    await this.restart(true);
    if (unknown) {
      const committed = await this.runtime.library.read(expectedId);
      if (
        committed.status !== "ready" ||
        committed.document.canvas.backgroundColor !== "#FFFFFF" ||
        committed.document.sourceImages.length !== 1 ||
        committed.contentRevision !== 1
      ) {
        throw new Error("unknown publication did not preserve its committed Draft after restart");
      }
    }
    return result.status;
  }

  private async deletionFailure(unknown: boolean): Promise<string> {
    if (this.drafts.size === 0) await this.create();
    const target = this.chooseDraft();
    if (target === null) throw new Error("deletion fault precondition did not create a Draft");
    this.files.armMarkerFailure("deletion", unknown ? "after-write-unknown" : "before-write");
    const result = await this.runtime.session.delete(target);
    this.recordTypedResult(result);
    if (unknown) {
      if (result.status !== "delete-unknown") {
        throw new Error(`unknown deletion did not freeze the session: ${result.status}`);
      }
      this.files.clearTransientFaults();
      const retried = await this.runtime.session.delete(target);
      this.recordTypedResult(retried);
      if (retried.status !== "deleted") {
        throw new Error(`unknown deletion retry did not confirm commit: ${retried.status}`);
      }
      this.files.acknowledgeFault("delete-unknown-retry");
      this.drafts.delete(target);
      this.activeDraftId = null;
      this.activeHandle = null;
      await this.restart(true);
    } else {
      this.files.clearTransientFaults();
      if (result.status !== "delete-failed") {
        throw new Error(`definite deletion failure was not rejected: ${result.status}`);
      }
      await this.verify();
    }
    return result.status;
  }

  private async cleanupFailure(): Promise<string> {
    if (this.drafts.size === 0) await this.create();
    const target = this.chooseDraft();
    if (target === null) throw new Error("cleanup fault precondition did not create a Draft");
    this.files.armDirectoryRemovalFailure();
    const result = await this.runtime.session.delete(target);
    this.recordTypedResult(result);
    if (result.status !== "deleted") {
      throw new Error(`cleanup failure changed logical deletion: ${result.status}`);
    }
    this.drafts.delete(target);
    if (this.activeDraftId === target) {
      this.activeDraftId = null;
      this.activeHandle = null;
    }
    await settleBackgroundWork();
    await this.restart(true);
    return result.status;
  }

  private async staleThumbnail(): Promise<string> {
    const reference = await this.ensureActive();
    await settleBackgroundWork();
    const deferred = this.thumbnails.deferNext();
    await this.save();
    await deferred.started;
    await this.save();
    deferred.release();
    await settleBackgroundWork();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await Promise.resolve();
      const state = this.runtime.library.getState();
      const entry =
        state.status === "ready"
          ? state.entries.find(({ draftId: id }) => id === reference.draftId)
          : undefined;
      if (
        entry?.status === "ready" &&
        entry.thumbnailStatus === "ready" &&
        entry.thumbnail?.contentRevision === reference.contentRevision
      ) {
        this.files.acknowledgeFault("stale-async-completion");
        return "stale-completion-ignored";
      }
    }
    throw new Error("stale thumbnail completion did not converge to the latest revision");
  }

  private async noopSave(): Promise<string> {
    const target = this.chooseDraft();
    if (target === null) return this.create();
    const reference = this.drafts.get(target);
    if (reference === undefined)
      throw new Error("no-op target is missing from the reference model");
    const before = await this.runtime.library.read(target);
    if (before.status !== "ready") throw new Error(`no-op baseline read failed: ${before.reason}`);
    if (
      before.document.canvas.backgroundColor !== reference.color ||
      before.document.sourceImages.length !== reference.photoCount ||
      before.contentRevision !== reference.contentRevision
    ) {
      throw new Error("no-op baseline diverged from the independent reference model");
    }
    const saved = await this.runtime.library.save(target, before.document);
    this.recordTypedResult(saved);
    if (saved.status !== "saved") throw new Error(`no-op save failed: ${saved.reason}`);
    if (saved.contentRevision !== reference.contentRevision) {
      throw new Error("semantic no-op save advanced contentRevision");
    }
    return "revision-unchanged";
  }

  private async switchFailure(): Promise<string> {
    await this.ensureTwoDrafts();
    const current = await this.ensureActive();
    const previousHandle = this.activeHandle;
    const target = this.chooseDraft(true);
    if (target === null || previousHandle === null)
      throw new Error("switch failure needs two Drafts");
    this.files.armReadFailure("probe");
    const result = await this.runtime.session.open(target);
    this.recordTypedResult(result);
    this.files.clearTransientFaults();
    if (result.status !== "open-failed") {
      throw new Error("faulted switch unexpectedly replaced the active session");
    }
    const color = this.nextColor();
    const edit = previousHandle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground(color),
    });
    if (edit.status !== "changed") {
      throw new Error("failed switch did not preserve the previous handle");
    }
    const flushed = await this.runtime.session.flush();
    this.recordTypedResult(flushed);
    if (flushed.status !== "flushed") throw new Error("preserved session could not flush");
    current.color = color;
    current.contentRevision += 1;
    const read = await this.runtime.library.read(current.draftId);
    if (
      read.status !== "ready" ||
      read.document.canvas.backgroundColor !== current.color ||
      read.contentRevision !== current.contentRevision
    ) {
      throw new Error("preserved Draft diverged after failed switch");
    }
    this.files.acknowledgeFault("switch-failure-preserves-handle");
    return `${result.status}:old-handle-active`;
  }

  private async dirtySaveNewEdit(): Promise<string> {
    const reference = await this.ensureActive();
    await settleBackgroundWork();
    const firstColor = this.nextColor();
    const secondColor = this.nextColor();
    if (
      this.activeHandle?.editing.dispatch({
        type: "commit",
        intent: editIntents.canvas.changeBackground(firstColor),
      }).status !== "changed"
    ) {
      throw new Error("first concurrent save edit was rejected");
    }
    const gate = this.files.gateNextMove();
    const flushing = this.runtime.session.flush();
    await gate.started;
    if (
      this.activeHandle?.editing.dispatch({
        type: "commit",
        intent: editIntents.canvas.changeBackground(secondColor),
      }).status !== "changed"
    ) {
      throw new Error("new edit during dirty save was rejected");
    }
    gate.release();
    const result = await flushing;
    this.recordTypedResult(result);
    if (result.status !== "flushed") throw new Error("dirty save concurrency did not converge");
    reference.color = secondColor;
    reference.contentRevision += 2;
    const read = await this.runtime.library.read(reference.draftId);
    if (
      read.status !== "ready" ||
      read.document.canvas.backgroundColor !== reference.color ||
      read.contentRevision !== reference.contentRevision
    ) {
      throw new Error("stale dirty save overwrote the newer edit");
    }
    return "newest-edit-persisted";
  }

  private async switchValidationNewEdit(): Promise<string> {
    await this.ensureTwoDrafts();
    const previous = await this.ensureActive();
    const previousHandle = this.activeHandle;
    const target = this.chooseDraft(true);
    if (target === null || previousHandle === null) {
      throw new Error("switch validation concurrency needs two Drafts");
    }
    await settleBackgroundWork();
    const gate = this.files.gateNextRead();
    const opening = this.runtime.session.open(target);
    await gate.started;
    const color = this.nextColor();
    const edit = previousHandle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground(color),
    });
    if (edit.status !== "changed") throw new Error("edit during switch validation was rejected");
    gate.release();
    const result = await opening;
    this.recordTypedResult(result);
    if (result.status !== "opened") throw new Error(`validated switch failed: ${result.reason}`);
    previous.color = color;
    previous.contentRevision += 1;
    const previousRead = await this.runtime.library.read(previous.draftId);
    if (
      previousRead.status !== "ready" ||
      previousRead.document.canvas.backgroundColor !== previous.color ||
      previousRead.contentRevision !== previous.contentRevision
    ) {
      throw new Error("edit accepted during switch validation was not flushed");
    }
    const staleEdit = previousHandle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#020202"),
    });
    if (staleEdit.status !== "unavailable") {
      throw new Error("successful validated switch did not invalidate its old handle");
    }
    this.activeDraftId = target;
    this.activeHandle = result.handle;
    return "new-edit-flushed-before-switch";
  }

  private async ingestSwitchDelete(): Promise<string> {
    await this.ensureTwoDrafts();
    const current = await this.ensureActive();
    const handle = this.activeHandle;
    const target = this.chooseDraft(true);
    if (target === null || handle === null) {
      throw new Error("ingest concurrency needs two Drafts");
    }
    await settleBackgroundWork();
    const gate = this.files.gateNextCopy();
    const adding = handle.addImages([this.source()]);
    await gate.started;
    const switching = await this.runtime.session.open(target);
    this.recordTypedResult(switching);
    if (switching.status !== "open-failed" || switching.reason !== "busy") {
      throw new Error("switch did not reject an in-flight ingest as busy");
    }
    const deleting = this.runtime.session.delete(current.draftId);
    gate.release();
    const added = await adding;
    this.recordTypedResult(added);
    if (added.status !== "completed" || added.commit?.status !== "changed") {
      throw new Error("gated ingest did not complete before deletion");
    }
    const deleted = await deleting;
    this.recordTypedResult(deleted);
    if (deleted.status !== "deleted") {
      throw new Error(`delete did not drain in-flight ingest: ${deleted.status}`);
    }
    this.drafts.delete(current.draftId);
    this.activeDraftId = null;
    this.activeHandle = null;
    const staleEdit = handle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#030303"),
    });
    if (staleEdit.status !== "unavailable") {
      throw new Error("delete after ingest left the old handle active");
    }
    return "switch-busy+ingest-drained+deleted";
  }

  private async autosave(): Promise<string> {
    await this.ensureTwoDrafts();
    const previousId = this.chooseDraft();
    if (previousId === null) throw new Error("autosave precondition did not create a Draft");
    const target = this.ids().find((id) => id !== previousId);
    if (target === undefined) throw new Error("autosave switch needs two Drafts");
    this.files.restartProcess();
    this.runtime = createRuntime(this.files, this.identities, this.thumbnails, 0);
    this.activeDraftId = null;
    this.activeHandle = null;
    this.simulatedRestarts += 1;
    const loaded = await this.runtime.library.load();
    this.recordTypedResult(loaded);
    if (loaded.status !== "ready") throw new Error("autosave runtime did not load");
    await this.open(previousId);
    const reference = this.drafts.get(previousId);
    const targetReference = this.drafts.get(target);
    const activeHandle = this.activeHandle as CurrentEditingSessionHandle | null;
    if (reference === undefined || targetReference === undefined || activeHandle === null) {
      throw new Error("autosave Draft is missing from the reference model");
    }
    const targetColor = targetReference.color;
    const targetRevision = targetReference.contentRevision;
    const gate = this.files.gateNextMove("autosave-switch-interleaving");
    const color = this.nextColor();
    const edit = activeHandle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground(color),
    });
    if (edit.status !== "changed") throw new Error("autosave edit was rejected");
    reference.color = color;
    reference.contentRevision += 1;
    await gate.started;
    const opening = this.runtime.session.open(target);
    await Promise.resolve();
    gate.release();
    const opened = await opening;
    this.recordTypedResult(opened);
    if (opened.status !== "opened") {
      throw new Error(`switch during timer autosave failed: ${opened.reason}`);
    }
    this.activeDraftId = target;
    this.activeHandle = opened.handle;
    await settleBackgroundWork();
    const previousRead = await this.runtime.library.read(previousId);
    const targetRead = await this.runtime.library.read(target);
    if (
      previousRead.status !== "ready" ||
      previousRead.document.canvas.backgroundColor !== reference.color ||
      previousRead.contentRevision !== reference.contentRevision
    ) {
      throw new Error("timer-driven autosave did not persist the previous Draft");
    }
    if (
      targetRead.status !== "ready" ||
      targetRead.document.canvas.backgroundColor !== targetColor ||
      targetRead.contentRevision !== targetRevision
    ) {
      throw new Error("previous timer autosave overwrote the newly active Draft");
    }
    const staleEdit = activeHandle.editing.dispatch({
      type: "commit",
      intent: editIntents.canvas.changeBackground("#040404"),
    });
    if (staleEdit.status !== "unavailable") {
      throw new Error("timer autosave switch left the previous handle active");
    }
    await this.restart();
    return "timer-autosaved-before-switch+new-session-preserved";
  }

  async execute(
    operation: ReliabilityOperation,
    additionalInvariant?: () => void | Promise<void>,
  ): Promise<{
    readonly result: string;
    readonly recovery: string | null;
    readonly triggeredFaults: readonly string[];
  }> {
    this.files.clearTriggeredFaults();
    this.lastTypedResult = null;
    this.lastTriggeredFaults = [];
    const recoveriesBefore = this.recoveries;
    let result: string;
    switch (operation) {
      case "create":
        result = await this.create();
        break;
      case "save":
        result = await this.save();
        break;
      case "ingest":
        result = await this.ingest();
        break;
      case "switch":
        result = await this.switchDraft();
        break;
      case "delete":
        result = await this.deleteDraft();
        break;
      case "restart":
        result = await this.restart();
        break;
      case "read-failure":
        result = await this.readFailure("read");
        break;
      case "probe-failure":
        result = await this.readFailure("probe");
        break;
      case "list-failure":
        result = await this.readFailure("list");
        break;
      case "write-failure":
        result = await this.writeFailure();
        break;
      case "publication-failure":
        result = await this.publicationFailure(false);
        break;
      case "publication-unknown":
        result = await this.publicationFailure(true);
        break;
      case "replacement-before":
        result = await this.replacementFailure("before", false);
        break;
      case "replacement-after-remove":
        result = await this.replacementFailure("after-removal", false);
        break;
      case "replacement-after-copy":
        result = await this.replacementFailure("after-copy", false);
        break;
      case "interrupted-replacement":
        result = await this.replacementFailure("after-copy", true);
        break;
      case "directory-publication":
        result = await this.directoryPublicationFailure();
        break;
      case "deletion-failure":
        result = await this.deletionFailure(false);
        break;
      case "deletion-unknown":
        result = await this.deletionFailure(true);
        break;
      case "cleanup-failure":
        result = await this.cleanupFailure();
        break;
      case "stale-thumbnail":
        result = await this.staleThumbnail();
        break;
      case "noop-save":
        result = await this.noopSave();
        break;
      case "switch-failure":
        result = await this.switchFailure();
        break;
      case "dirty-save-new-edit":
        result = await this.dirtySaveNewEdit();
        break;
      case "switch-validation-new-edit":
        result = await this.switchValidationNewEdit();
        break;
      case "ingest-switch-delete":
        result = await this.ingestSwitchDelete();
        break;
      case "autosave":
        result = await this.autosave();
        break;
    }
    await settleBackgroundWork();
    await additionalInvariant?.();
    await this.verify();
    const triggeredFaults = this.files.consumeTriggeredFaults();
    this.lastTriggeredFaults = triggeredFaults;
    const missingFaults = requiredFaultNames(operation).filter(
      (fault) => !triggeredFaults.includes(fault),
    );
    if (missingFaults.length > 0) {
      throw new Error(
        `operation ${operation} did not trigger required failpoints: ${missingFaults.join(", ")}; ` +
          `observed: ${triggeredFaults.join(", ") || "none"}`,
      );
    }
    return {
      result,
      recovery: this.recoveries > recoveriesBefore ? "converged-after-restart" : null,
      triggeredFaults,
    };
  }

  consumeTriggeredFaults(): readonly string[] {
    return this.files.consumeTriggeredFaults();
  }

  async verify(): Promise<void> {
    const state = this.runtime.library.getState();
    if (state.status !== "ready") throw new Error(`library state is not reliable: ${state.status}`);
    const actualIds = state.entries.map(({ draftId: id }) => id).sort();
    const expectedIds = this.ids();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      throw new Error(
        `authoritative list diverged: ${actualIds.join(",")} != ${expectedIds.join(",")}`,
      );
    }
    for (const reference of this.drafts.values()) {
      const entry = state.entries.find(({ draftId: id }) => id === reference.draftId);
      if (entry === undefined || entry.status !== "ready") {
        throw new Error(`reference Draft has no ready public list entry: ${reference.draftId}`);
      }
      if (
        entry.photoCount !== reference.photoCount ||
        entry.contentRevision !== reference.contentRevision
      ) {
        throw new Error(
          `public list entry diverged for ${reference.draftId}: ` +
            JSON.stringify({
              actual: {
                photoCount: entry.photoCount,
                contentRevision: entry.contentRevision,
              },
              expected: reference,
            }),
        );
      }
      if (
        new Date(entry.createdAt).toISOString() !== entry.createdAt ||
        new Date(entry.updatedAt).toISOString() !== entry.updatedAt ||
        entry.updatedAt < entry.createdAt ||
        (entry.thumbnail !== null && entry.thumbnail.contentRevision > entry.contentRevision)
      ) {
        throw new Error(`public list entry metadata is inconsistent: ${reference.draftId}`);
      }
      const read = await this.runtime.library.read(reference.draftId);
      if (read.status !== "ready") {
        throw new Error(`reference Draft became unreadable: ${reference.draftId}:${read.reason}`);
      }
      if (
        read.document.canvas.backgroundColor !== reference.color ||
        read.document.sourceImages.length !== reference.photoCount ||
        read.contentRevision !== reference.contentRevision
      ) {
        throw new Error(
          `public read diverged for ${reference.draftId}: ` +
            JSON.stringify({
              actual: {
                color: read.document.canvas.backgroundColor,
                photoCount: read.document.sourceImages.length,
                contentRevision: read.contentRevision,
              },
              expected: reference,
            }),
        );
      }
      for (const image of read.document.sourceImages) {
        const descriptor = read.assets.resolve(image.id, "original");
        if (
          descriptor === null ||
          descriptor.draftId !== reference.draftId ||
          descriptor.assetId !== image.id ||
          descriptor.usage !== "original" ||
          descriptor.uri.length === 0
        ) {
          throw new Error(`public asset resolution failed for ${reference.draftId}:${image.id}`);
        }
      }
    }
  }

  async snapshot(): Promise<ReliabilityEvent["state"]> {
    const state = this.runtime.library.getState();
    if (state.status !== "ready") return { status: state.status, drafts: [] };
    const drafts: ReliabilityEvent["state"]["drafts"][number][] = [];
    for (const entry of [...state.entries].sort((left, right) =>
      left.draftId.localeCompare(right.draftId),
    )) {
      if (entry.status !== "ready") {
        throw new Error(`public snapshot contains a corrupt Draft: ${entry.draftId}`);
      }
      const read = await this.runtime.library.read(entry.draftId);
      if (read.status !== "ready") {
        throw new Error(`public snapshot Draft became unreadable: ${entry.draftId}:${read.reason}`);
      }
      if (
        read.document.sourceImages.length !== entry.photoCount ||
        read.contentRevision !== entry.contentRevision
      ) {
        throw new Error(`public snapshot list/read mismatch: ${entry.draftId}`);
      }
      drafts.push({
        draftId: entry.draftId,
        color: read.document.canvas.backgroundColor,
        photoCount: entry.photoCount,
        contentRevision: entry.contentRevision,
      });
    }
    return { status: state.status, drafts };
  }

  expectedSnapshot(): ReliabilityEvent["expected"] {
    return {
      activeDraftId: this.activeDraftId,
      drafts: [...this.drafts.values()]
        .sort((left, right) => left.draftId.localeCompare(right.draftId))
        .map((item) => ({
          draftId: item.draftId,
          color: item.color,
          photoCount: item.photoCount,
          contentRevision: item.contentRevision,
        })),
    };
  }
}

function requiredFaultNames(operation: ReliabilityOperation): readonly string[] {
  return RELIABILITY_OPERATION_REGISTRY[operation].requiredFaults;
}

export async function runReliabilityTrace(options: {
  readonly seed: number;
  readonly steps: number;
  readonly additionalInvariant?: (context: {
    readonly seed: number;
    readonly step: number;
    readonly operation: ReliabilityOperation;
  }) => void | Promise<void>;
}): Promise<ReliabilityTraceResult> {
  if (!Number.isInteger(options.steps) || options.steps <= 0) {
    throw new Error("reliability trace steps must be a positive integer");
  }
  const world = new ReliabilityWorld(options.seed);
  const events: ReliabilityEvent[] = [];
  for (let step = 0; step < options.steps; step += 1) {
    const operation = FIXED_OPERATIONS[step] ?? world.random.pick(RANDOM_OPERATIONS);
    const simulatedRestartsBefore = world.simulatedRestarts;
    const recoveriesBefore = world.recoveries;
    try {
      const outcome = await world.execute(operation, () =>
        options.additionalInvariant?.({ seed: options.seed, step, operation }),
      );
      events.push({
        seed: options.seed,
        step,
        operation,
        fault: outcome.triggeredFaults.length === 0 ? null : outcome.triggeredFaults.join("+"),
        result: outcome.result,
        recovery: outcome.recovery,
        effects: {
          simulatedRestartsDelta: world.simulatedRestarts - simulatedRestartsBefore,
          recoveriesDelta: world.recoveries - recoveriesBefore,
        },
        state: await world.snapshot(),
        expected: world.expectedSnapshot(),
      });
    } catch (error: unknown) {
      const triggeredFaults = [
        ...new Set([...world.lastTriggeredFaults, ...world.consumeTriggeredFaults()]),
      ].sort();
      let finalPublicState: ReliabilityEvent["state"] | { readonly status: "unavailable" };
      try {
        finalPublicState = await world.snapshot();
      } catch {
        finalPublicState = { status: "unavailable" };
      }
      const diagnostic = {
        schemaVersion: 1,
        seed: options.seed,
        step,
        operation,
        fault: triggeredFaults.length === 0 ? null : triggeredFaults.join("+"),
        typedResult: world.lastTypedResult,
        recovery: {
          action:
            world.recoveries > recoveriesBefore
              ? "converged-after-restart"
              : world.simulatedRestarts > simulatedRestartsBefore
                ? "process-restarted"
                : null,
          occurred:
            world.recoveries > recoveriesBefore ||
            world.simulatedRestarts > simulatedRestartsBefore,
          simulatedRestarts: {
            before: simulatedRestartsBefore,
            after: world.simulatedRestarts,
            delta: world.simulatedRestarts - simulatedRestartsBefore,
          },
          recoveries: {
            before: recoveriesBefore,
            after: world.recoveries,
            delta: world.recoveries - recoveriesBefore,
          },
        },
        message: error instanceof Error ? error.message : String(error),
        invariantViolations: 1,
        finalPublicState,
        expectedState: world.expectedSnapshot(),
        replay: `pnpm test:reliability-soak:replay -- ${options.seed} ${options.steps}`,
        events,
      };
      throw new Error(`reliability invariant violation\n${JSON.stringify(diagnostic, null, 2)}`);
    }
  }
  const summary = summarizeReliabilityEvents(events);
  return {
    seed: options.seed,
    stateMachineSteps: options.steps,
    digest: await digestEvents(events),
    events,
    ...summary,
    invariantViolations: 0,
  };
}

export async function runReliabilityProfile(options: {
  readonly seedCount?: number;
  readonly stepsPerSeed: number;
  readonly firstSeed?: number;
  readonly seeds?: readonly number[];
}): Promise<ReliabilityProfileResult> {
  const seedValues =
    options.seeds ??
    Array.from(
      { length: options.seedCount ?? 0 },
      (_, index) => ((options.firstSeed ?? 0x69a11000) + index) >>> 0,
    );
  if (seedValues.length === 0 || seedValues.some((seed) => !Number.isInteger(seed))) {
    throw new Error("reliability profile seed count must be a positive integer");
  }
  const operationCounts: Record<string, number> = {};
  const faultCounts: Record<string, number> = {};
  const typedFailures: Record<string, number> = {};
  const events: ReliabilityEvent[] = [];
  const seeds: { seed: number; digest: string }[] = [];
  let simulatedRestarts = 0;
  let recoveries = 0;
  let invariantViolations = 0;
  for (const seed of seedValues) {
    const trace = await runReliabilityTrace({ seed, steps: options.stepsPerSeed });
    seeds.push({ seed, digest: trace.digest });
    events.push(...trace.events);
    for (const [key, value] of Object.entries(trace.operationCounts)) {
      operationCounts[key] = (operationCounts[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(trace.faultCounts)) {
      faultCounts[key] = (faultCounts[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(trace.typedFailures)) {
      typedFailures[key] = (typedFailures[key] ?? 0) + value;
    }
    simulatedRestarts += trace.simulatedRestarts;
    recoveries += trace.recoveries;
    invariantViolations += trace.invariantViolations;
  }
  return {
    seedCount: seedValues.length,
    stepsPerSeed: options.stepsPerSeed,
    totalStateMachineSteps: seedValues.length * options.stepsPerSeed,
    digest: await digestEvents(events),
    seeds,
    events,
    operationCounts,
    faultCounts,
    typedFailures,
    simulatedRestarts,
    recoveries,
    invariantViolations,
  };
}
