// The portable content model (stage 7, S3.2): ONE inventory walk per source, the
// declaration read once, content validation over the model. Evidence: a real set tree (kit
// fixture, real writers) and the real artifact built from it must reach validation through
// the same builder and answer with the same findings — a set whose recipes include the
// historical name `aux` (I14 compat) must still load and validate identically on both paths,
// and the declaration findings must stay the historic full texts on both paths.

import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadSet, validateLoadedSet } from "#framework/set/load.ts";
import { EnvSyntaxError } from "#framework/core/env.ts";
import { buildSet } from "#framework/commands/sets/set.ts";
import { DESIRED_STATE_PATH } from "#framework/set/artifacts/model.ts";
import { checksumOf, checksumOfFileMap } from "#framework/service/checksums.ts";
import { ctx as buildCtx, populateBuildDeployment, removeBuildDeployment } from "#checks/sets/artifact/set-build/fixture.ts";
import { packArtifact } from "#checks/sets/pack.ts";
import { withArtifactInspected } from "#framework/set/artifacts/install.ts";
import { collectPortableContent, portableContent } from "#framework/set/content.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { validateSet } from "#framework/set/ownership/validate.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";

const digest = (problems: readonly { code: string; detail: string }[]): string =>
  JSON.stringify(problems.map((entry) => [entry.code, entry.detail]));
const codesOf = (problems: readonly { code: string }[]): string[] => problems.map((entry) => entry.code).sort();

