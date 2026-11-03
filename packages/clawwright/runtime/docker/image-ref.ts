// Image references — one grammar, owned here as a value: [registry[:port]/]repo[:tag]
// [@algorithm:<hex>]. A registry port's colon is always followed by a slash, never
// read as a tag. Call sites parse once and pass the value on; .env, the recreated container
// and every report get the same format() string. Also registry digest resolution and
// exit-code readback for the `upgrade` command.

import { UserError } from "../../core/io/log.ts";
import { ValueError, type ValueParser } from "../../core/values/value.ts";
import type { Transport } from "../transport/transport.ts";

const DIGEST = /^[A-Za-z][A-Za-z0-9]*(?:[+._-][A-Za-z][A-Za-z0-9]*)*:[0-9A-Fa-f]{32,}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SHA512 = /^sha512:[0-9a-f]{128}$/;

declare const localImageIdBrand: unique symbol;
export type LocalImageId = string & { readonly [localImageIdBrand]: true };

// Local image IDs name Docker objects, not repositories, tags, or repository digests.
export function tryParseLocalImageId(value: string): LocalImageId | undefined {
  return value.length === 71 && SHA256.test(value) ? value as LocalImageId : undefined;
}

function validDigest(value: string): boolean {
  if (!DIGEST.test(value)) return false;
  if (value.startsWith("sha256:")) return SHA256.test(value);
  if (value.startsWith("sha512:")) return SHA512.test(value);
  return true;
}
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
// Docker path components: separators cannot lead, trail, or mix without an alphanumeric run.
const REPOSITORY = /^[a-z0-9]+(?:(?:\.|_{1,2}|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_{1,2}|-+)[a-z0-9]+)*)*$/;
const DNS_COMPONENT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function validRegistry(value: string): boolean {
  if (value.startsWith("[")) {
    const match = /^(\[[0-9A-Fa-f:]+\])(?::[0-9]+)?$/.exec(value);
    if (match === null) return false;
    // URL validates compressed IPv6 and the number/width of its groups, not just its alphabet.
    try {
      return new URL(`http://${match[1]}/`).hostname.startsWith("[");
    } catch {
      return false;
    }
  }
  const match = /^([^:]+)(?::[0-9]+)?$/.exec(value);
  if (match === null) return false;
  const host = match[1];
  return host.length <= 253 && host.split(".").every((part) => DNS_COMPONENT.test(part));
}

/** A parsed image reference. `registry` is a host with an optional port. */
export interface ImageRef {
  readonly registry?: string;
  readonly repository: string;
  readonly tag?: string;
  readonly digest?: string;
}

// A leading dash would reach docker's own argv as a flag (`upgrade --image=-x` ran
// `docker buildx imagetools inspect -x`). Docker has never accepted one, so no recorded
// value can exist — refusing it at the grammar breaks no reader.
function splitReference(value: string): ImageRef | undefined {
  if (value === "" || value.trim() !== value || /\s/.test(value)) return undefined;
  let rest = value;
  let digest: string | undefined;
  const at = value.lastIndexOf("@");
  if (at >= 0) {
    rest = value.slice(0, at);
    digest = value.slice(at + 1);
    if (!validDigest(digest)) return undefined;
  }
  let registry: string | undefined;
  const slash = rest.indexOf("/");
  if (slash > 0) {
    const head = rest.slice(0, slash);
    if (head.includes(".") || head.includes(":") || head.startsWith("[") || head === "localhost") {
      if (!validRegistry(head)) return undefined;
      registry = head;
      rest = rest.slice(slash + 1);
    }
  }
  let repository = rest;
  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    tag = rest.slice(colon + 1);
    repository = rest.slice(0, colon);
    if (!TAG.test(tag) || repository === "") return undefined;
  }
  if (!REPOSITORY.test(repository)) return undefined;
  return { registry, repository, tag, digest };
}

/** The grammar refusal, shared with the checks that prove it names the input. */
export function invalidImageReference(value: string): string {
  return `"${value}" is not a valid image reference — expected [registry[:port]/]repo[:tag][@algorithm:<at least 32 hex characters>] (sha256: exactly 64 lowercase hex; sha512: exactly 128 lowercase hex)`;
}

/** Parses a reference, throwing a UserError that names the input on anything else. */
export function parse(value: string): ImageRef {
  const ref = tryParse(value);
  if (ref === undefined) {
    throw new UserError(invalidImageReference(value));
  }
  return ref;
}

