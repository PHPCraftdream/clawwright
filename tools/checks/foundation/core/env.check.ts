// Checks the .env parser and the settings it produces.
//
// parseEnv is deliberately not `source .env`: it must never execute anything the file
// contains, so every parsing rule (quoting, comments, first-`=`-wins) is asserted here
// rather than trusted. toSettings is checked for its required field and its defaults, since
// a wrong default silently points a deployment at the wrong directory or port.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ENV_FILE_ONLY_VARS,
  EnvSyntaxError,
  monorepoRoot,
  locksDir,
  parseDiskMinFreeMb,
  parseDurationThreshold,
  parseEnv,
  parseEnvLenient,
  readEnvValue,
  serializeEnvLine,
  shellOnlyEnvNames,
  shellOnlyEnvWarning,
  suspiciousEnvLines,
  toSettings,
  upsertEnvLine,
} from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish } from "#checks/kit/harness.ts";

// --- parseEnv ------------------------------------------------------------------

check(
  "comments and blank lines are skipped",
  parseEnv("# a comment\n\nKEY=value\n   \n# another\n"),
  { KEY: "value" },
);

check("a plain KEY=VALUE line is captured", parseEnv("KEY=value"), { KEY: "value" });

check(
  "double-quoted value has the quotes stripped",
  parseEnv('KEY="value"'),
  { KEY: "value" },
);

check(
  "single-quoted value has the quotes stripped",
  parseEnv("KEY='value'"),
  { KEY: "value" },
);

// The guard is `value.length > 1`, so a single lone quote character is data, not a pair to
// strip — stripping it would produce an empty string instead of the quote itself.
check("a lone double quote is not stripped", parseEnv('KEY="'), { KEY: '"' });
check("a lone single quote is not stripped", parseEnv("KEY='"), { KEY: "'" });

// Only the first `=` splits key from value: a value containing `=` (a URL query string, a
// base64 blob) must survive whole rather than being truncated.
check(
  "only the first = splits key from value",
  parseEnv("KEY=a=b=c"),
  { KEY: "a=b=c" },
);

check(
  "parseEnvLenient still skips a line with no = (old tolerant behavior, for scanning)",
  parseEnvLenient("NOTANASSIGNMENT\nKEY=value"),
  { KEY: "value" },
);

// Returns the structured refusal so each case can assert fields, never message prose.
function refusedParseEnv(text: string, file?: string): EnvSyntaxError {
  try {
    parseEnv(text, file);
  } catch (error) {
    if (error instanceof EnvSyntaxError) return error;
    throw error;
  }
  throw new Error("parseEnv did not throw");
}

// The typo that motivated the refusal: a missing `=` must surface, not silently drop
// OC_DATA_DIR and die later on a seemingly unrelated "not set".
{
  const error = refusedParseEnv("OC_DATA_DIR /srv/x\nKEY=value");
  check("a line with no = is refused as an EnvSyntaxError", error instanceof EnvSyntaxError, true);
  check("a line with no = carries the structured code", error.code, "ENV_LINE_WITHOUT_EQUALS");
  check("a line with no = names the 1-based line as a number", error.line, 1);
  check("a line with no = has no file when none was passed", error.file, undefined);
}
{
  const error = refusedParseEnv("SECRETMARKER-VALUE\nKEY=value", "/srv/app/.env");
  check("a refused line names the file as a structured field", error.file, "/srv/app/.env");
  check("a refused line never echoes the line's content", error.message.includes("SECRETMARKER"), false);
}
{
  const error = refusedParseEnv("KEY=value\nOC_DATA_DIR /srv/x", "/srv/app/.env");
  check("a refused line names the 1-based line as a number", error.line, 2);
  check("a refused line never echoes the line's content", error.message.includes("/srv/x"), false);
}
{
  let thrown: unknown;
  try {
    readEnvValue("BROKEN\n", "K", "/p/.env");
  } catch (error) {
    thrown = error;
  }
  const error = thrown instanceof EnvSyntaxError ? thrown : undefined;
  check("readEnvValue propagates the structured refusal", error instanceof EnvSyntaxError, true);
  check("readEnvValue's refusal carries the structured code", error?.code, "ENV_LINE_WITHOUT_EQUALS");
  check("readEnvValue's refusal names the file it was given", error?.file, "/p/.env");
  check("readEnvValue's refusal names the 1-based line as a number", error?.line, 1);
}

