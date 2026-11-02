// Docker implementation of the runtime contract.
//
// The only module that knows the words "docker" and "compose". Takes the transport, settings
// and path bridge directly rather than a Context, so the context can build it without a
// circular import.
//
// A thin orchestrator: each responsibility (compose operations, container/image
// introspection, the helper container, a side stack) lives in its own file under
// runtime/docker/, constructed here. Settings are handed over as accessors rather than a
// shared private field, since reconcile() replaces the whole Settings object and every
// helper must see that replacement immediately, not a snapshot taken at construction time.

import type { Settings } from "../../core/env.ts";
import type { PathBridge } from "../../core/paths.ts";
import type { ExecResult, Transport } from "../transport/transport.ts";
import { sleep, type Runtime, type RunOneOffOptions, type RuntimeLogRecord, type Stack } from "../runtime.ts";
import { ComposeOperations, serializeComposeEnv } from "./compose-operations.ts";
import { ContainerIntrospection } from "./container-introspection.ts";
import { HelperContainer } from "./helper-container.ts";
import { buildStack } from "./side-stack/index.ts";

export { serializeComposeEnv };

/** Which service this runtime operates. Supplied by the application: the framework has no
 *  opinion about what the managed service is called.
 *
 *  There is no container name here on purpose — the container is found through the compose
 *  project, so two deployments of the same definition cannot answer for each other. */
export interface DockerRuntimeOptions {
  /** Compose service name, e.g. "gateway". */
  readonly service: string;
  /** How many log lines to show by default. */
  readonly logTail?: string;
  /** Builds the Settings a recreate interpolates, re-reading .env at call time and layering
   *  the application's computed settings back on top. Without it reconcile() falls back to a
   *  bare .env re-read, which silently drops app-computed Compose variables. */
  readonly reconcileSettings?: () => Promise<Settings>;
}

export class DockerRuntime implements Runtime {
  readonly description = "docker";
  readonly requiredTools = ["docker"];

  #transport: Transport;
  #settings: Settings;
  #paths: PathBridge;

  #compose: ComposeOperations;
  #introspect: ContainerIntrospection;
  #helper: HelperContainer;

