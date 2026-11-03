// The egress probe: the `node -e` script observeEgress (live.ts) execs into the gateway
// container, and the budgets bounding it. Own file because the script is shipped text
// checks time against a shorter deadline.
//
// Outbound reachability is asked of the CONTAINER, not this machine: a name that resolves
// on the operator side and not inside the container is a real outage the inbound probes
// stay green through. `node -e` (not curl, which isn't guaranteed present). Endpoints
// travel on stdin, never argv, since a proxy URL can carry credentials and argv ends up in
// logs.
//
// dns.lookup and fetch are checked separately since they fail differently; non-HTTP
// schemes (tor socks5) get a plain TCP connect instead of fetch. One deadline per endpoint,
// armed before dns.lookup and kept armed through the fetch body, so expiry always answers
// "timeout" rather than throwing or hanging.

// Whole-probe budget per endpoint (DNS, connect, headers, body). Endpoints probe
// concurrently, so this is also the script's wall-clock ceiling once node is up.
export const EGRESS_PROBE_TIMEOUT_MS = 5000;

// Bounds the exec carrying the script, with slack for node boot + docker/WSL — a deadline
// the child can ignore isn't a deadline; MCP dispatch is sequential, so one wedged exec
// stalls every queued request.
export const EGRESS_EXEC_TIMEOUT_MS = EGRESS_PROBE_TIMEOUT_MS + 5000;

/** The script observeEgress execs into the gateway container, parameterized by the
 *  per-endpoint budget so checks can use a shorter deadline than production. Exported so
 *  checks time the exact shipped text. */
export function egressProbeScript(timeoutMs: number): string {
  return `const dns = require("dns").promises;
const net = require("net");
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let urls = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) urls = parsed.filter((url) => typeof url === "string");
  } catch (error) {}
  Promise.all(urls.map((url) => probe(url)))
    .then((answers) => { console.log(JSON.stringify(answers)); })
    .catch((error) => { console.log("[]"); });
});
const TIMEOUT_MS = ${timeoutMs};
async function probe(url) {
  let host;
  let port;
  let isHttp;
  let target;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = parsed.port;
    isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
    // fetch refuses a URL carrying userinfo (a credentialed proxy URL) before any request;
    // reachability needs no credentials, so they never leave the URL they came in.
    parsed.username = "";
    parsed.password = "";
    target = parsed.href;
  } catch (error) {
    return { url, state: "invalid" };
  }
  const controller = new AbortController();
  let atDeadline = false;
  let deadlineFired = () => {};
  const deadlineReached = new Promise((resolve) => { deadlineFired = resolve; });
  const giveUp = setTimeout(() => { atDeadline = true; controller.abort(); deadlineFired(); }, TIMEOUT_MS);
  const timeoutAnswer = () => ({ url, state: "timeout", detail: "no answer within " + TIMEOUT_MS + "ms" });
  try {
    try {
      // dns.lookup takes no signal, so the lookup races the deadline instead; the lookup is
      // drained through .catch on the way into the race, because a loser that rejects later
      // would otherwise be an unhandled rejection and kill the whole probe process.
      const lookup = dns.lookup(host);
      await Promise.race([lookup.catch(() => undefined), deadlineReached]);
      if (atDeadline) return timeoutAnswer();
      await lookup;
    } catch (error) {
      if (atDeadline) return timeoutAnswer();
      return { url, state: "dns", detail: String((error && error.code) || (error && error.message) || error) };
    }
    if (!isHttp) {
      return await new Promise((resolve) => {
        const socket = net.connect({ host, port: port === "" ? 1080 : Number(port) });
        const finish = (answer) => { socket.destroy(); resolve(answer); };
        socket.once("connect", () => { finish({ url, state: "ok" }); });
        socket.once("error", (error) => { finish({ url, state: "unreachable", detail: String((error && error.code) || error.message) }); });
        deadlineReached.then(() => { finish(timeoutAnswer()); });
      });
    }
    if (typeof fetch !== "function") {
      return { url, state: "unreachable", detail: "this node has no fetch to probe with" };
    }
    try {
      const response = await fetch(target, { signal: controller.signal, redirect: "manual" });
      if (atDeadline) return timeoutAnswer();
      // fetch settles on the headers, and the body is not wanted: cancel it while the
      // deadline is still armed, so a server that sends headers and then never ends the
      // body cannot hold the connection — or this probe — open past the budget.
      await Promise.race([response.body?.cancel().catch(() => undefined), deadlineReached]);
      if (atDeadline) return timeoutAnswer();
      return { url, state: "ok" };
    } catch (error) {
      if (atDeadline) return timeoutAnswer();
      const cause = (error && error.cause) || error;
      return { url, state: "unreachable", detail: String((cause && cause.code) || (cause && cause.message) || cause) };
    }
  } finally {
    clearTimeout(giveUp);
  }
}`;
}

export const EGRESS_PROBE_SCRIPT = egressProbeScript(EGRESS_PROBE_TIMEOUT_MS);