export function tryParse(value: string): ImageRef | undefined {
  return splitReference(value);
}

/** The canonical string form — parse(format(x)) is x again. */
export function format(ref: ImageRef): string {
  const registry = ref.registry === undefined ? "" : `${ref.registry}/`;
  const tag = ref.tag === undefined ? "" : `:${ref.tag}`;
  const digest = ref.digest === undefined ? "" : `@${ref.digest}`;
  return `${registry}${ref.repository}${tag}${digest}`;
}

/** The `repo[:tag]` a tag names, with any digest removed — the channel a plain upgrade
 *  re-resolves, independent of which content it currently points at. */
export function channel(ref: ImageRef): string {
  return format({ ...ref, digest: undefined });
}

/** The registry/repository a reference names, with any tag or digest stripped. */
export function repositoryOf(ref: ImageRef): string {
  return format({ registry: ref.registry, repository: ref.repository });
}

export function withDigest(ref: ImageRef, digest: string): ImageRef {
  return { ...ref, digest };
}

/** The digest a reference carries, or a bare sha256 digest (Docker's own answer)
 *  — or undefined when it names no exact content. A value that carries no
 *  well-formed digest but ends in `@sha256:…` still yields that suffix: content comparison
 *  is lexical, and a pin already recorded in a non-canonical spelling must keep comparing
 *  equal to itself. Only parse() enforces the grammar. */
export function digestOf(value: string): string | undefined {
  if (SHA256.test(value)) return value;
  const parsed = tryParse(value);
  if (parsed !== undefined) return parsed.digest;
  const at = value.lastIndexOf("@sha256:");
  return at >= 0 ? value.slice(at + 1) : undefined;
}

/** Whether a value pins exact content — `repo[:tag]@algorithm:…` — rather than a moving tag.
 *  The grammar decides, like parse(): a malformed digest pins nothing (digestOf keeps the
 *  lexical suffix for comparing a spelling already on record). */
export function hasDigest(value: string): boolean {
  return tryParse(value)?.digest !== undefined;
}

function contentId(value: string): string {
  const digest = digestOf(value);
  if (digest !== undefined) return digest;
  const ref = tryParse(value);
  return ref === undefined ? value : format(ref);
}

/** Whether two spellings name the same content: a digest and the reference carrying it match,
 *  so do a bare Docker digest and its full form; two tag-only references match only when
 *  identical — a tag never stands for whatever it happens to resolve to right now. */
export function sameContent(a: string, b: string): boolean {
  return contentId(a) === contentId(b);
}

/** Registry digest for `reference` via `docker buildx imagetools inspect` — never pulls a
 *  layer or moves a local tag, unlike `docker pull`/`docker image inspect`. Undefined on any
 *  failure: "could not ask" must never read as "asked and got nothing". Returns the channel
 *  pinned with the resolved digest (`repo:tag@sha256:…`), so `upgrade` reads the tag back to
 *  know what to re-resolve. */
export async function resolveImageDigest(transport: Transport, reference: string): Promise<string | undefined> {
  const result = await transport.exec("docker", ["buildx", "imagetools", "inspect", reference], { allowFailure: true });
  const digest = result.code === 0 ? /^Digest:\s+(\S+)/m.exec(result.stdout)?.[1] : undefined;
  // Registry resolution accepts only canonical SHA256, independently of reference grammar.
  if (digest === undefined || !SHA256.test(digest)) return undefined;
  const ref = tryParse(reference);
  return ref === undefined ? undefined : format(withDigest(ref, digest));
}

/** The container's own exit code, or undefined when there is no container or the inspect
 *  failed — how a migration failure (upstream docs: exit code 78) is told apart from one
 *  still starting up. */
export async function lastExitCode(transport: Transport, containerId: string | undefined): Promise<number | undefined> {
  if (containerId === undefined) return undefined;
  const result = await transport.exec("docker", ["inspect", "--format", "{{.State.ExitCode}}", containerId], { allowFailure: true });
  return result.code === 0 ? Number.parseInt(result.stdout.trim(), 10) : undefined;
}

/** `upgrade --image` as an argument parser: the reference's own refusal, after the label. */
export const imageRefValue: ValueParser<ImageRef> = {
  expected: "an image reference",
  example: "ghcr.io/openclaw/openclaw:latest",
  invalidExample: "not an image",
  parse(raw) {
    try {
      return parse(raw);
    } catch (error) {
      throw new ValueError(`: ${(error as Error).message}`);
    }
  },
};
