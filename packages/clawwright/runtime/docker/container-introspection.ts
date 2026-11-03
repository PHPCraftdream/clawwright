// Everything this runtime learns by asking Docker directly about the service's own
// container and image, independent of compose: found through the two labels compose itself
// writes on the container (project and service) rather than by name — `docker ps --filter
// name=x` is a substring match, so a second deployment's container would answer for the
// first. Split out of runtime-docker.ts to keep that file orchestration-only.

import { composeProjectName } from "../deployment.ts";
import type { Settings } from "../../core/env.ts";
import type { Transport } from "../transport/transport.ts";
import { resolveImageDigest as resolveDigest, lastExitCode as readLastExitCode } from "./image-ref.ts";
import { captureIncidentSnapshot as readIncidentSnapshot } from "./incident-snapshot.ts";

export class ContainerIntrospection {
  #transport: Transport;
  #getSettings: () => Settings;
  #getService: () => string;

  constructor(transport: Transport, getSettings: () => Settings, getService: () => string) {
    this.#transport = transport;
    this.#getSettings = getSettings;
    this.#getService = getService;
  }

  /** The service's container id, or undefined when it does not exist. Matched by the two
   *  labels compose writes on the container (project and service) rather than by name —
   *  `docker ps --filter name=x` is a substring match, so a second deployment's container
   *  would answer for the first. Asked of Docker directly rather than through compose, since
   *  labels need no environment interpolation, skipping the compose env-file's whole
   *  setup/teardown for a fact plain `docker ps` answers in one call. Asked fresh every call,
   *  never cached: this runtime instance can outlive an external `docker stop`. */
  async containerId(service: string = this.#getService(), all = true, timeoutMs?: number): Promise<string | undefined> {
    if (timeoutMs !== undefined && timeoutMs <= 0) throw new Error("container discovery deadline expired");
    const result = await this.#transport.exec(
      "docker",
      [
        "ps",
        ...(all ? ["--all"] : []),
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${composeProjectName()}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ],
      { allowFailure: true, timeoutMs },
    );
    if (result.code !== 0 || result.timedOut) {
      if (timeoutMs !== undefined || result.timedOut) throw new Error(result.timedOut ? "container discovery timed out" : "container discovery failed");
      return undefined;
    }
    const id = result.stdout.trim().split("\n")[0]?.trim();
    return id === undefined || id === "" ? undefined : id;
  }

  /** "missing" — no container at all. "stopped" — exists but not running: `.State.Health.Status`
   *  alone can't tell this apart from running-but-unhealthy, since Docker leaves the last
   *  healthcheck verdict in place after `docker stop` rather than clearing it. Checked first,
   *  before the health verdict. "starting"/"healthy"/"unhealthy"/"none" — Docker's own verdict
   *  for a container that IS running. */
  async health(): Promise<string> {
    const id = await this.containerId();
    if (id === undefined) return "missing";

    const result = await this.#transport.exec(
      "docker",
      ["inspect", "--format", "{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", id],
      { allowFailure: true },
    );
    if (result.code !== 0) return "missing";
    const [running, health] = result.stdout.trim().split(" ");
    if (running !== "true") return "stopped";
    return health ?? "none";
  }

  /** Refuses to start when the published port already belongs to another compose project.
   *  Compose would otherwise fail with a bind error naming only the port, and the usual
   *  cause is a second deployment copied from the same template. */
  async portConflict(port: string): Promise<string | undefined> {
    const result = await this.#transport.exec(
      "docker",
      [
        "ps",
        "--filter",
        `publish=${port}`,
        "--format",
        // .Labels is a comma-joined string here, not a map: `index` on it fails and docker
        // exits non-zero. `.Label` is the accessor `docker ps` provides.
        '{{.Label "com.docker.compose.project"}}\t{{.Names}}',
      ],
      { allowFailure: true },
    );
    if (result.code !== 0) return undefined;

    for (const line of result.stdout.split("\n")) {
      const [project, container] = line.split("\t");
      if (container === undefined || container.trim() === "") continue;
      if (project === composeProjectName()) continue;
      return `${container.trim()} (compose project ${project === "" ? "none" : project})`;
    }
    return undefined;
  }

  async resolveImageDigest(reference: string): Promise<string | undefined> {
    return resolveDigest(this.#transport, reference);
  }

  async lastExitCode(): Promise<number | undefined> {
    return readLastExitCode(this.#transport, await this.containerId());
  }

  async captureIncidentSnapshot(tail: string): Promise<{ logs: string; inspect: string } | undefined> {
    return readIncidentSnapshot(this.#transport, await this.containerId(), tail);
  }

  async imageReference(): Promise<string | undefined> {
    const result = await this.#transport.exec(
      "docker",
      ["image", "inspect", "--format", "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}", this.#getSettings().image],
      { allowFailure: true },
    );
    const digest = result.stdout.trim();
    return result.code === 0 && digest !== "" ? digest : undefined;
  }

  async runningImageIdentity(): Promise<
    { imageId: string; digests: string[]; version?: string; containerId: string } | undefined
  > {
    const containerId = await this.containerId();
    if (containerId === undefined) return undefined;
    const container = await this.#transport.exec("docker", ["inspect", "--format", "{{json .}}", containerId], { allowFailure: true });
    if (container.code !== 0) return undefined;
    let state: { Image?: string; State?: { Running?: boolean } };
    try { state = JSON.parse(container.stdout); } catch { return undefined; }
    if (state?.State?.Running !== true || typeof state.Image !== "string") return undefined;
    const image = await this.#transport.exec("docker", ["image", "inspect", "--format", "{{json .}}", state.Image], { allowFailure: true });
    let metadata: { RepoDigests?: unknown; Config?: { Labels?: Record<string, string> } } = {};
    if (image.code === 0) {
      try { metadata = JSON.parse(image.stdout) ?? {}; } catch { /* Identity is still known. */ }
    }
    const digests = Array.isArray(metadata.RepoDigests) ? metadata.RepoDigests.filter((value): value is string => typeof value === "string") : [];
    const version = metadata.Config?.Labels?.["org.opencontainers.image.version"];
    return { imageId: state.Image, digests, containerId, ...(typeof version === "string" ? { version } : {}) };
  }

  /** Reads the container's OWN environment back from Docker rather than from any file this
   *  machine keeps — set once at creation from whatever .env compose read that day, and it
   *  lives on inside the container even if the operator's copy is later lost. Nothing here
   *  reads more than an operator who can already reach this target could read directly. */
  async runningEnvironment(): Promise<Record<string, string> | undefined> {
    const containerId = await this.containerId();
    if (containerId === undefined) return undefined;
    const result = await this.#transport.exec(
      "docker",
      ["inspect", "--format", "{{json .Config.Env}}", containerId],
      { allowFailure: true },
    );
    if (result.code !== 0) return undefined;
    let entries: unknown;
    try {
      entries = JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
    if (!Array.isArray(entries)) return undefined;
    const env: Record<string, string> = {};
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      const split = entry.indexOf("=");
      if (split <= 0) continue;
      env[entry.slice(0, split)] = entry.slice(split + 1);
    }
    return env;
  }

  /** Reads the connection facts the running instance is actually reachable through. Compose
   *  resolved all of these from .env at container-creation time, so the values Docker holds
   *  are what reach the instance however stale the operator's copy has become. One
   *  whole-object inspect; each field keeps its provenance: the config bind mount strips to
   *  the data dir, the published 18789/tcp gives the port and HostIp gives the bind address,
   *  the compose label gives the project, and .Config.Image keeps the original tag (the
   *  top-level .Image is the resolved ID and would pin .env to a digest it never wrote). */
  async runningConnectionFacts(): Promise<
    { dataDir?: string; port?: string; bindAddress?: string; composeProject?: string; image?: string } | undefined
  > {
    const containerId = await this.containerId();
    if (containerId === undefined) return undefined;
    const result = await this.#transport.exec("docker", ["inspect", "--format", "{{json .}}", containerId], { allowFailure: true });
    if (result.code !== 0) return undefined;
    let parsed: {
      State?: { Running?: boolean };
      Mounts?: unknown;
      NetworkSettings?: { Ports?: Record<string, unknown> };
      Config?: { Labels?: Record<string, string>; Image?: unknown };
    };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
    if (parsed?.State?.Running !== true) return undefined;
    const facts: { dataDir?: string; port?: string; bindAddress?: string; composeProject?: string; image?: string } = {};
    if (Array.isArray(parsed.Mounts)) {
      const mount = parsed.Mounts.find(
        (entry) =>
          typeof entry === "object" && entry !== null &&
          (entry as { Destination?: unknown }).Destination === "/home/node/.openclaw",
      );
      const source = typeof mount === "object" && mount !== null ? (mount as { Source?: unknown }).Source : undefined;
      // The config bind mount is "<dataDir>/config"; only a Source carrying that exact suffix
      // yields the data dir — any other shape stays absent rather than guessed.
      if (typeof source === "string" && source.endsWith("/config") && source.length > "/config".length) {
        facts.dataDir = source.slice(0, -"/config".length);
      }
    }
    const ports = parsed.NetworkSettings?.Ports?.["18789/tcp"];
    if (Array.isArray(ports)) {
      const entry = ports[0] as { HostIp?: unknown; HostPort?: unknown } | undefined;
      if (typeof entry?.HostPort === "string" && entry.HostPort !== "") facts.port = entry.HostPort;
      // Same entry, same "never guess" rule as port: absent or empty stays absent rather
      // than defaulting to 127.0.0.1 — a caller asking "is this really loopback-only right
      // now" must not be told so on the strength of a guess.
      if (typeof entry?.HostIp === "string" && entry.HostIp !== "") facts.bindAddress = entry.HostIp;
    }
    const project = parsed.Config?.Labels?.["com.docker.compose.project"];
    if (typeof project === "string" && project !== "") facts.composeProject = project;
    const image = parsed.Config?.Image;
    if (typeof image === "string" && image !== "") facts.image = image;
    return facts;
  }

  async startedAt(): Promise<number | undefined> {
    const id = await this.containerId();
    if (id === undefined) return undefined;

    const result = await this.#transport.exec(
      "docker",
      ["inspect", "--format", "{{.State.StartedAt}}", id],
      { allowFailure: true },
    );
    if (result.code !== 0) return undefined;

    // Docker prints RFC 3339 with nanoseconds, which Date happily truncates to
    // milliseconds. An unparseable value is reported as unknown rather than as epoch zero,
    // which would make every configuration file look newer than the instance.
    const parsed = Date.parse(result.stdout.trim());
    return Number.isNaN(parsed) ? undefined : parsed;
  }
}