  constructor(
    transport: Transport,
    settings: Settings,
    paths: PathBridge,
    options: DockerRuntimeOptions,
  ) {
    this.#transport = transport;
    this.#settings = settings;
    this.#paths = paths;

    this.#compose = new ComposeOperations(
      transport,
      () => this.#settings,
      (settings) => { this.#settings = settings; },
      paths,
      options.service,
      options.logTail ?? "100",
      options.reconcileSettings,
    );
    this.#introspect = new ContainerIntrospection(transport, () => this.#settings, () => options.service);
    this.#helper = new HelperContainer(
      transport,
      (args, stream, allowFailure) => this.#compose.compose(args, stream, allowFailure),
      (service, all, timeoutMs) => this.#introspect.containerId(service, all, timeoutMs),
    );
  }

  async start(): Promise<void> {
    return this.#compose.start();
  }

  async stop(extraArgs: string[] = []): Promise<void> {
    return this.#compose.stop(extraArgs);
  }

  async pause(): Promise<void> {
    return this.#compose.pause();
  }

  async restart(): Promise<void> {
    return this.#compose.restart();
  }

  async reconcile(): Promise<void> {
    return this.#compose.reconcile();
  }

  async followLogs(extraArgs: string[] = []): Promise<void> {
    return this.#compose.followLogs(extraArgs);
  }

  async readLogRecords(tail?: string, extraArgs: string[] = []): Promise<RuntimeLogRecord[]> {
    return this.#compose.readLogRecords(tail, extraArgs);
  }

  async readLogs(tail?: string, extraArgs: string[] = []): Promise<string> {
    return this.#compose.readLogs(tail, extraArgs);
  }

  async showStatus(): Promise<void> {
    return this.#compose.showStatus();
  }

  async pullImage(): Promise<void> {
    return this.#compose.pullImage();
  }

  async isRunning(): Promise<boolean> {
    return this.#compose.isRunning();
  }

  async recreateWithImage(reference: string, onMutationStart?: () => void): Promise<void> {
    return this.#compose.recreateWithImage(reference, onMutationStart);
  }

  async runOneOff(service: string, args: string[], options: RunOneOffOptions = {}): Promise<ExecResult> {
    return this.#compose.runOneOff(service, args, options);
  }

  async health(): Promise<string> {
    return this.#introspect.health();
  }

  async portConflict(port: string): Promise<string | undefined> {
    return this.#introspect.portConflict(port);
  }

  async resolveImageDigest(reference: string): Promise<string | undefined> {
    return this.#introspect.resolveImageDigest(reference);
  }

  async lastExitCode(): Promise<number | undefined> {
    return this.#introspect.lastExitCode();
  }

  async captureIncidentSnapshot(tail: string): Promise<{ logs: string; inspect: string } | undefined> {
    return this.#introspect.captureIncidentSnapshot(tail);
  }

  async imageReference(): Promise<string | undefined> {
    return this.#introspect.imageReference();
  }

  async runningImageIdentity(): Promise<
    { imageId: string; digests: string[]; version?: string; containerId: string } | undefined
  > {
    return this.#introspect.runningImageIdentity();
  }

  async runningEnvironment(): Promise<Record<string, string> | undefined> {
    return this.#introspect.runningEnvironment();
  }

  async runningConnectionFacts(): Promise<
    { dataDir?: string; port?: string; bindAddress?: string; composeProject?: string; image?: string } | undefined
  > {
    return this.#introspect.runningConnectionFacts();
  }

  async startedAt(): Promise<number | undefined> {
    return this.#introspect.startedAt();
  }

  async startHelper(service: string, profile: string): Promise<void> {
    return this.#helper.startHelper(service, profile);
  }

  async stopHelper(service: string, profile: string): Promise<void> {
    return this.#helper.stopHelper(service, profile);
  }

  async helperRunning(service: string): Promise<boolean> {
    return this.#helper.helperRunning(service);
  }

  async execInHelper(
    service: string,
    args: string[],
    options: { input?: string; stream?: boolean; stdioProtocol?: boolean; allowFailure?: boolean; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    return this.#helper.execInHelper(service, args, options);
  }

  async execCommand(
    service: string,
    command: string,
    args: string[],
    options: { input?: string; stream?: boolean; stdioProtocol?: boolean; allowFailure?: boolean; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    return this.#helper.execCommand(service, command, args, options);
  }

  /** Probed from the instance's side: the port is published on the target's loopback and
   *  may be unreachable from this machine. */
  async probe(endpoint: string, timeoutMs = 5000): Promise<number> {
    const url = `${this.#settings.serviceUrl}/${endpoint}`;
    const result = await this.#transport.exec(
      "curl",
      ["-fsS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", String(Math.ceil(timeoutMs / 1000)), url],
      { allowFailure: true },
    );
    const code = Number.parseInt(result.stdout.trim(), 10);
    return Number.isNaN(code) ? 0 : code;
  }

  /** A side stack: separate compose project, separate lifecycle. */
  stack(project: string, definitionPath: string, ownership?: { verifyOwnership: boolean; legacyProjects?: readonly string[]; recipeName?: string }): Stack {
    return buildStack(
      this.#transport,
      this.#paths,
      () => this.#settings,
      (action, settings) => this.#compose.withEnvFile(action, settings),
      project,
      definitionPath,
      ownership,
    );
  }

  async waitForHealth(timeoutSeconds = 180): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if ((await this.probe("healthz")) === 200) return;
      if (!(await this.isRunning())) {
        throw new Error(`the service container stopped while starting up — check ${commandLine(["logs"])}`);
      }
      await sleep(2000);
    }
    throw new Error(`the service did not become healthy within ${timeoutSeconds}s`);
  }
}
import { commandLine } from "../../core/io/invocation/render.ts";
