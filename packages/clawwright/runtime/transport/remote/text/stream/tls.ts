import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { Agent } from "node:https";
import { connect } from "node:tls";
import { validateBootstrap, type SsjackBootstrap } from "../../ssjack-client.ts";

const fail = (): Error => new Error("SSJACK_TEXT_STREAM_TLS_FAILED");

/** Probe without HTTP or bearer, then use only the exact pinned certificate. */
export async function textStreamAgent(bootstrap: SsjackBootstrap, signal: AbortSignal): Promise<Agent> {
  validateBootstrap(bootstrap);
  if (signal.aborted) throw fail();
  const endpoint = new URL(bootstrap.endpoint);
  const pin = Buffer.from(bootstrap.pin, "hex");
  const matches = (raw: Buffer): boolean => timingSafeEqual(createHash("sha256").update(raw).digest(), pin);
  const certificate = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(endpoint.port), rejectUnauthorized: false, minVersion: "TLSv1.3" });
    let settled = false;
    let error: Error | undefined;
    let pem: string | undefined;
    const finish = (failure?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      error = failure;
      pem = value;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
    };
    const onAbort = (): void => finish(fail());
    const timer = setTimeout(onAbort, 5000);
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("error", () => finish(fail()));
    socket.once("secureConnect", () => {
      try {
        const raw = socket.getPeerCertificate().raw;
        if (raw === undefined || !matches(raw) || signal.aborted) { finish(fail()); return; }
        finish(undefined, new X509Certificate(raw).toString());
      } catch { finish(fail()); }
    });
    socket.once("close", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (!settled || error !== undefined || pem === undefined || signal.aborted) reject(fail());
      else resolve(pem);
    });
  });
  if (signal.aborted) throw fail();
  return new Agent({
    ca: certificate, rejectUnauthorized: true, minVersion: "TLSv1.3", keepAlive: false, maxSockets: 1,
    checkServerIdentity: (_host, cert) => cert.raw !== undefined && matches(cert.raw) ? undefined : fail(),
  });
}
