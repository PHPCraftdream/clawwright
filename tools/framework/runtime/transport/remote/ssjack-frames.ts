import { UserError } from "#src/core/io/log.ts";
import { SSJACK_REQUIREMENTS } from "./ssjack-contract.ts";

/** One validated transport-read reply; output bytes have not been decoded as text. */
export type SsjackFrame =
  | { readonly kind: "pending" }
  | { readonly kind: "data"; readonly stream: "stdout" | "stderr"; readonly data: Buffer }
  | { readonly kind: "done"; readonly code: number; readonly timedOut: boolean; readonly error?: string };

/** Refuse malformed DTOs without echoing untrusted response values or credentials. */
function invalid(): never {
  throw new UserError("SSJACK_FRAME_INVALID");
}

/** Validate the scope-local job identity returned by a successful start. */
export function startIdentity(reply: Record<string, unknown>): string {
  if (typeof reply.job_id !== "string" || !/^[0-9a-f]{64}$/.test(reply.job_id)) invalid();
  return reply.job_id;
}

/** Only an explicit false authorizes retrying the same input chunk. */
export function inputAccepted(reply: Record<string, unknown>): boolean {
  if (typeof reply.accepted !== "boolean") invalid();
  return reply.accepted;
}

/** Check output DTO consistency and canonical base64 before allocating a decoded chunk. */
export function readFrame(reply: Record<string, unknown>): SsjackFrame {
  if (typeof reply.done !== "boolean" ||
      (reply.pending !== undefined && typeof reply.pending !== "boolean") ||
      (reply.timed_out !== undefined && typeof reply.timed_out !== "boolean")) invalid();
  if (reply.done) {
    if (reply.pending === true || reply.stream !== undefined || reply.data !== undefined ||
        typeof reply.exit_code !== "number" || !Number.isInteger(reply.exit_code) || reply.exit_code < -1 || reply.exit_code > 255 ||
        (reply.timed_out !== undefined && typeof reply.timed_out !== "boolean") ||
        (reply.error !== undefined && (typeof reply.error !== "string" || reply.error.length > 65536))) invalid();
    return {
      kind: "done", code: reply.exit_code, timedOut: reply.timed_out === true,
      ...(typeof reply.error === "string" && reply.error !== "" ? { error: reply.error } : {}),
    };
  }
  if (reply.error !== undefined || reply.timed_out === true) invalid();
  if (reply.pending === true) {
    if (reply.stream !== undefined || reply.data !== undefined) invalid();
    return { kind: "pending" };
  }
  if (reply.stream !== "stdout" && reply.stream !== "stderr") invalid();
  if (typeof reply.data !== "string" || reply.data.length === 0 ||
      reply.data.length > Math.ceil(SSJACK_REQUIREMENTS.chunkSize / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(reply.data)) invalid();
  const data = Buffer.from(reply.data, "base64");
  if (data.length > SSJACK_REQUIREMENTS.chunkSize || data.toString("base64") !== reply.data) invalid();
  return { kind: "data", stream: reply.stream, data };
}