{
  const deployment = await mkdtemp(join(tmpdir(), "clawwright-set-build-check-"));
  await populateBuildDeployment(deployment);
  try {
    // A recipe named `aux` — a Windows device name a read must still accept (I14) — beside
    // the fixture's demo recipe, carrying the same file classes.
    await mkdir(resolve(deployment, "recipes", "aux"), { recursive: true });
    await writeFile(resolve(deployment, "recipes", "aux", "recipe.json"), JSON.stringify({ description: "legacy-named service" }));
    await writeFile(resolve(deployment, "recipes", "aux", "compose.yml"), "services: {}\n");

    const built = await buildSet(buildCtx, "demo-set");

    const tree = await loadSet({ kind: "tree" }, { name: "demo-set", declaredImage: buildCtx.settings.image });
    const artifact = await loadSet({ kind: "artifact", path: built.artifact });
    try {
      // ONE inventory walk, and it carries exactly the manifest's files — the declaration is
      // IN the inventory now, read once by the same builder.
      const carried = new Set(tree.content.inventory.map((file) => file.path));
      const expected = [
        "config/desired-state.json",
        "recipes/aux/compose.yml",
        "recipes/aux/recipe.json",
        "recipes/demo/acceptance.json",
        "recipes/demo/agent/AGENTS.md",
        "recipes/demo/agent/config.json",
        "recipes/demo/compose.yml",
        "recipes/demo/data/page.md",
        "recipes/demo/recipe.json",
        "recipes/demo/server.ts",
        "recipes/plain/compose.yml",
        "recipes/plain/recipe.json",
      ];
      check("the tree inventory carries the independent literal path list", [...carried].sort(), expected);
      check("the artifact's inventory answers the same over the unpacked staging",
        artifact.content.inventory.map((file) => file.path).sort(), tree.content.inventory.map((file) => file.path).sort());
      check("both models carry the same declaration bytes", artifact.content.declaration.raw, tree.content.declaration.raw);

      // Same findings over the same content, both paths through the model.
      const treeFindings = await validateLoadedSet(tree);
      const artifactFindings = await validateLoadedSet(artifact);
      check("a coherent tree and its artifact validate to the same findings — none", [digest(treeFindings), digest(artifactFindings)], [digest([]), digest([])]);
      check("the historical recipe name aux rides both paths",
        [tree.manifest.recipes.aux !== undefined, artifact.manifest.recipes.aux !== undefined], [true, true]);

      // The PRE-CHANGE artifact shape: packArtifact (#checks/sets/pack.ts) is the test
      // assembler S3.2 left unchanged — the writer already-written artifacts came from.
      // Packing the healthy manifest and loading it strictly proves a pre-change artifact
      // carrying the historical `aux` recipe still loads and validates.
      const preChangeArtifact = resolve(deployment, "pre-change.tar.gz");
      await packArtifact(deployment, tree.manifest, preChangeArtifact);
      const preChange = await loadSet({ kind: "artifact", path: preChangeArtifact });
      try {
        check("a pre-change artifact carrying aux loads strictly", preChange.id.length, 64);
        check("the pre-change artifact lists the aux recipe", preChange.manifest.recipes.aux !== undefined, true);
        check("the pre-change artifact validates silent", codesOf(await validateLoadedSet(preChange)), []);
      } finally {
        if (preChange.staging !== undefined) await rm(preChange.staging, { recursive: true, force: true });
      }
    } finally {
      if (artifact.staging !== undefined) await rm(artifact.staging, { recursive: true, force: true });
    }

    // A broken tree: the finding is asserted literally, and the artifact built from the
    // same tree answers with identical findings over the model (body-finding parity).
    await rm(resolve(deployment, "recipes", "demo", "server.ts"));
    const broken = await buildSet(buildCtx, "demo-set");
    const brokenTree = await loadSet({ kind: "tree" }, { name: "demo-set", declaredImage: buildCtx.settings.image });
    const brokenArtifact = await loadSet({ kind: "artifact", path: broken.artifact });
    try {
      const findings = await validateLoadedSet(brokenTree);
      const fromArtifact = await validateLoadedSet(brokenArtifact);
      check("a missing server.ts is a SET_RECIPE_INCOMPLETE finding naming the recipe",
        findings.some((entry) => entry.code === "SET_RECIPE_INCOMPLETE" && entry.detail.includes("demo")), true);
      check("the artifact answers with the identical findings over the same content", digest(fromArtifact), digest(findings));
    } finally {
      if (brokenArtifact.staging !== undefined) await rm(brokenArtifact.staging, { recursive: true, force: true });
    }

    // An artifact whose bytes are self-consistent but whose recipe.json the policy rejects:
    // the manifest is the post-break one (no server.ts) with the bad recipe.json checksum
    // patched in, the validator reports the content finding, and the staging is cleaned up on every path.
    await writeFile(resolve(deployment, "recipes", "demo", "recipe.json"), "{not json");
    const badChecksum = checksumOf(Buffer.from("{not json"));
    const files = { ...broken.manifest.files, "recipes/demo/recipe.json": badChecksum };
    const demo = broken.manifest.recipes.demo!;
    const demoFiles = { ...demo.files, "recipe.json": badChecksum };
    const patched = {
      ...broken.manifest,
      files,
      recipes: { ...broken.manifest.recipes, demo: { ...demo, files: demoFiles, checksum: checksumOfFileMap(demoFiles) } },
    };
    const badArtifact = resolve(deployment, "bad-recipe-json.tar.gz");
    await packArtifact(deployment, patched, badArtifact);
    let capturedStaging = "";
    await withArtifactInspected(badArtifact, async (staging, _verified, problems) => {
      capturedStaging = staging;
      check("an artifact carrying an invalid recipe.json is a content finding with full filename",
        problems.find((entry) => entry.code === "SET_RECIPE_INVALID")?.detail.includes("recipes/demo/recipe.json"), true);
    });
    const gone = await access(capturedStaging).then(() => false, () => true);
    check("inspection removes staging after content findings", gone, true);
    const sentinel = new Error("inspection callback sentinel");
    let thrownStaging = "";
    let caught: unknown;
    try {
      await withArtifactInspected(badArtifact, async (staging) => {
        thrownStaging = staging;
        throw sentinel;
      });
    } catch (error) {
      caught = error;
    }
    check("inspection propagates the callback error unchanged", caught, sentinel);
    check("inspection removes staging after callback failure", await access(thrownStaging).then(() => false, () => true), true);
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// --- the declaration findings are the historic full texts, on both paths -------------------
//
// These texts predate the model; a wording drift silently breaks every script that greps
// validate output. Each expected string is built check-side (the check performs its own
// failing readFile/JSON.parse to capture the node-side message) — never from a #framework
// symbol — and stays in a const so the harness sees an identifier, not a literal.
{
  const deployment = await mkdtemp(join(tmpdir(), "clawwright-set-build-check-"));
  await populateBuildDeployment(deployment);
  try {
    const healthy = (await loadSet({ kind: "tree" }, { name: "demo-set", declaredImage: buildCtx.settings.image })).manifest;
    const invalidJson = '[{"path":"gateway.mode","value":"loc';
    const shapeBytes = JSON.stringify({ gateway: { mode: "local" } });
    const missingOrEmptyTail = " is missing or empty — a set without its config declaration would install an unconfigured instance";
    const shapeTail = ": must be an array of { path, value } operations — got a single object instead of a list";
    const shapeExpected = (label: string): string => `${label} is not a valid desired-state declaration${shapeTail}`;

    // Tree side: each case gets a fresh deployment. loadSet runs with
    // reportInvalidDeclaration, so the loader reports instead of dying; the walk over the
    // recipes is unaffected.
    const treeCase = async (checkName: string, mutate: (deployment: string, label: string) => Promise<string>): Promise<void> => {
      const caseDeployment = await mkdtemp(join(tmpdir(), "clawwright-set-build-check-"));
      await populateBuildDeployment(caseDeployment);
      try {
        const label = resolve(caseDeployment, "config", "desired-state.json");
        const tail = await mutate(caseDeployment, label);
        const loaded = await loadSet({ kind: "tree" }, {
          name: "demo-set",
          declaredImage: buildCtx.settings.image,
          tolerateUnpinnedImage: true,
          reportInvalidDeclaration: true,
        });
        const problems = await validateLoadedSet(loaded);
        const expected = tail === shapeTail ? `${label}${tail}` : `${label}${tail}`;
        check(checkName, problems[0]?.detail, expected);
      } finally {
        await removeBuildDeployment(caseDeployment);
        useDeployment(deployment);
      }
    };

    await treeCase("the tree's missing-declaration finding is the full historic text", async (dir) => {
      await rm(resolve(dir, "config", "desired-state.json"));
      return missingOrEmptyTail;
    });
    await treeCase("the tree's empty-declaration finding is the full historic text", async (dir) => {
      await writeFile(resolve(dir, "config", "desired-state.json"), "");
      return missingOrEmptyTail;
    });
    await treeCase("the tree's unreadable-declaration finding is the full historic text", async (dir, label) => {
      await rm(resolve(dir, "config", "desired-state.json"));
      await mkdir(resolve(dir, "config", "desired-state.json"));
      let nodeError = new Error("not thrown");
      try {
        await readFile(label, "utf8");
      } catch (error) {
        nodeError = error as Error;
      }
      return ` could not be read: ${nodeError.message}`;
    });
    await treeCase("the tree's unparsable-declaration finding is the full historic text", async (dir) => {
      await writeFile(resolve(dir, "config", "desired-state.json"), invalidJson);
      let jsonError = new Error("not thrown");
      try {
        JSON.parse(invalidJson);
      } catch (error) {
        jsonError = error as Error;
      }
      return ` is not valid JSON: ${jsonError.message}`;
    });
    await treeCase("the tree's wrong-shape-declaration finding is the full historic text", async (dir) => {
      await writeFile(resolve(dir, "config", "desired-state.json"), shapeBytes);
      return shapeTail;
    });

    const refusalDeployment = await mkdtemp(join(tmpdir(), "clawwright-set-build-check-"));
    await populateBuildDeployment(refusalDeployment);
    try {
      await rm(resolve(refusalDeployment, "recipes"), { recursive: true });
      await writeFile(resolve(refusalDeployment, "recipes"), "not a directory");
      await writeFile(resolve(refusalDeployment, "config", "desired-state.json"), "{}");
      let refusal = "";
      try {
        await buildSet(buildCtx, "demo-set");
      } catch (error) {
        refusal = (error as Error).message;
      }
      check("declaration refusal precedes recipe enumeration", refusal, shapeExpected(resolve(refusalDeployment, "config", "desired-state.json")));
    } finally {
      await removeBuildDeployment(refusalDeployment);
      useDeployment(deployment);
    }

    const recipeRefusalCase = async (checkName: string, mutate: (dir: string) => Promise<void>, expectedRefusal: (dir: string) => Promise<string>): Promise<void> => {
      const caseDeployment = await mkdtemp(join(tmpdir(), "clawwright-set-build-check-"));
      await populateBuildDeployment(caseDeployment);
      try {
        await mutate(caseDeployment);
        const expected = await expectedRefusal(caseDeployment);
        let refusal = "";
        try {
          await buildSet(buildCtx, "demo-set");
        } catch (error) {
          refusal = (error as Error).message;
        }
        check(checkName, refusal, expected);
        const loaded = await loadSet({ kind: "tree" }, {
          name: "demo-set", declaredImage: buildCtx.settings.image, tolerateUnpinnedImage: true, reportInvalidDeclaration: true,
        });
        const problem = (await validateLoadedSet(loaded)).find((entry) => entry.code === "SET_RECIPE_INVALID");
        check(`${checkName}: validation carries same detail`, problem?.detail, expected);
      } finally {
        await removeBuildDeployment(caseDeployment);
        useDeployment(deployment);
      }
    };

    for (const rel of ["acceptance.json", "agent/config.json"] as const) {
      await recipeRefusalCase(`directory ${rel} fails closed with exact read error`, async (dir) => {
        const file = resolve(dir, "recipes", "demo", ...rel.split("/"));
        await rm(file);
        await mkdir(file);
      }, async (dir) => {
        let nodeError = new Error("not thrown");
        try { await readFile(resolve(dir, "recipes", "demo", ...rel.split("/"))); } catch (error) { nodeError = error as Error; }
        return `recipe "demo": recipes/demo/${rel} could not be read: ${nodeError.message}`;
      });
    }

    // A required JSON path carried as a symlink/junction to a DIRECTORY must fail closed
    // exactly like the direct-directory cases above — carried under its own name, refused
    // at the read. Junction is the Windows fallback (no privilege needed); if neither link
    // kind can be created, fail loudly rather than skipping silently.
    for (const rel of ["acceptance.json", "agent/config.json"] as const) {
      await recipeRefusalCase(`symlinked directory ${rel} fails closed with exact read error`, async (dir) => {
        const file = resolve(dir, "recipes", "demo", ...rel.split("/"));
        await rm(file);
        const holding = resolve(dir, "recipes", "demo", "holding");
        await mkdir(holding);
        let linked = false;
        try {
          await symlink(holding, file, "dir");
          linked = true;
        } catch {
          try {
            await symlink(holding, file, "junction");
            linked = true;
          } catch { /* neither link kind available on this host */ }
        }
        check("required-file symlink could not be created on this host", linked ? "created" : "not created", "created");
      }, async (dir) => {
        let nodeError = new Error("not thrown");
        try { await readFile(resolve(dir, "recipes", "demo", ...rel.split("/"))); } catch (error) { nodeError = error as Error; }
        return `recipe "demo": recipes/demo/${rel} could not be read: ${nodeError.message}`;
      });
    }

    // Recipe parse refusal precedes the plain recipe's bad privateFiles policy.
    await recipeRefusalCase("malformed demo acceptance precedes plain recipe policy failure", async (dir) => {
      await rm(resolve(dir, "recipes"), { recursive: true });
      await mkdir(resolve(dir, "recipes", "demo"), { recursive: true });
      await mkdir(resolve(dir, "recipes", "plain"), { recursive: true });
      await writeFile(resolve(dir, "recipes", "demo", "acceptance.json"), "{bad");
      await writeFile(resolve(dir, "recipes", "plain", "recipe.json"), JSON.stringify({ description: "plain", privateFiles: 42 }));
    }, async () => {
      let jsonError = new Error("not thrown");
      try { JSON.parse("{bad"); } catch (error) { jsonError = error as Error; }
      return `recipe "demo": recipes/demo/acceptance.json is not valid JSON: ${jsonError.message}`;
    });
    // Competing failures in ONE recipe: a malformed acceptance.json beside a malformed
    // agent/config.json whose agentId is literally "acceptance.json" — the agent
    // diagnostic's prose contains "acceptance.json", the old substring selection's trigger;
    // the historical acceptance-before-agent refusal order must hold anyway.
    {
      const caseDeployment = await mkdtemp(join(tmpdir(), "clawwright-set-build-check-"));
      await populateBuildDeployment(caseDeployment);
      try {
        await rm(resolve(caseDeployment, "recipes"), { recursive: true });
        await mkdir(resolve(caseDeployment, "recipes", "demo"), { recursive: true });
        await writeFile(resolve(caseDeployment, "recipes", "demo", "acceptance.json"), "{bad");
        await mkdir(resolve(caseDeployment, "recipes", "demo", "agent"));
        await writeFile(resolve(caseDeployment, "recipes", "demo", "agent", "config.json"), JSON.stringify({ agentId: "acceptance.json", mcpServerName: "mcp" }));
        let jsonError = new Error("not thrown");
        try { JSON.parse("{bad"); } catch (error) { jsonError = error as Error; }
        const expected = `recipe "demo": recipes/demo/acceptance.json is not valid JSON: ${jsonError.message}`;
        let refusal = "";
        try {
          await buildSet(buildCtx, "demo-set");
        } catch (error) {
          refusal = (error as Error).message;
        }
        check("recipe with competing acceptance and agent failures refuses with the acceptance error before the agent diagnostic", refusal, expected);
        const loaded = await loadSet({ kind: "tree" }, {
          name: "demo-set", declaredImage: buildCtx.settings.image, tolerateUnpinnedImage: true, reportInvalidDeclaration: true,
        });
        const details = (await validateLoadedSet(loaded)).filter((entry) => entry.code === "SET_RECIPE_INVALID").map((entry) => entry.detail);
        check("recipe with competing acceptance and agent failures: validation reports both diagnostics", details.length, 2);
        check("recipe with competing acceptance and agent failures: validation carries the acceptance detail", details.filter((detail) => detail === expected).length, 1);
      } finally {
        await removeBuildDeployment(caseDeployment);
        useDeployment(deployment);
      }
    }
    // This fail-closed diagnostic is now explicit; the previous readOrAbsent behavior
    // swallowed source I/O failures instead of reporting the underlying read error.
    const sourceFailureCase = async (checkName: string, directory: boolean): Promise<void> => {
      const artifact = resolve(deployment, "source-failure.tar.gz");
      await packArtifact(deployment, healthy, artifact);
      const loaded = await loadSet({ kind: "artifact", path: artifact });
      try {
        const stagingDeclarationPath = join(loaded.staging!, "config", "desired-state.json");
        await rm(stagingDeclarationPath, { recursive: true, force: true });
        if (directory) await mkdir(stagingDeclarationPath);
        const base = await collectPortableContent({
          recipeRoot: join(loaded.staging!, "recipes"),
          declarationPath: stagingDeclarationPath,
          recipes: Object.keys(loaded.manifest.recipes),
        });
        const problems = await validateSet(portableContent(base, loaded.manifest), { checkFiles: true });
        let nodeError = new Error("not thrown");
        try {
          await readFile(stagingDeclarationPath, "utf8");
        } catch (error) {
          nodeError = error as Error;
        }
        const expected = `${stagingDeclarationPath}${directory ? ` could not be read: ${nodeError.message}` : missingOrEmptyTail}`;
        check(checkName, problems[0]?.detail, expected);
      } finally {
        if (loaded.staging !== undefined) await rm(loaded.staging, { recursive: true, force: true });
      }
    };
    await sourceFailureCase("missing declaration after integrity has full historic text", false);
    await sourceFailureCase("directory declaration after integrity has full historic read error", true);

    // The recipe root in an unpacked artifact is staging/recipes, not staging itself.
    const postIntegrity = resolve(deployment, "post-integrity.tar.gz");
    await packArtifact(deployment, healthy, postIntegrity);
    const integrityLoaded = await loadSet({ kind: "artifact", path: postIntegrity });
    try {
      const declarationPath = join(integrityLoaded.staging!, "config", "desired-state.json");
      await writeFile(declarationPath, "{}");
      const actualDeclaration = Buffer.from("{}");
      const patchedFiles = { ...healthy.files, [DESIRED_STATE_PATH]: checksumOf(actualDeclaration) };
      const manifest = { ...healthy, files: patchedFiles };
      const base = await collectPortableContent({
        recipeRoot: join(integrityLoaded.staging!, "recipes"),
        declarationPath,
        recipes: Object.keys(manifest.recipes),
      });
      const problems = await validateSet(portableContent(base, manifest), { checkFiles: true });
      const declarationFinding = problems.find((entry) => entry.code === "SET_DECLARATION_INVALID");
      check("post-integrity declaration validation uses SET_DECLARATION_INVALID", declarationFinding?.code, "SET_DECLARATION_INVALID");
      check("post-integrity validation includes recipe checks without completeness findings", problems.some((entry) => entry.code === "SET_RECIPE_INCOMPLETE"), false);
      check("post-integrity artifact recipes participate", Object.keys(base.parsed.recipes).sort(), Object.keys(manifest.recipes).sort());
    } finally {
      if (integrityLoaded.staging !== undefined) await rm(integrityLoaded.staging, { recursive: true, force: true });
    }

    const declarationBytes = Buffer.concat([
      Buffer.from('[{"path":"x","value":"', "utf8"),
      Buffer.from([0xff]),
      Buffer.from('"}]', "utf8"),
    ]);
    useDeployment(deployment);
    const originalDeclaration = await readFile(resolve(deployment, "config", "desired-state.json"));
    const independentDigest = createHash("sha256").update(declarationBytes).digest("hex");
    await writeFile(resolve(deployment, "config", "desired-state.json"), declarationBytes);
    const declarationBase = await collectPortableContent({
      recipeRoot: resolve(deployment, "recipes"),
      declarationPath: resolve(deployment, "config", "desired-state.json"),
      recipes: Object.keys(healthy.recipes),
    });
    const declarationInventory = declarationBase.inventory.find((file) => file.path === DESIRED_STATE_PATH);
    check("declaration checksum preserves original bytes", [declarationInventory?.checksum, independentDigest], [independentDigest, independentDigest]);
    let declarationBuilt: Awaited<ReturnType<typeof buildSet>> | undefined;
    let declarationBuildRefusal = "";
    try {
      declarationBuilt = await buildSet(buildCtx, "demo-set");
    } catch (error) {
      declarationBuildRefusal = (error as Error).message;
    }
    check("set build succeeds after declaration byte check", declarationBuildRefusal, "");
    if (declarationBuilt !== undefined) {
      const builtDeclaration = await loadSet({ kind: "artifact", path: declarationBuilt.artifact });
      try {
        const builtInventoryDeclaration = builtDeclaration.content.inventory.find((file) => file.path === DESIRED_STATE_PATH);
        check("built artifact carries original declaration-byte digest", builtInventoryDeclaration?.checksum, independentDigest);
        check("built declaration parses from artifact", builtDeclaration.content.declaration.parsed, [{ path: "x", value: "\ufffd" }]);
      } finally {
        if (builtDeclaration.staging !== undefined) await rm(builtDeclaration.staging, { recursive: true, force: true });
      }
    }
    await writeFile(resolve(deployment, "config", "desired-state.json"), originalDeclaration);

    // A healthy, byte-consistent artifact can still be refused by a recipe's policy.
    const originalRecipe = await readFile(resolve(deployment, "recipes", "demo", "recipe.json"));
    await writeFile(resolve(deployment, "recipes", "demo", "recipe.json"), JSON.stringify({ description: "demo", privateFiles: 42 }));
    const policyBytes = Buffer.from(JSON.stringify({ description: "demo", privateFiles: 42 }));
    const policyDigest = checksumOf(policyBytes);
    const policyFiles = { ...healthy.files, "recipes/demo/recipe.json": policyDigest };
    const policyDemo = healthy.recipes.demo!;
    const policyDemoFiles = { ...policyDemo.files, "recipe.json": policyDigest };
    const policyManifest = {
      ...healthy,
      files: policyFiles,
      recipes: { ...healthy.recipes, demo: { ...policyDemo, files: policyDemoFiles, checksum: checksumOfFileMap(policyDemoFiles) } },
    };
    const policyArtifact = resolve(deployment, "policy-recipe.tar.gz");
    await packArtifact(deployment, policyManifest, policyArtifact);
    let policyStaging = "";
    await withArtifactInspected(policyArtifact, async (staging, _verified, problems) => {
      policyStaging = staging;
      const detail = problems.find((entry) => entry.code === "SET_RECIPE_INVALID")?.detail;
      const normalized = detail?.split(staging).join("<staging>");
      const expected = `${resolve(staging, "recipes", "demo", "recipe.json")}: privateFiles must be an array of recipe-relative paths`.split(staging).join("<staging>");
      check("policy-only recipe artifact reports full policy text", normalized, expected);
    });
    check("policy-only inspection removes staging", await access(policyStaging).then(() => false, () => true), true);

    await writeFile(resolve(deployment, "recipes", "demo", "recipe.json"), originalRecipe);

    const artifactCase = async (checkName: string, bytes: string, tailOf: (jsonError: string) => string): Promise<void> => {
      await writeFile(resolve(deployment, "config", "desired-state.json"), bytes);
      const manifest = { ...healthy, files: { ...healthy.files, [DESIRED_STATE_PATH]: checksumOf(Buffer.from(bytes)) } };
      const artifact = resolve(deployment, "declaration-assembled.tar.gz");
      await packArtifact(deployment, manifest, artifact);
      const loaded = await loadSet({ kind: "artifact", path: artifact });
      try {
        const problems = await validateLoadedSet(loaded);
        const stagingDeclarationPath = join(loaded.staging ?? "", "config", "desired-state.json");
        let jsonError = "";
        try {
          JSON.parse(bytes);
        } catch (error) {
          jsonError = (error as Error).message;
        }
        const expected = `<declaration>${tailOf(jsonError)}`;
        const declarationFinding = problems.find((entry) => entry.code === "SET_DECLARATION_INVALID");
        check(checkName, declarationFinding?.detail.split(stagingDeclarationPath).join("<declaration>"), expected);
      } finally {
        if (loaded.staging !== undefined) await rm(loaded.staging, { recursive: true, force: true });
      }
    };

    await artifactCase("the artifact's empty-declaration finding is the full historic text", "", () => missingOrEmptyTail);
    await artifactCase("the artifact's unparsable-declaration finding is the full historic text", invalidJson, (jsonError) => ` is not valid JSON: ${jsonError}`);
    await artifactCase("the artifact's wrong-shape-declaration finding is the full historic text", shapeBytes, () => shapeTail);
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// --- the memoized read really reaches the physical fs, once per path -----------------------
//
// The builder's contract: each source path is read from disk ONCE (the `read` closure
// memoizes into `cache`). The readFile seam counts physical reads so a check can prove the
// memoization — here over a real fixture tree and a real packed artifact's unpacked staging.
{
  const deployment = await mkdtemp(join(tmpdir(), "clawwright-set-build-check-"));
  await populateBuildDeployment(deployment);
  try {
    const readOnceViaSeam = async (
      checkPrefix: string,
      request: Omit<Parameters<typeof collectPortableContent>[0], "readFile">,
    ): Promise<void> => {
      const counts = new Map<string, number>();
      const readFileSeam = async (path: string): Promise<Buffer> => {
        counts.set(path, (counts.get(path) ?? 0) + 1);
        return readFile(path);
      };
      const base = await collectPortableContent({ ...request, readFile: readFileSeam });
      const offenders = [...counts.entries()].filter(([, count]) => count > 1).map(([path]) => path);
      // Fail-closed core: every physical read count must be exactly one; a failure NAMES the
      // repeated path. No exact total (host-dependent), only once-per-path.
      check(`${checkPrefix}: every source path is physically read once`, offenders.join("; "), "");
      // The expected sources were read at all — derived from the inventory, no hand list.
      const expectedSources = [...new Set([request.declarationPath, ...base.inventory.map((file) => file.origin)])].sort();
      const missed = expectedSources.filter((path) => !counts.has(path));
      check(`${checkPrefix}: the inventory's sources were each read at least once`, missed.join("; "), "");
    };

    // (a) the real fixture tree, recipeRoot as createBuildDeployment lays it out.
    const manifest = (await loadSet({ kind: "tree" }, { name: "demo-set", declaredImage: buildCtx.settings.image })).manifest;
    await readOnceViaSeam("tree", {
      recipeRoot: resolve(deployment, "recipes"),
      declarationPath: resolve(deployment, "config", "desired-state.json"),
      recipes: Object.keys(manifest.recipes),
    });

    // (b) a real packed artifact's unpacked staging.
    const artifact = resolve(deployment, "read-count.tar.gz");
    await packArtifact(deployment, manifest, artifact);
    const loaded = await loadSet({ kind: "artifact", path: artifact });
    try {
      await readOnceViaSeam("artifact staging", {
        recipeRoot: join(loaded.staging!, "recipes"),
        declarationPath: join(loaded.staging!, "config", "desired-state.json"),
        recipes: Object.keys(loaded.manifest.recipes),
      });
    } finally {
      if (loaded.staging !== undefined) await rm(loaded.staging, { recursive: true, force: true });
    }
  } finally {
    await removeBuildDeployment(deployment);
  }
}

// A malformed secrets.template.env must refuse the set load with the structured
// EnvSyntaxError (file + 1-based line), never be swallowed by the absent-template path.
{
  const source = await mkdtemp(join(tmpdir(), "clawwright-set-build-check-"));
  await populateBuildDeployment(source);
  const deployment = await mkdtemp(join(tmpdir(), "clawwright-env-template-"));
  await cp(source, deployment, { recursive: true });
  useDeployment(deployment);
  try {
    const templatePath = resolve(deployment, "config", "secrets.template.env");
    await writeFile(templatePath, "GOOD_NAME=value\nBROKEN LINE\n");
    let thrown: unknown;
    try {
      await loadSet({ kind: "tree" }, { name: "demo-set", declaredImage: buildCtx.settings.image });
    } catch (error) {
      thrown = error;
    }
    const error = thrown instanceof EnvSyntaxError ? thrown : undefined;
    check("a malformed secrets template refuses the set load as an EnvSyntaxError", error instanceof EnvSyntaxError, true);
    check("that refusal carries the structured code", error?.code, "ENV_LINE_WITHOUT_EQUALS");
    check("that refusal names the 1-based line as a number", error?.line, 2);
    check("that refusal names the template file", error?.file, templatePath);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    await removeBuildDeployment(source);
  }
}

finish("portable content model");
