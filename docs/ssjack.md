# Optional ssjack runtime

Clawwright can operate without ssjack. The integration is an optional runtime protocol dependency, not an npm dependency on a Go executable. A managed launch uses the keeper that supplied the temporary child context; it never discovers another ssjack executable on PATH, unlocks a vault, exports a key or installs a binary.

## Runtime compatibility

`runtime/transport/remote/ssjack-contract.ts` owns the requirements. The pinned HTTPS/MCP client checks the actual serving keeper for protocol 1, 16384-byte chunks, `exec`, `stdin`, `binary`, `backpressure`, `cancel` and `connection-only` cancellation. The keeper reports its source commit. A compatible protocol does not prove a binary's supply provenance, and a matching filename does not prove compatibility.

Managed transport activation is separate from the client, finite executor and supply contract. Until the transport is wired into target selection, Context/path treatment, Compose staging and unsupported-route guards, shipping these modules alone does not enable remote Clawwright commands through ssjack.

The finite executor pumps 16 KiB stdin frames and drains output concurrently. Only `accepted: false` permits retrying the identical encoded input; uncertain responses fail the scope, never replay it. Output DTOs and canonical base64 are validated before use. Captured output has an explicit 64 MiB combined bound and fails rather than overwriting unread bytes. A binary sink can replace capture; it is awaited before another frame is read, must honor the operation's AbortSignal, and owns its own destination/publication rules. Buffered command results decode UTF-8 only after reassembly. The transport preserves the existing distinction between terminal streaming and captured output.

Finite deadlines and caller cancellation request `transport_cancel` once. Neither an acknowledgement nor closing the client confirms termination of a detached remote process. Stdio protocol relay and persistent client invocation explicitly refuse this temporary route. The new transport does not inherit from the external-SSH implementation.

## Binary supply pin

The framework package manifest declares this optional dependency in `ssjackRuntime`, separately from npm dependencies. Its `requirements` are checked against the client's shared runtime contract in CI. Its `supply` is an explicit preparation pin, currently for Linux amd64; it is not an installer or a claim that the same binary runs on Windows or macOS. Other platforms require their own reviewed pin, never substituting a similarly named artifact.

An operator preparing ssjack must pin a reviewed binary source explicitly. The supply record validated by `validateSsjackSupply` has these shared fields:

- `repository`: exactly `PHPCraftdream/ssjack`;
- `commit`: a full lowercase 40-character Git commit;
- `platform`: an explicit supported OS and architecture, never `auto`;
- `archiveSHA256`: the exact downloaded archive or release payload's digest;
- `executableSHA256`: the extracted executable's digest.

Before a suitable release, use `kind: "ci"` and exact numeric `runId`, `artifactId` and `artifactName`. Check the run's repository, source commit, successful conclusion, artifact identity and expiry before download. Verify the downloaded archive digest, inspect its member layout, and verify the extracted executable digest before execution. An artifact name, a branch, or the run's successful conclusion alone is insufficient. CI artifacts expire; an expired pin must fail preparation rather than discover a newer run.

After a suitable release, explicitly replace that record with `kind: "release"`, an exact `version` such as `v1.2.3` and `asset`. Check the release/tag source commit and both digests. For a raw executable asset the payload and executable digests are equal. Do not retain CI-only fields in a release record. Transport code and runtime protocol requirements do not change merely because the supply source changes.

There is no automatic download, installer, fallback to `latest`, tag creation or version bump in this contract. A running compatible keeper may come from an independently approved source; the supply pin describes preparation, not a demand to replace an authenticated keeper with another process.

## Persistence boundaries

The existing `config/deployment.lock.json` pins the remote OpenClaw instance composition. Its writer is `commands/management/lock.ts`; plan, inspect and set validation read it. An operator-side binary supply pin is not an image, recipe or model setting, so it does not belong in that lock or its declaration checksum.

A supply record contains no endpoint, bearer token, TLS session pin, password, private path or SSH credential. Unknown fields are refused. In particular, never copy `SSJACK_APP_ENDPOINT`, `SSJACK_APP_TOKEN` or `SSJACK_APP_CERTIFICATE_SHA256` into a deployment, package manifest, lock or archive. They identify one temporary operation, not a reusable dependency.

## Launcher boundary

At keeper startup the human registers a trusted deployment directory and native Node entry, plus an optional fixed Incus container/user route. The model can submit a finite Clawwright argument vector through `app_exec`, not replace those registration inputs. Each operation receives a fresh child capability; finish, timeout, cancellation or parent disconnect revokes it. Registration trusts the application code and is not a filesystem sandbox.

The first transport slice must stage the operator-side Compose definition rather than assume shared package paths. Unsupported second-hop deployment, recipe build inputs, persistent scheduling and stdio relays must refuse before mutation. Invalid supplied context must never trigger fallback to ordinary SSH.
