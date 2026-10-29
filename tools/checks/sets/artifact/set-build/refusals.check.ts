// `./clawwright set build` refusals: a desired-state.json that is not an operations list, a lock
// for another image, an unreadable secret source, and a failed rebuild that must not destroy the
// artifact already there.

import { mkdir, mkdtemp, readdir, writeFile, rm, rmdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { buildSet, withTarRunner } from "#framework/commands/sets/set.ts";
import type { ExecOptions, ExecResult } from "#framework/runtime/transport/transport.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";
import { ctx, DIGEST, STORE_KEY, TOKEN, populateBuildDeployment, removeBuildDeployment, tarList } from "#checks/sets/artifact/set-build/fixture.ts";

const deployment = await mkdtemp(join(tmpdir(), "clawwright-set-build-check-"));
await populateBuildDeployment(deployment);

try {
  // --- a desired-state.json that is syntactically valid JSON but not a list of {path,value}
  // operations must refuse, not build silently -------------------------------------------------
  //
  // desired-state.json remains an operations declaration; apply-config compiles it to a
  // JSON Merge Patch before transport. This check validates declaration shape, not CLI syntax.
  // An object like {"gateway":{"mode":"local"}} is not a path/value operations list.
  {
    const desiredStatePath = resolve(deployment, "config", "desired-state.json");
    const validDesiredState = await readFile(desiredStatePath, "utf8");
    await writeFile(desiredStatePath, JSON.stringify({ gateway: { mode: "local" } }));
    try {
      let refused = "";
      try {
        await buildSet(ctx, "demo-set");
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      check("set build refuses a desired-state.json that is an object, not an operations list", refused !== "", true);
      check("the refusal names desired-state.json", refused.includes("desired-state.json"), true);
    } finally {
      await writeFile(desiredStatePath, validDesiredState);
    }
  }

  // --- the lock's digest is used only when the lock is about this image ----------------------
  //
  // requiredImage used to return the lock's digest without asking whether the lock was
  // written for the reference now declared: after OPENCLAW_IMAGE moved to another repository
  // or tag, a stale lock still answered, and the set was pinned to the previous image's
  // digest — the artifact named a runtime the operator's declaration does not, and `set try`
  // installs from the manifest. What a tag means cannot be checked offline, so the reference
  // itself is the comparison: only the identical string lets a recorded digest answer.
  {
    const lockPath = resolve(deployment, "config", "deployment.lock.json");
    const originalLock = await readFile(lockPath, "utf8");
    const writeLock = async (reference: string, digest: string): Promise<void> => {
      await writeFile(
        lockPath,
        JSON.stringify({
          version: 1,
          deployment: "set-build-check",
          generatedAt: "2026-01-01T00:00:00.000Z",
          image: { reference, digest },
          recipes: {},
          secrets: [],
        }),
      );
    };
    const buildRefusal = async (): Promise<string> => {
      try {
        await buildSet(ctx, "demo-set");
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const declared = "ghcr.io/openclaw/openclaw:extended-stable";
    try {
      const otherRepo = "old.example/old-image:stable";
      await writeLock(otherRepo, `old.example/old-image@sha256:${"a".repeat(64)}`);
      let refusal = await buildRefusal();
      check(
        "a lock for another repository does not answer for the declared image",
        refusal.includes(otherRepo) && refusal.includes(declared),
        true,
      );
      check("that refusal names the safe remedies for a deployed instance", refusal.includes("./clawwright upgrade --image") && refusal.includes("`lock`") && !refusal.includes("bootstrap"), true);
      const otherTag = "ghcr.io/openclaw/openclaw:older-stable";
      await writeLock(otherTag, `ghcr.io/openclaw/openclaw@sha256:${"b".repeat(64)}`);
      refusal = await buildRefusal();
      check("a lock for another tag of the same repository is refused too", refusal.includes(otherTag) && refusal.includes(declared), true);
      // The chosen rule, stated by this case: a digest reference in the lock is the same
      // repository but not the declared tag, and no offline check can tell what the tag
      // means — so the recorded digest is not taken on faith either.
      const digestRef = `ghcr.io/openclaw/openclaw@sha256:${"c".repeat(64)}`;
      await writeLock(digestRef, digestRef);
      refusal = await buildRefusal();
      check("a lock whose reference is a digest does not answer for a tag of that repository", refusal.includes(digestRef) && refusal.includes(declared), true);
    } finally {
      await writeFile(lockPath, originalLock);
    }

    // The legitimate case, re-asserted in place: the declared tag IS the lock's reference,
    // and its recorded digest pins even though the tag may have moved since — exactly what
    // the lock exists to record.
    await writeLock(declared, DIGEST);
    try {
      check("the lock's digest still pins when the lock names the declared reference", (await buildSet(ctx, "demo-set")).manifest.requires.image, DIGEST);
    } finally {
      await writeFile(lockPath, originalLock);
    }

    // An OPENCLAW_IMAGE that is already a digest reference is pinned by hand and never
    // reaches the lock: even with no lock file at all it pins, exactly as given.
    const handPinned = `ghcr.io/openclaw/openclaw@sha256:${"d".repeat(64)}`;
    const digestCtx = { ...ctx, settings: { ...ctx.settings, image: handPinned } } as unknown as Context;
    await rm(lockPath);
    try {
      check("a @sha256 OPENCLAW_IMAGE pins as given, without consulting the lock", (await buildSet(digestCtx, "digest-set")).manifest.requires.image, handPinned);
    } finally {
      await writeFile(lockPath, originalLock);
    }

    // No lock at all keeps the existing refusal: a tag with nothing proven to pin it to.
    // Both states reach it — never bootstrapped, or bootstrapped with the tag still
    // unpinned — so the advice names the remedy for each instead of assuming one.
    await rm(lockPath);
    try {
      const none = await buildRefusal();
      check("no lock at all keeps the no-digest refusal", none.includes("no image digest to pin the set to") && none.includes(declared), true);
      check("its advice covers both states: bootstrap before the first, lock on a running instance", none.includes("./clawwright bootstrap") && none.includes("`lock`"), true);
    } finally {
      await writeFile(lockPath, originalLock);
    }

    // A committed lock that names the declared tag but carries no digest (a pre-pinning
    // lock, or one written where the tag was never pulled): the pull paths — bootstrap
    // before the first deployment, upgrade --image on a deployed instance — are named, not
    // a bare `lock` that would record no digest all over again.
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      deployment: "set-build-check",
      generatedAt: "2026-01-01T00:00:00.000Z",
      image: { reference: declared },
      recipes: {},
      secrets: [],
    }));
    try {
      const digestless = await buildRefusal();
      check("a digestless lock for the declared tag still refuses", digestless.includes("no image digest to pin the set to"), true);
      check("its advice names both pull paths, then lock", digestless.includes(`./clawwright upgrade --image ${declared}`) && digestless.includes("`bootstrap`") && digestless.includes("`lock`"), true);
    } finally {
      await writeFile(lockPath, originalLock);
    }
  }

  // --- an unreadable secret source aborts the build instead of shrinking the scan ------------
  //
  // localSecretValues used to treat every read error as "no store yet": with a directory
  // sitting where .env belongs, the scan quietly ran over an empty list and the build still
  // reported success. Only a missing source is tolerable — anything else must name the
  // source and stop, so no artifact is written whose value scan was silently incomplete.
  {
    const envPath = resolve(deployment, ".env");
    const originalEnv = await readFile(envPath, "utf8");
    await rm(envPath);
    await mkdir(envPath);
    try {
      let refusal = "";
      try {
        await buildSet(ctx, "demo-set");
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      check("set build refuses when the .env secret source cannot be read", refusal.includes(".env"), true);
      check("the refusal names the source, never a stored value", refusal.includes(TOKEN), false);
    } finally {
      await rmdir(envPath);
      await writeFile(envPath, originalEnv);
    }
  }
  {
    const storePath = resolve(deployment, "secrets", "prod.env");
    const originalStore = await readFile(storePath, "utf8");
    await rm(storePath);
    await mkdir(storePath);
    try {
      let refusal = "";
      try {
        await buildSet(ctx, "demo-set");
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      check("set build refuses when a secret store cannot be read", refusal.includes("prod.env"), true);
      check("the store refusal names no value either", refusal.includes(STORE_KEY), false);
    } finally {
      await rmdir(storePath);
      await writeFile(storePath, originalStore);
    }
  }

  // --- a failed rebuild must not destroy the artifact already there -------------------------
  //
  // writeArtifact used to point tar straight at sets/<name>-<id>.tar.gz. Two builds of
  // unchanged content land on the same path, so a rebuild truncated the completed artifact
  // before tar had produced anything, and the --force-local fallback was a second write to
  // that same path. The substitute below is tar as the reviewer saw it: it writes a few
  // partial bytes to whatever -f names, then fails; the unflagged fallback fails the same
  // way, which is what a real spawnLocal does with a failing tar.
  {
    const setsDir = resolve(deployment, "sets");
    // The artifact already at that path: an unchanged tree rebuilds to the same name.
    const existing = await buildSet(ctx, "demo-set");
    const before = await readFile(existing.artifact);
    const targets: string[] = [];
    const MID_WRITE = "simulated failure mid-write";
    let attempts = 0;
    const partialThenFail = async (_command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
      attempts += 1;
      // tar is invoked with the combined short flag -czf; the archive path follows it.
      const target = args[args.indexOf("-czf") + 1]!;
      if (target === undefined || target.startsWith("-")) {
        throw new Error(`substitute found no archive path in: tar ${args.join(" ")}`);
      }
      targets.push(target);
      await writeFile(target, "a truncated archive, not a real one\n");
      if (options?.allowFailure === true) return { code: 1, stdout: "", stderr: `tar: ${MID_WRITE}\n` };
      throw new Error(`tar: ${MID_WRITE}`);
    };
    let refusal = "";
    try {
      await withTarRunner(partialThenFail, () => buildSet(ctx, "demo-set"));
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    check("a failed rebuild refuses instead of reporting success", refusal !== "", true);
    // The retry without --force-local exists only for the tar that rejects the flag; a
    // failure with any other cause is reported as the first attempt saw it.
    check("a failure that is not the flag makes one tar attempt", attempts, 1);
    check("that failure names the first attempt's cause", refusal.includes(MID_WRITE), true);
    check("the failed rebuild leaves the previous artifact byte-for-byte unchanged", (await readFile(existing.artifact)).equals(before), true);
    let stillListable = false;
    try {
      stillListable = (await tarList(existing.artifact)).includes("set.json");
    } catch {
      // A corrupt archive must be caught here, not fatal to the checks: proving the
      // artifact cannot be listed is part of what failure looks like.
      stillListable = false;
    }
    check("the surviving artifact still lists as a real archive", stillListable, true);

    // The one failure the retry exists for: bsdtar refusing the flag itself gets the
    // unflagged second attempt.
    let flagged = 0;
    const flagRejectedThenWrite = async (_command: string, args: string[], _options?: ExecOptions): Promise<ExecResult> => {
      flagged += 1;
      if (flagged === 1) {
        return { code: 1, stdout: "", stderr: "tar: Option --force-local is not supported\n" };
      }
      const target = args[args.indexOf("-czf") + 1]!;
      await writeFile(target, "a complete archive written by the retry\n");
      return { code: 0, stdout: "", stderr: "" };
    };
    let retryRefusal = "";
    try {
      await withTarRunner(flagRejectedThenWrite, () => buildSet(ctx, "demo-set"));
    } catch (error) {
      retryRefusal = error instanceof Error ? error.message : String(error);
    }
    // Only a Windows host passes --force-local, so only it has a flag to drop on the retry.
    await requires("windows-host", "only a windows host passes --force-local to tar", async () => {
      check("a flag rejection retries without the flag", [flagged, retryRefusal], [2, ""]);
      check("the retry publishes its archive", (await readdir(setsDir)).some((entry) => entry.startsWith("demo-set-")), true);
    });
    await requires("posix-host", "a posix host passes no flag, so a rejected option is the cause and is not retried", () => {
      check("a rejected option on a posix host makes one attempt and is reported", [flagged, retryRefusal.includes("--force-local")], [1, true]);
    });
    check(
      "neither tar attempt writes the final artifact name",
      targets.every((target) => target !== existing.artifact),
      true,
    );
    check(
      "every attempt writes inside sets/, so publishing stays one rename",
      targets.every((target) => {
        const pathFromSets = relative(resolve(setsDir), resolve(target));
        return pathFromSets !== ".." && !pathFromSets.startsWith(`..${sep}`) && !isAbsolute(pathFromSets);
      }),
      true,
    );
    check(
      "the failed rebuild leaves no temporary file behind",
      (await readdir(setsDir)).filter((entry) => !entry.endsWith(".tar.gz")),
      [],
    );

    let firstBuildRefusal = "";
    try {
      await withTarRunner(partialThenFail, () => buildSet(ctx, "fresh-set"));
    } catch (error) {
      firstBuildRefusal = error instanceof Error ? error.message : String(error);
    }
    check("a first build that fails refuses too", firstBuildRefusal !== "", true);
    check(
      "a failed first build leaves nothing at the final path",
      (await readdir(setsDir)).filter((entry) => entry.startsWith("fresh-set-")),
      [],
    );

    // The default path runs the real tar end to end: the same command line as ever, and the
    // completed archive renamed over the artifact that is already there.
    const rebuilt = await buildSet(ctx, "demo-set");
    check("a real rebuild still lands a complete archive", (await tarList(rebuilt.artifact)).includes("set.json"), true);
    check(
      "the real rebuild leaves only archives in sets/",
      (await readdir(setsDir)).filter((entry) => !entry.endsWith(".tar.gz")),
      [],
    );
  }
} finally {
  await removeBuildDeployment(deployment);
}
finish("set build refusals");
