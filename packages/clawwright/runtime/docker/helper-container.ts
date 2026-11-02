// The optional long-lived helper container: startHelper/stopHelper/helperRunning warm it up
// so execInHelper/execCommand can exec into it instead of paying runOneOff's per-call
// create/destroy cost (~5-7s one-off vs ~1-3s exec once warm).

import { randomBytes } from "node:crypto";
import { emitRaw, outputSink } from "../../core/io/output.ts";
import type { ExecResult, Transport } from "../transport/transport.ts";
import { composeExecFailure } from "../transport/exec.ts";
import { HelperNotRunning } from "../runtime.ts";

export const HELPER_TIMEOUT_SUPERVISOR = `const {spawn}=require('node:child_process');const [ms,nonce,command,...args]=process.argv.slice(1);let expired=false,closed=false,finished=false,result=1,poll;const child=spawn(command,args,{stdio:'inherit',detached:true});function signal(){if(!child.pid)return;try{process.kill(-child.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}}function alive(){if(!child.pid)return false;try{process.kill(-child.pid,0);return true}catch(e){if(e.code==='ESRCH')return false;throw e}}function finish(code){if(finished)return;finished=true;clearTimeout(timer);clearTimeout(reserve);clearTimeout(poll);process.stderr.write('\\nCFHELPER:'+nonce+':'+JSON.stringify({kind:expired?'timeout':'completed',code})+'\\n');process.exitCode=0}function quiesce(){if(finished)return;signal();if(closed&&!alive())return finish(expired?124:result);poll=setTimeout(quiesce,20)}function expire(){expired=true;quiesce()}const timer=setTimeout(expire,Number(ms));const reserve=setTimeout(()=>{signal();if(closed&&!alive())finish(expired?124:result);else{process.stderr.write('\\nCFHELPER:'+nonce+':'+JSON.stringify({kind:'uncertain',code:125})+'\\n');process.exit(0)}},Number(ms)+5000);process.on('SIGTERM',expire);process.on('SIGINT',expire);child.on('error',()=>{closed=true;result=127;quiesce()});child.on('close',(code)=>{closed=true;result=code??1;quiesce()});process.on('exit',()=>{if(!finished)signal()})`;
export const HELPER_TIMEOUT_GRACE_MS = 10000;
/** The pure `-t` decision for `docker exec`: a terminal without piped input gets the PTY
 *  (today's behaviour); finite input means this process's stdin side is a pipe, and Docker
 *  rejects `-t` with "the input device is not a TTY" — so input never gets `-t`. Exported so
 *  the check pins the decision without a docker call. */
export function execTty(isTTY: boolean, hasInput: boolean): boolean {
  return isTTY && !hasInput;
}

export class HelperContainer {
  #transport: Transport;
  #compose: (args: string[], stream?: boolean, allowFailure?: boolean) => Promise<ExecResult>;
  #containerId: (service?: string, all?: boolean, timeoutMs?: number) => Promise<string | undefined>;

  constructor(
    transport: Transport,
    compose: (args: string[], stream?: boolean, allowFailure?: boolean) => Promise<ExecResult>,
    containerId: (service?: string, all?: boolean, timeoutMs?: number) => Promise<string | undefined>,
  ) {
    this.#transport = transport;
    this.#compose = compose;
    this.#containerId = containerId;
  }

  async startHelper(service: string, profile: string): Promise<void> {
    await this.#compose(["--profile", profile, "up", "--detach", service], true);
  }

  async stopHelper(service: string, profile: string): Promise<void> {
    await this.#compose(["--profile", profile, "rm", "--force", "--stop", service], true);
  }

  async helperRunning(service: string): Promise<boolean> {
    const result = await this.#compose(["ps", "--quiet", service], false, true);
    return result.stdout.trim() !== "";
  }

