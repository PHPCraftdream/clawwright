# Optional ssjack runtime

Clawwright can operate without ssjack. The integration is an optional runtime protocol dependency, not an npm dependency on a Go executable. A managed launch uses the keeper that supplied the temporary child context; it never discovers another ssjack executable on PATH, unlocks a vault, exports a key or installs a binary.

## Runtime compatibility

`runtime/transport/remote/ssjack-contract.ts` owns the requirements. The pinned HTTPS/MCP client checks the actual serving keeper for protocol 1, 16384-byte chunks, `exec`, `stdin`, `binary`, `backpressure`, `cancel` and `connection-only` cancellation. The keeper reports its source commit. A compatible protocol does not prove a binary's supply provenance, and a matching filename does not prove compatibility.

`OC_TARGET_LOCATION=auto` selects the keeper when a complete child context is supplied. Without any child context it keeps the existing platform defaults. `OC_TARGET_LOCATION=ssjack` explicitly requires a context. Explicit `local`, `wsl` and `ssh` stay standalone choices; they do not implicitly borrow the keeper. A partial, invalid, incompatible or disconnected context in auto/ssjack mode rejects rather than falling back to another transport. Real cross-project laboratory acceptance remains separate from these source-level and synthetic checks.

The agent must use the keeper's registered `app_exec` launch to obtain a fresh child context. Merely running Clawwright as a shell subprocess of an agent that has the primary ssjack MCP bridge does not claim the primary bootstrap or manufacture a child lease. Unrelated host subprocesses launched through `spawnLocal` have the child context removed from a copied environment, case-insensitively, even if an env override attempts to pass it; the parent environment remains available for other contexts within this finite operation. This scrubbing is not general gateway/provider-secret redaction: ssjack registers the child bootstrap token with the framework logger, not every secret the application or gateway may handle.

A scoped path bridge translates declared target/container mounts only. It refuses operator-to-target and target-to-operator filesystem mappings. Compose copies the operator package's definition into the existing owner-only per-call environment directory, uses that directory as its project directory, and removes it with the environment on success or failure. No corresponding checkout on the target is assumed. Missing private-file staging capability refuses before target preparation.

Scoped scheduling, port forwarding, nested stdio relay and second-hop deployment are refused at their owning boundaries before applying those routes. Recipe side-stack definition delivery is conservatively unsupported in this slice, including image-only side-stack definitions; it is not silently interpreted as a shared target file. Legacy transports retain their existing path and Compose behavior.

The finite executor pumps 16 KiB stdin frames and drains output concurrently. Only `accepted: false` permits retrying the identical encoded input; uncertain responses fail the scope, never replay it. Output DTOs and canonical base64 are validated before use. Captured output has an explicit 64 MiB combined bound and fails rather than overwriting unread bytes. A binary sink can replace capture; it is awaited before another frame is read, must honor the operation's AbortSignal, and owns its own destination/publication rules. Buffered command results decode UTF-8 only after reassembly, preserving a leading BOM. Public byte/environment contracts use `Uint8Array` and plain records so importing the application API does not require consumer-side Node type declarations. The transport preserves the existing distinction between terminal streaming and captured output.

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

Secrets handled by the wider application have separate lifecycle and backup boundaries: target-environment changes require a gateway restart to be read; repository `.env` values are fixed in the container environment at creation, so applying changed values requires container recreation (a plain restart retains the old environment). The `secrets.ts` comparison checks environment values but prints names only; it does not prove that a provider or gateway adopted or can use them. Full backups include secrets by default; `--with-secrets` explicitly selects the full profile. Migrate snapshots may have plaintext secret sidecars, separate from the archive. Treat these files and backups as sensitive.

## Launcher boundary

At keeper startup, an operator enrolls a trusted deployment directory and native Node entry, plus an optional fixed Incus container/user route. The current full `app_exec` is not a restricted declarative sandbox: its admitted exec/host operations and credential reporting can act generally, including exposing secrets, with the configured principal's privileges. `confirm=true` is caller acknowledgment, not proof of human approval. Each operation receives a fresh child capability; finish, timeout, cancellation or parent disconnect revokes it. This bounds the capability lifetime, not the authority of code using it. Registration trusts the application code and is not a filesystem sandbox: trusted application or recipe code, Docker/Incus admin sockets, `sudo` or an alternate shell can bypass restrictions in future narrower APIs. Non-admin operation is an operator-enrolled server policy, not something guaranteed by a role name or SSH key.

A future declarative MCP interface and universal encrypted secret store are plans, not current guarantees. The current transport slice stages the operator-side Compose definition rather than assume shared package paths. Unsupported second-hop deployment, recipe build inputs, persistent scheduling and stdio relays must refuse before mutation. Invalid supplied context must never trigger fallback to ordinary SSH.