check("KEY= with an empty value is kept as an empty string", parseEnv("KEY="), { KEY: "" });

check(
  "whitespace around key and value is trimmed",
  parseEnv("  KEY  =  value  "),
  { KEY: "value" },
);

check(
  "a mismatched quote pair is left alone",
  parseEnv(`KEY="value'`),
  { KEY: "\"value'" },
);

check(
  "a full multi-line file parses every rule at once",
  parseEnv(
    [
      "# repo .env",
      "",
      "OC_DATA_DIR=/srv/openclaw/data",
      'OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:extended-stable"',
      "OC_SSH_HOST=",
      "QUERY=a=b&c=d",
    ].join("\n"),
  ),
  {
    OC_DATA_DIR: "/srv/openclaw/data",
    OPENCLAW_IMAGE: "ghcr.io/openclaw/openclaw:extended-stable",
    OC_SSH_HOST: "",
    QUERY: "a=b&c=d",
  },
);

// --- dotenv basics: export, inline comments, CRLF ---------------------------------

check(
  "an unquoted value drops a ` #` inline comment",
  parseEnv("A=10 # keep ten"),
  { A: "10" },
);

check(
  "a leading `export ` is stripped from the key",
  parseEnv("export C=exported"),
  { C: "exported" },
);

check(
  "export requires a space — a key merely starting with it is untouched",
  parseEnv("exported=1"),
  { exported: "1" },
);

check(
  "no interpolation: ${VAR} stays literal",
  parseEnv("E=${A}suffix"),
  { E: "${A}suffix" },
);

check(
  "a double-quoted value keeps # inside it literal",
  parseEnv('KEY="abc#def"'),
  { KEY: "abc#def" },
);

check(
  "a double-quoted value followed by an inline comment drops the comment, keeps the quotes' content",
  parseEnv('KEY="value" # comment'),
  { KEY: "value" },
);

check(
  "a single-quoted value followed by an inline comment drops the comment",
  parseEnv("KEY='value' # comment"),
  { KEY: "value" },
);

check(
  "a quoted value followed by non-comment junk is not a clean quoted value: kept whole, literal",
  parseEnv('KEY="value"junk'),
  { KEY: '"value"junk' },
);

check("KEY= with an empty value has no inline comment to trip over", parseEnv("KEY= # just a comment"), { KEY: "" });

check(
  "= inside an unquoted value survives past the first `=`, comment still stripped",
  parseEnv("KEY=a=b&c=d # comment"),
  { KEY: "a=b&c=d" },
);

check(
  "CRLF line endings parse the same as LF",
  parseEnv("A=1\r\nB=2 # c\r\nexport C=3\r\n"),
  { A: "1", B: "2", C: "3" },
);

// --- suspiciousEnvLines: doctor's own hook for a key that is not a usable name -----

check("a clean file has no suspicious lines", suspiciousEnvLines("A=1\nexport B=2\n# comment\n\n"), []);

check(
  "interior whitespace in the key is named by line number and key",
  suspiciousEnvLines("A=1\nMY KEY=oops\nB=2\n"),
  ['line 2: "MY KEY" is not a valid environment variable name'],
);

check(
  "export is stripped before the key is judged, so an exported valid key is not flagged",
  suspiciousEnvLines("export GOOD_KEY=1\n"),
  [],
);

check("a line with no = is not a key to judge", suspiciousEnvLines("STRAY LINE\nA=1\n"), []);

// --- readEnvValue: parseEnv, narrowed to one name (U2) -----------------------------