  /** `-i` keeps stdin open — required for the MCP stdio bridge, harmless otherwise. `-t` is
   *  added only on a real terminal, mirroring the `-T` compose gets from `runOneOff`: a PTY
   *  does not survive the trip through wsl.exe. */
  async execInContainer(
    service: string,
    command: string,
    args: string[],
    options: { input?: string; stream?: boolean; stdioProtocol?: boolean; allowFailure?: boolean; timeoutMs?: number },
  ): Promise<ExecResult> {
    // Only a RUNNING container (all=false): about to exec into it.
    const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error("helper deadline expired before discovery");
    const id = await this.#containerId(service, false, options.timeoutMs);
    if (id === undefined) {
      throw new HelperNotRunning(service);
    }

    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) throw new Error("helper deadline expired before exec");
    const supervised = remaining !== undefined && options.stdioProtocol !== true;
    const execArgs = ["exec", "-i"];
    if (!supervised && options.stdioProtocol !== true && execTty(process.stdout.isTTY === true, options.input !== undefined)) execArgs.push("-t");
    const nonce = supervised ? randomBytes(24).toString("hex") : "";
    const invocation = supervised ? ["node", "-e", HELPER_TIMEOUT_SUPERVISOR, String(remaining), nonce, command, ...args] : [command, ...args];
    let result: ExecResult;
    try { result = await this.#transport.exec("docker", [...execArgs, id, ...invocation], {
      stream: supervised ? false : options.stream ?? options.input === undefined,
      input: options.input,
      stdioProtocol: options.stdioProtocol,
      allowFailure: supervised ? true : options.allowFailure,
      timeoutMs: supervised ? remaining! + HELPER_TIMEOUT_GRACE_MS : remaining,
    }); } catch (cause) {
      if (!supervised) throw cause;
      throw Object.assign(new Error("supervised helper transport disconnected; owned process-group quiescence unconfirmed"), { code: "HELPER_QUIESCENCE", cause: { transportRejected: true } });
    }
    if (!supervised) return result;
    const marker = `\nCFHELPER:${nonce}:`, at = result.stderr.lastIndexOf(marker);
    let outcome: { kind?: string; code?: number } = {};
    if (at >= 0 && result.stderr.endsWith("\n")) {
      try {
        const parsed: unknown = JSON.parse(result.stderr.slice(at + marker.length, -1));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) outcome = parsed as { kind?: string; code?: number };
      } catch { /* Missing/malformed receipt is uncertain. */ }
    }
    const stderr = at >= 0 ? result.stderr.slice(0, at) : result.stderr;
    if (result.timedOut || result.code !== 0 || !["completed", "timeout"].includes(outcome.kind ?? "") || !Number.isInteger(outcome.code) || outcome.code! < 0 || outcome.code! > 255) throw Object.assign(new Error("owned helper process-group quiescence unconfirmed; inspect before further mutation"), { code: "HELPER_QUIESCENCE", exitCode: result.code, timedOut: result.timedOut === true });
    const clean = { ...result, stderr, code: outcome.code!, ...(outcome.kind === "timeout" ? { timedOut: true as const } : {}) };
    if (options.input === undefined) { emitRaw(clean.stdout); const sink = outputSink(); if (sink) sink(clean.stderr); else process.stderr.write(clean.stderr); }
    if (options.allowFailure !== true && clean.code !== 0) {
      throw Object.assign(composeExecFailure(command, args, clean), { exitCode: clean.code, timedOut: clean.timedOut });
    }
    return clean;
  }

  /** "node dist/index.js" is hardcoded: it's the `cli` service's own entrypoint, which
   *  `docker exec` doesn't apply on its own the way `compose run` does. execCommand below is
   *  the same call with the entrypoint left to the caller. */
  async execInHelper(
    service: string,
    args: string[],
    options: { input?: string; stream?: boolean; stdioProtocol?: boolean; allowFailure?: boolean; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    return this.execInContainer(service, "node", ["dist/index.js", ...args], options);
  }

  async execCommand(
    service: string,
    command: string,
    args: string[],
    options: { input?: string; stream?: boolean; stdioProtocol?: boolean; allowFailure?: boolean; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    return this.execInContainer(service, command, args, options);
  }
}
