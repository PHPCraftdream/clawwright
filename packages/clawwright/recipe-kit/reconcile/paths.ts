// Safe dot-path grammar and segment matching for the reconcile primitive. Kept local: the
// manifest-side validator lives with the service loader, whose imports must stay out of the
// recipe-kit entry.

import { RecipeKitRefusal } from "../types.ts";

const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const DOT_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

/** Returns the segment when safe, else undefined — callers decide refusal vs skip. */
export function safeReconcileSegment(value: string): string | undefined {
  return SEGMENT.test(value) && !UNSAFE_SEGMENTS.has(value) ? value : undefined;
}

/** Validates a full dot configuration path; returns it unchanged when safe. */
export function safeReconcilePath(value: unknown): string {
  if (typeof value !== "string" || !DOT_PATH.test(value) || value.split(".").some((part) => !safeReconcileSegment(part))) {
    throw new RecipeKitRefusal("invalid-request", "path must be a safe dot configuration path");
  }
  return value;
}

/** Segment-wise: `a.b` is under prefix `a`, never under prefix `a.bc`. */
export function underReconcilePrefix(prefix: string, path: string): boolean {
  const head = prefix.split(".");
  const tail = path.split(".");
  return head.length < tail.length && head.every((segment, index) => segment === tail[index]);
}