check("readEnvValue finds a plain key", readEnvValue("A=1\nB=2\n", "B"), "2");
check("readEnvValue returns undefined for an absent key", readEnvValue("A=1\n", "MISSING"), undefined);
check("readEnvValue strips a leading export", readEnvValue("export TOKEN=abc\n", "TOKEN"), "abc");
check("readEnvValue unquotes a single-quoted value", readEnvValue("TOKEN='abc'\n", "TOKEN"), "abc");
check("readEnvValue unquotes a double-quoted value", readEnvValue('TOKEN="abc"\n', "TOKEN"), "abc");
check("readEnvValue drops an inline comment on an unquoted value", readEnvValue("TOKEN=abc # comment\n", "TOKEN"), "abc");
check("readEnvValue: export and an inline comment together", readEnvValue("export TOKEN=abc # comment\n", "TOKEN"), "abc");
check("readEnvValue reads the same value across CRLF as across LF", readEnvValue("A=1\r\nexport TOKEN=abc\r\n", "TOKEN"), "abc");
check("readEnvValue: the last of a duplicate key wins, same as parseEnv", readEnvValue("TOKEN=first\nexport TOKEN=second\n", "TOKEN"), "second");

// --- upsertEnvLine: replaces NAME's line in place, export/spacing-aware (U2) -------

check("upsertEnvLine replaces a bare NAME= line", upsertEnvLine("A=1\nB=2\n", "B", "updated"), "A=1\nB=updated\n");
check("upsertEnvLine appends when the name is absent", upsertEnvLine("A=1\n", "B", "added"), "A=1\nB=added\n");
check("upsertEnvLine replaces an `export NAME=` line", upsertEnvLine("export A=1\nB=2\n", "A", "updated"), "A=updated\nB=2\n");
check("upsertEnvLine replaces a spaced `NAME =` line", upsertEnvLine("A =1\nB=2\n", "A", "updated"), "A=updated\nB=2\n");
check(
  "upsertEnvLine rewrites every duplicate of NAME, never leaves one to shadow it",
  upsertEnvLine("A=1\nexport A=2\n", "A", "updated"),
  "A=updated\nA=updated\n",
);
check("upsertEnvLine leaves unrelated and comment lines alone", upsertEnvLine("# c\nA=1\nB=2\n", "B", "x"), "# c\nA=1\nB=x\n");
check("upsertEnvLine collapses CRLF input to LF output", upsertEnvLine("A=1\r\nB=2\r\n", "B", "x"), "A=1\nB=x\n");
check(
  "a value upsertEnvLine writes reads back byte-identical through readEnvValue, edge case included",
  readEnvValue(upsertEnvLine("export A=1\n", "A", "18789  # my port"), "A"),
  "18789  # my port",
);

// --- serializeEnvLine: the write side is parseEnv's exact inverse -----------------
//
// The store writers (secrets --apply/--dump, upsertEnvValue) route through this single
// serializer. Every probe below is a structural shape, not a credential, and the check
// output above prints only booleans — no store value is ever echoed.

function roundTrips(label: string, value: string): void {
  check(
    `serialize → parse round trip: ${label}`,
    parseEnv(serializeEnvLine("PROBE_KEY", value))["PROBE_KEY"] === value,
    true,
  );
}

// The flagship loss: padding that only quoting preserves.
roundTrips("edge whitespace survives quoting", " sample ");
check(
  "a padded value is written single-quoted",
  serializeEnvLine("PROBE_KEY", " sample "),
  `PROBE_KEY=' sample '`,
);

// A value carrying its own quote character is lossless because parseEnv strips exactly
// one matched outer pair and does no escape processing: `'it's'` reads back as it's,
// and a bare `"wrapped"` — no single quote inside, but quote-wrapped — would be
// unwrapped by the next read, so it is quoted too.
roundTrips("a value containing a single quote", "it's");
roundTrips("a value that is itself double-quote-wrapped", `"wrapped"`);
roundTrips("a lone double quote (parseEnv's length>1 guard)", `"`);
roundTrips("a lone single quote", `'`);
roundTrips("a value made of two single quotes", `''`);

