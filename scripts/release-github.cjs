"use strict";

const fs = require("node:fs");
const { compareVersions, verifyBundle } = require("./release-bundle.cjs");

function githubClient(token, repository, fetcher = fetch) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("GitHub release credentials are missing");
  return async (route, method = "GET", body) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${route}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${route}: HTTP ${response.status}`);
    return response.json();
  };
}

async function sourceArtifact(api, runId, repositoryId) {
  if (!/^[1-9]\d*$/.test(runId)) throw new Error("Invalid recovery run ID");
  const run = await api(`actions/runs/${runId}`);
  if (!run || String(run.repository.id) !== repositoryId || run.head_branch !== "main" ||
      run.head_repository.id !== run.repository.id || run.path !== ".github/workflows/release.yml" ||
      !["schedule", "workflow_dispatch"].includes(run.event)) {
    throw new Error("Recovery requires a main-branch Release run from this repository");
  }
  const artifacts = [];
  for (let page = 1; ; page++) {
    const result = await api(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
    if (!result) throw new Error("Release artifacts are unavailable");
    artifacts.push(...result.artifacts);
    if (result.artifacts.length < 100) break;
  }
  const matches = artifacts.filter((artifact) => artifact.name === "release-bundle");
  if (matches.length !== 1 || matches[0].expired || matches[0].workflow_run?.head_sha !== run.head_sha) {
    throw new Error("One unexpired release-bundle artifact is required; never rebuild a tagged version");
  }
  return { sha: run.head_sha, artifactId: String(matches[0].id) };
}

async function assertCurrentRelease(api, version, sha) {
  const comparison = await api(`compare/${sha}...main`);
  if (!comparison || !["ahead", "identical"].includes(comparison.status)) throw new Error("Release commit is not on main");
  for (let page = 1; ; page++) {
    const tags = await api(`tags?per_page=100&page=${page}`);
    if (!tags) throw new Error("Cannot inspect release tags");
    for (const tag of tags) {
      if (/^v\d+\.\d+\.\d+$/.test(tag.name) && compareVersions(tag.name.slice(1), version) > 0) {
        throw new Error(`A newer release tag exists: ${tag.name}`);
      }
    }
    if (tags.length < 100) break;
  }
}

async function releaseTag(api, manifest, create) {
  await assertCurrentRelease(api, manifest.version, manifest.sha);
  const route = `git/ref/tags/v${manifest.version}`;
  let ref = await api(route);
  if (!ref && create) {
    // A response can be lost after GitHub has created the ref. Read it back before deciding.
    try { await api("git/refs", "POST", { ref: `refs/tags/v${manifest.version}`, sha: manifest.sha }); }
    catch (err) { if (!(await api(route))) throw err; }
    ref = await api(route);
  }
  if (!ref || ref.object.type !== "commit" || ref.object.sha !== manifest.sha) {
    throw new Error("Release tag is missing or points to a different commit; refusing publication");
  }
}

module.exports = { githubClient, sourceArtifact, releaseTag };

if (require.main === module) {
  (async () => {
    const api = githubClient(process.env.GH_TOKEN, process.env.GITHUB_REPOSITORY);
    const command = process.argv[2];
    if (command === "source") {
      const source = await sourceArtifact(api, process.env.RELEASE_RUN_ID, process.env.GITHUB_REPOSITORY_ID);
      if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha=${source.sha}\nartifact_id=${source.artifactId}\n`);
    } else if (["tag", "verify-tag"].includes(command)) {
      const manifest = verifyBundle(process.argv[3] || "release-bundle", {
        sha: process.env.RELEASE_SHA, runId: process.env.RELEASE_RUN_ID,
      });
      await releaseTag(api, manifest, command === "tag");
      console.log(`Verified tag v${manifest.version} at ${manifest.sha}`);
    } else throw new Error("Usage: release-github.cjs <source|tag|verify-tag>");
  })().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