// parseEnv treats a bare `#` (no whitespace before it) as a literal byte, so these stay
// bare — quoting them would also round-trip, but the bare form pins the minimal quoting
// contract. A `#` WITH whitespace before it is the inline-comment case just below, and is
// not safe bare.
roundTrips("an embedded # stays literal", "abc#def");
roundTrips("a leading # is data, not a comment", "#not-a-comment");
roundTrips("a literal backslash-n is two bytes, not a newline", "a\\nb");
roundTrips("a literal double backslash stays literal", "a\\\\b");
roundTrips("interior whitespace is not edge whitespace", "a b c");
roundTrips("an empty value stays empty", "");
roundTrips("a URL-safe generated secret stays bare", "9tT4xQeFv2nH8sK1mR7wY5uC3zA6dB0pL-X_o");
check(
  "the common URL-safe path is written bare, unchanged",
  serializeEnvLine("PROBE_KEY", "9tT4xQeFv2nH8sK1mR7wY5uC3zA6dB0pL-X_o"),
  "PROBE_KEY=9tT4xQeFv2nH8sK1mR7wY5uC3zA6dB0pL-X_o",
);

// The bug this whole fix exists for: a bare value with a `# comment`-shaped tail would be
// read back truncated unless serializeEnvLine quotes it too.
roundTrips("a value with a ` #` sequence must survive, not be truncated at the next read", "18789  # my port");
check(
  "a value with a ` #` sequence is written quoted, not bare",
  serializeEnvLine("PROBE_KEY", "18789  # my port"),
  `PROBE_KEY='18789  # my port'`,
);
roundTrips("a quoted value with an embedded quote and a ` #` sequence", `it's # not a comment`);

// Values that cannot live on one line are refused with the key named, never written
// lossily: a real newline splits into two lines, and a \r is eaten by the reader's line
// trim as a CRLF terminator.
try {
  serializeEnvLine("PROBE_KEY", "first\nsecond");
  check("a value with a newline is refused", "did not throw", "threw");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  check("a value with a newline is refused", message.includes("PROBE_KEY") && message.includes("newline"), true);
}
try {
  serializeEnvLine("PROBE_KEY", "carriage\rreturn");
  check("a value with a carriage return is refused", "did not throw", "threw");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  check("a value with a carriage return is refused", message.includes("PROBE_KEY"), true);
}
try {
  serializeEnvLine("BAD-NAME", "x");
  check("an invalid variable name is refused", "did not throw", "threw");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  check("an invalid variable name is refused", message.includes("invalid environment variable name"), true);
}

// --- toSettings: required field --------------------------------------------------

try {
  toSettings({});
  check("toSettings without OC_DATA_DIR throws", "did not throw", "UserError: OC_DATA_DIR is not set in .env");
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  check("toSettings without OC_DATA_DIR throws", message, "UserError: OC_DATA_DIR is not set in .env");
}

// --- toSettings: OC_DATA_DIR must be a safe, already-normalized absolute path ------
//
// ensureDataDirs (runtime/files/datadir.ts) later resolves the canonical root on the target and
// changes ownership only for what it creates or a provenance marker vouches for, so a loose
// string here must never even reach that machinery: each of these is asserted to throw
// before any Context (and so any transport) exists.

function rejects(dataDir: string, label: string): void {
  try {
    toSettings({ OC_DATA_DIR: dataDir });
    check(`OC_DATA_DIR ${label} is rejected`, "did not throw", "threw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(`OC_DATA_DIR ${label} is rejected`, message.includes("OC_DATA_DIR"), true);
  }
}

rejects("/", '"/"');
rejects("/srv", '"/srv" (top-level, depth 1)');
rejects("/srv/data/", '"/srv/data/" (trailing slash, not normalized)');
rejects(".", '"." (not absolute)');
rejects("..", '".." (not absolute)');
rejects("relative/data", '"relative/data" (not absolute)');
rejects("/srv//data", '"/srv//data" (double slash, not normalized)');
rejects("/srv/data/..", '"/srv/data/.." (not normalized)');
rejects("/srv/./data", '"/srv/./data" (not normalized)');
rejects("C:\\srv\\openclaw/data", 'mixed Windows separators');
rejects("C:\\srv\\openclaw\\..\\data", 'Windows parent traversal');
rejects("C:\\srv\\openclaw\\data\\", 'Windows trailing separator');

check(
  "OC_DATA_DIR at depth 2 is accepted",
  toSettings({ OC_DATA_DIR: "/srv/data" }).dataDir,
  "/srv/data",
);

const windowsSettings = toSettings({ OC_DATA_DIR: "C:\\srv\\openclaw\\data" });
check("native Windows dataDir is accepted", windowsSettings.dataDir, "C:\\srv\\openclaw\\data");
check("native Windows backupDir is a sibling", windowsSettings.backupDir, "C:\\srv\\openclaw\\backups");
check("native Windows snapshotDir is a sibling", windowsSettings.snapshotDir, "C:\\srv\\openclaw\\snapshots");
check("native Windows lock directory is a sibling", locksDir(windowsSettings.dataDir), "C:\\srv\\openclaw\\data-locks");

for (const [name, value] of [
  ["OC_BACKUP_DIR", "/srv/data/../outside"],
  ["OC_BACKUP_DIR", "/srv//backups"],
  ["OC_BACKUP_DIR", "C:\\srv\\backups/mixed"],
  ["OC_SNAPSHOT_DIR", "/srv/./snapshots"],
  ["OC_SNAPSHOT_DIR", "/srv//snapshots"],
  ["OC_SNAPSHOT_DIR", "C:\\srv\\snapshots/"],
] as const) {
  try {
    toSettings({ OC_DATA_DIR: "/srv/app/data", [name]: value });
    check(`${name} unsafe path spelling is rejected`, "did not throw", "threw");
  } catch (error) {
    check(`${name} unsafe path spelling is rejected`, (error as Error).message.includes(name), true);
  }
}

// Depth is a backstop, not the safety property. A normal, valid-looking standard directory
// two segments deep passes on purpose — the safety comes from ensureDataDirs
// (runtime/files/datadir.ts), which resolves the canonical root through its ancestors and
// provenance-gates every ownership change on the real filesystem before any mkdir/chown.
check(
  "OC_DATA_DIR naming a standard two-segment system directory is accepted (handled safely at the filesystem layer)",
  toSettings({ OC_DATA_DIR: "/var/lib" }).dataDir,
  "/var/lib",
);

// --- toSettings: defaults ----------------------------------------------------------

const minimal = toSettings({ OC_DATA_DIR: "/srv/openclaw/data" });

check("dataDir is passed through", minimal.dataDir, "/srv/openclaw/data");
check("bindAddress defaults to 127.0.0.1", minimal.bindAddress, "127.0.0.1");
check("gatewayPort defaults to 18789", minimal.gatewayPort, "18789");
check("serviceUrl is built from the default bind address and port", minimal.serviceUrl, "http://127.0.0.1:18789");
check("backupDir defaults to a sibling of the data directory's parent", minimal.backupDir, "/srv/openclaw/backups");
check("snapshotDir defaults to a sibling of the data directory's parent", minimal.snapshotDir, "/srv/openclaw/snapshots");
check("image defaults", minimal.image, "ghcr.io/openclaw/openclaw:extended-stable");
// The default image is written in three more places: the compose file's three `image:` lines
// and .env.example. They must all name the one default the settings fall back to.
{
  const compose = await readFile(resolve(monorepoRoot, "packages", "clawwright", "docker-compose.yml"), "utf8");
  const composeDefaults = [...compose.matchAll(/\$\{OPENCLAW_IMAGE:-([^}]+)\}/g)].map((match) => match[1]);
  check("docker-compose.yml falls back to the default image at each of its three services", composeDefaults, Array(3).fill(minimal.image));
  const example = parseEnv(await readFile(resolve(monorepoRoot, "packages", "clawwright", ".env.example"), "utf8"));
  check(".env.example names the default image", example.OPENCLAW_IMAGE, minimal.image);
}
check("location defaults to auto", minimal.location, "auto");
check("wslDistro defaults", minimal.wslDistro, "Ubuntu-24.04");
check("sshHost defaults to empty", minimal.sshHost, "");
check("remotePath defaults", minimal.remotePath, "/opt/openclaw");
check("env is carried through unchanged", minimal.env, { OC_DATA_DIR: "/srv/openclaw/data" });

// --- toSettings: explicit values override every default ----------------------------

const full = toSettings({
  OC_DATA_DIR: "/srv/openclaw/data",
  OC_BIND_ADDRESS: "0.0.0.0",
  OPENCLAW_GATEWAY_PORT: "9999",
  OC_BACKUP_DIR: "/custom/backups",
  OC_SNAPSHOT_DIR: "/custom/snapshots",
  OPENCLAW_IMAGE: "example.com/openclaw:custom",
  OC_TARGET_LOCATION: "ssh",
  OC_WSL_DISTRO: "Debian",
  OC_SSH_HOST: "user@example.com",
  OC_REMOTE_PATH: "/home/user/openclaw",
});

check("bindAddress override", full.bindAddress, "0.0.0.0");
check("gatewayPort override", full.gatewayPort, "9999");
check("serviceUrl reflects the overridden address and port", full.serviceUrl, "http://0.0.0.0:9999");
check("backupDir override bypasses the derived default", full.backupDir, "/custom/backups");
check("snapshotDir override bypasses the derived default", full.snapshotDir, "/custom/snapshots");
check("image override", full.image, "example.com/openclaw:custom");
check("location override", full.location, "ssh");
check("wslDistro override", full.wslDistro, "Debian");
check("sshHost override", full.sshHost, "user@example.com");
check("remotePath override", full.remotePath, "/home/user/openclaw");

// --- shellOnlyEnvNames / shellOnlyEnvWarning: shell-exported OC_* the .env doesn't win ----
//
// Pure functions, no process.env or filesystem touched — shellEnv is injected, never the
// real one, so this check cannot leak or depend on whatever the runner's own shell exports.

check(
  "nothing exported in the shell produces no names",
  shellOnlyEnvNames({ OC_WSL_DISTRO: "Ubuntu-24.04" }, {}),
  [],
);

check(
  "a shell value equal to .env's is not flagged",
  shellOnlyEnvNames({ OC_WSL_DISTRO: "Ubuntu-24.04" }, { OC_WSL_DISTRO: "Ubuntu-24.04" }),
  [],
);

check(
  "a shell value differing from .env's is flagged by name",
  shellOnlyEnvNames({ OC_WSL_DISTRO: "Ubuntu-24.04" }, { OC_WSL_DISTRO: "Nope" }),
  ["OC_WSL_DISTRO"],
);

check(
  "a shell value present but absent from .env is flagged",
  shellOnlyEnvNames({}, { OC_SSH_HOST: "user@host" }),
  ["OC_SSH_HOST"],
);

check(
  "OC_APP is never flagged: it is meant to be read from the shell",
  shellOnlyEnvNames({}, { OC_APP: "myapp" }),
  [],
);

check(
  "OC_DEBUG is never flagged: it is meant to be read from the shell",
  shellOnlyEnvNames({}, { OC_DEBUG: "1" }),
  [],
);

check(
  "an unrelated shell variable is never flagged",
  shellOnlyEnvNames({}, { PATH: "/usr/bin", HOME: "/home/x" }),
  [],
);

check(
  "every var toSettings/watch/backup actually read from Env is in the list",
  [...ENV_FILE_ONLY_VARS].sort(),
  [
    "OC_BACKUP_DIR",
    "OC_BACKUP_KEEP",
    "OC_BIND_ADDRESS",
    "OC_COMPOSE_PROJECT",
    "OC_DATA_DIR",
    "OC_REMOTE_PATH",
    "OC_SNAPSHOT_DIR",
    "OC_SNAPSHOT_KEEP",
    "OC_SSH_HOST",
    "OC_TARGET_LOCATION",
    "OC_WATCH_DISK_MIN_MB",
    "OC_WATCH_HEARTBEAT_URL",
    "OC_WATCH_TELEGRAM_CHAT_ID",
    "OC_WATCH_WEBHOOK",
    "OC_WATCH_WEBHOOK_FORMAT",
    "OC_WSL_DISTRO",
    "OC_BACKUP_MAX_AGE",
    "OC_DISK_MIN_FREE_MB",
    "OC_AUDIT_BLOCK",
  ].sort(),
);

check(
  "no shell export -> no warning",
  shellOnlyEnvWarning({ OC_WSL_DISTRO: "Ubuntu-24.04" }, {}, "/deploy/.env"),
  undefined,
);

check(
  "matching shell export -> no warning",
  shellOnlyEnvWarning({ OC_WSL_DISTRO: "Ubuntu-24.04" }, { OC_WSL_DISTRO: "Ubuntu-24.04" }, "/deploy/.env"),
  undefined,
);

check(
  "one differing var -> singular wording naming the var and the .env path, value never printed",
  shellOnlyEnvWarning({ OC_WSL_DISTRO: "Ubuntu-24.04" }, { OC_WSL_DISTRO: "Nope" }, "/deploy/.env"),
  "warning: OC_WSL_DISTRO is set in the shell but ignored — this tool reads .env only (/deploy/.env); set it there",
);

check(
  "two differing vars -> one line, plural wording, both names listed",
  shellOnlyEnvWarning(
    { OC_WSL_DISTRO: "Ubuntu-24.04" },
    { OC_WSL_DISTRO: "Nope", OC_SSH_HOST: "user@host" },
    "/deploy/.env",
  ),
  "warning: OC_WSL_DISTRO, OC_SSH_HOST are set in the shell but ignored — " +
    "this tool reads .env only (/deploy/.env); set them there",
);

// --- parseDurationThreshold (OC_BACKUP_MAX_AGE) --------------------------------------------

check("unset falls back to the default", parseDurationThreshold("OC_BACKUP_MAX_AGE", undefined, 172_800_000, "2d"), 172_800_000);
check("Nd parses to days in ms", parseDurationThreshold("OC_BACKUP_MAX_AGE", "3d", 172_800_000, "2d"), 3 * 86_400_000);
check("Nh parses to hours in ms", parseDurationThreshold("OC_BACKUP_MAX_AGE", "36h", 172_800_000, "2d"), 36 * 3_600_000);
check("Nm parses to minutes in ms", parseDurationThreshold("OC_BACKUP_MAX_AGE", "90m", 172_800_000, "2d"), 90 * 60_000);
check("0 disables, no unit needed", parseDurationThreshold("OC_BACKUP_MAX_AGE", "0", 172_800_000, "2d"), 0);
check("off (any case) disables", parseDurationThreshold("OC_BACKUP_MAX_AGE", "OFF", 172_800_000, "2d"), 0);

{
  let output = "";
  const result = await withOutputSink(
    (line) => { output += line; },
    () => Promise.resolve(parseDurationThreshold("OC_BACKUP_MAX_AGE", "banana", 172_800_000, "2d")),
  );
  check("garbage value falls back to the default", result, 172_800_000);
  check("garbage value warns naming the variable and value", output.includes("OC_BACKUP_MAX_AGE") && output.includes("banana"), true);
}

{
  let output = "";
  await withOutputSink(
    (line) => { output += line; },
    () => Promise.resolve(parseDurationThreshold("OC_BACKUP_MAX_AGE", "0", 172_800_000, "2d")),
  );
  check("0 is reported, not silent", output.includes("OC_BACKUP_MAX_AGE=0") && output.includes("disabled"), true);
}

// --- parseDiskMinFreeMb (OC_DISK_MIN_FREE_MB) ----------------------------------------------

check("unset falls back to the default", parseDiskMinFreeMb("OC_DISK_MIN_FREE_MB", undefined, 1024), 1024);
check("a plain integer is used as-is", parseDiskMinFreeMb("OC_DISK_MIN_FREE_MB", "2048", 1024), 2048);
check("0 disables", parseDiskMinFreeMb("OC_DISK_MIN_FREE_MB", "0", 1024), 0);

{
  let output = "";
  const result = await withOutputSink(
    (line) => { output += line; },
    () => Promise.resolve(parseDiskMinFreeMb("OC_DISK_MIN_FREE_MB", "-5", 1024)),
  );
  check("a negative value falls back to the default", result, 1024);
  check("a negative value warns naming the variable and value", output.includes("OC_DISK_MIN_FREE_MB") && output.includes("-5"), true);
}

finish("env");
