"use strict";

// Focused harness for the metadata-only Pi account profile foundation.
//
//   node scripts/test-pi-account-profiles.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(
  ROOT,
  "src",
  "main",
  "orchestration",
  "pi-account-profiles.ts",
);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-account-profiles-"));

const IDS = {
  a: "10000000-0000-4000-8000-000000000001",
  b: "10000000-0000-4000-8000-000000000002",
  c: "10000000-0000-4000-8000-000000000003",
  d: "10000000-0000-4000-8000-000000000004",
  e: "10000000-0000-4000-8000-000000000005",
  f: "10000000-0000-4000-8000-000000000006",
};
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

let failures = 0;
function check(name, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : `: ${detail}`}`);
  if (!condition) failures += 1;
}

async function expectThrows(name, operation, expectedName) {
  let error = null;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  check(
    name,
    !!error && (!expectedName || error.name === expectedName),
    error ? `${error.name}: ${error.message}` : "did not throw",
  );
  return error;
}

function sequence(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

async function main() {
  const outfile = path.join(TMP, "pi-account-profiles.cjs");
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const {
    PI_ACCOUNT_PROFILES_FILE,
    PiAccountProfileRegistry,
    rankPiAccountCandidates,
    selectPiAccountCandidate,
  } = require(outfile);

  // Empty roots are read-only until the first mutation.
  const basicRoot = path.join(TMP, "basic");
  const clock = sequence([
    new Date("2026-07-30T08:00:00.000Z"),
    new Date("2026-07-30T08:01:00.000Z"),
    new Date("2026-07-30T08:02:00.000Z"),
    new Date("2026-07-30T08:03:00.000Z"),
  ]);
  const basic = new PiAccountProfileRegistry(basicRoot, {
    idFactory: sequence([IDS.a, IDS.a, IDS.b, IDS.c, IDS.d]),
    now: clock,
  });
  const empty = await basic.snapshot();
  check(
    "missing registry reads as an empty versioned snapshot",
    empty.version === 1 &&
      empty.profiles.length === 0 &&
      Object.keys(empty.defaults).length === 0 &&
      !fs.existsSync(basicRoot),
    JSON.stringify(empty),
  );

  const first = await basic.registerProfile({
    provider: "anthropic",
    label: "  Claude Max 1  ",
    identityFingerprint: FP_A,
  });
  check(
    "first profile is trimmed, timestamped, and made provider default",
    first.created &&
      first.profile.id === IDS.a &&
      first.profile.label === "Claude Max 1" &&
      first.profile.createdAt === "2026-07-30T08:00:00.000Z" &&
      first.profile.updatedAt === first.profile.createdAt &&
      first.snapshot.defaults.anthropic === IDS.a,
    JSON.stringify(first),
  );

  const filePath = path.join(basicRoot, PI_ACCOUNT_PROFILES_FILE);
  const mode = fs.statSync(filePath).mode & 0o777;
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  check(
    "persistence is mode 0600 and contains metadata only",
    (process.platform === "win32" || mode === 0o600) &&
      Object.keys(persisted).sort().join(",") === "defaults,profiles,version" &&
      Object.keys(persisted.profiles[0]).sort().join(",") ===
        "createdAt,id,identityFingerprint,label,provider,updatedAt" &&
      !/access.?token|refresh.?token|secret/i.test(JSON.stringify(persisted)),
    `mode=${mode.toString(8)} data=${JSON.stringify(persisted)}`,
  );
  check(
    "atomic writer leaves no sibling temporary file",
    fs.readdirSync(basicRoot).every((name) => !name.endsWith(".tmp")),
    fs.readdirSync(basicRoot).join(","),
  );

  const duplicate = await basic.registerProfile({
    provider: "anthropic",
    label: "A label that must not overwrite the existing profile",
    identityFingerprint: FP_A,
    makeDefault: true,
  });
  check(
    "same provider plus fingerprint deduplicates without overwriting metadata",
    !duplicate.created &&
      duplicate.profile.id === IDS.a &&
      duplicate.profile.label === "Claude Max 1" &&
      duplicate.snapshot.profiles.length === 1,
    JSON.stringify(duplicate),
  );

  const second = await basic.registerProfile({
    provider: "anthropic",
    label: "Claude Max 1",
  });
  check(
    "duplicate display labels are allowed and UUID collision is retried",
    second.created &&
      second.profile.id === IDS.b &&
      second.profile.label === first.profile.label &&
      second.snapshot.profiles.length === 2,
    JSON.stringify(second),
  );

  const crossProvider = await basic.registerProfile({
    provider: "openai-codex",
    label: "Codex Pro",
    identityFingerprint: FP_A,
  });
  check(
    "the same fingerprint may exist under a different provider",
    crossProvider.created &&
      crossProvider.profile.id === IDS.c &&
      crossProvider.snapshot.defaults["openai-codex"] === IDS.c,
    JSON.stringify(crossProvider),
  );

  const renamed = await basic.renameProfile(IDS.b, "  Claude Max 2  ");
  check(
    "rename updates only sanitized label metadata and updatedAt",
    renamed.label === "Claude Max 2" &&
      renamed.createdAt === "2026-07-30T08:01:00.000Z" &&
      renamed.updatedAt === "2026-07-30T08:03:00.000Z",
    JSON.stringify(renamed),
  );
  await expectThrows(
    "labels reject control characters",
    () => basic.renameProfile(IDS.b, "bad\nlabel"),
    "TypeError",
  );
  await expectThrows(
    "fingerprints must be sanitized lowercase SHA-256",
    () =>
      basic.registerProfile({
        provider: "anthropic",
        label: "Unsafe fingerprint",
        identityFingerprint: "not-a-hash",
      }),
    "TypeError",
  );

  await expectThrows(
    "a profile cannot become another provider's default",
    () => basic.setDefaultProfile("openai-codex", IDS.a),
    "TypeError",
  );
  await expectThrows(
    "an explicitly protected active profile cannot be deleted",
    () => basic.deleteProfile(IDS.a, { protectedProfileIds: new Set([IDS.a]) }),
    "PiAccountProfileProtectedError",
  );
  check(
    "protected deletion leaves the profile and default intact",
    (await basic.getProfile(IDS.a))?.id === IDS.a &&
      (await basic.getDefaultProfile("anthropic"))?.id === IDS.a,
  );

  const deletedDefault = await basic.deleteProfile(IDS.a);
  check(
    "deleting a default promotes the deterministic oldest remaining provider profile",
    deletedDefault.deleted &&
      deletedDefault.snapshot.defaults.anthropic === IDS.b &&
      deletedDefault.snapshot.profiles.every((profile) => profile.id !== IDS.a),
    JSON.stringify(deletedDefault),
  );
  const deletedAgain = await basic.deleteProfile(IDS.a);
  check("deleting an absent profile is idempotent", !deletedAgain.deleted);

  // Two registry objects targeting the same file share the in-process mutation
  // queue. Concurrent registration with one fingerprint must land once.
  const concurrentRoot = path.join(TMP, "concurrent");
  const concurrentA = new PiAccountProfileRegistry(concurrentRoot, {
    idFactory: () => IDS.d,
    now: () => new Date("2026-07-30T09:00:00.000Z"),
  });
  const concurrentB = new PiAccountProfileRegistry(concurrentRoot, {
    idFactory: () => IDS.e,
    now: () => new Date("2026-07-30T09:00:01.000Z"),
  });
  const concurrentResults = await Promise.all([
    concurrentA.registerProfile({
      provider: "openai-codex",
      label: "Codex A",
      identityFingerprint: FP_B,
    }),
    concurrentB.registerProfile({
      provider: "openai-codex",
      label: "Codex B",
      identityFingerprint: FP_B,
    }),
  ]);
  const concurrentSnapshot = await concurrentA.snapshot();
  check(
    "concurrent same-file registration deduplicates without a lost update",
    concurrentResults.filter((result) => result.created).length === 1 &&
      concurrentSnapshot.profiles.length === 1,
    JSON.stringify({ concurrentResults, concurrentSnapshot }),
  );

  // Strict parsing prevents accidental token-shaped or future unknown fields
  // from being silently copied into a later atomic write.
  const corruptRoot = path.join(TMP, "corrupt");
  fs.mkdirSync(corruptRoot, { recursive: true });
  fs.writeFileSync(
    path.join(corruptRoot, PI_ACCOUNT_PROFILES_FILE),
    JSON.stringify({
      version: 1,
      profiles: [
        {
          id: IDS.f,
          provider: "anthropic",
          label: "Must reject",
          createdAt: "2026-07-30T10:00:00.000Z",
          updatedAt: "2026-07-30T10:00:00.000Z",
          accessToken: "must-never-land",
        },
      ],
      defaults: {},
    }),
  );
  const corrupt = new PiAccountProfileRegistry(corruptRoot);
  await expectThrows(
    "unknown/token-shaped persisted fields fail closed",
    () => corrupt.snapshot(),
    "PiAccountProfilesCorruptError",
  );
  const corruptBefore = fs.readFileSync(
    path.join(corruptRoot, PI_ACCOUNT_PROFILES_FILE),
    "utf8",
  );
  await expectThrows(
    "a mutation does not overwrite a corrupt registry",
    () => corrupt.registerProfile({ provider: "anthropic", label: "No overwrite" }),
    "PiAccountProfilesCorruptError",
  );
  check(
    "corrupt registry remains byte-identical after refused mutation",
    fs.readFileSync(path.join(corruptRoot, PI_ACCOUNT_PROFILES_FILE), "utf8") ===
      corruptBefore,
  );

  // Candidate selection is pure and deterministic: explicit healthy pin,
  // otherwise greatest known headroom, then provider default, creation time,
  // and UUID. Missing, unavailable, and limited signals never become eligible.
  const routingSnapshot = {
    version: 1,
    profiles: [
      {
        id: IDS.a,
        provider: "anthropic",
        label: "Default",
        createdAt: "2026-07-30T08:00:00.000Z",
        updatedAt: "2026-07-30T08:00:00.000Z",
      },
      {
        id: IDS.b,
        provider: "anthropic",
        label: "Roomiest",
        createdAt: "2026-07-30T08:01:00.000Z",
        updatedAt: "2026-07-30T08:01:00.000Z",
      },
      {
        id: IDS.c,
        provider: "anthropic",
        label: "Unknown",
        createdAt: "2026-07-30T08:02:00.000Z",
        updatedAt: "2026-07-30T08:02:00.000Z",
      },
      {
        id: IDS.d,
        provider: "openai-codex",
        label: "Other provider",
        createdAt: "2026-07-30T08:03:00.000Z",
        updatedAt: "2026-07-30T08:03:00.000Z",
      },
    ],
    defaults: { anthropic: IDS.a, "openai-codex": IDS.d },
  };
  const signals = [
    { profileId: IDS.a, available: true, limitReached: false, headroomPercent: 40 },
    { profileId: IDS.b, available: true, limitReached: false, headroomPercent: 90 },
    { profileId: IDS.c, available: true, limitReached: false, headroomPercent: null },
    { profileId: IDS.d, available: true, limitReached: false, headroomPercent: 100 },
  ];
  const ranked = rankPiAccountCandidates(routingSnapshot, "anthropic", signals);
  check(
    "candidate ranking chooses same-provider maximum known headroom",
    ranked.map((candidate) => candidate.profile.id).join(",") ===
      [IDS.b, IDS.a, IDS.c].join(","),
    JSON.stringify(ranked),
  );
  check(
    "a healthy explicit pin wins without changing the deterministic remainder",
    rankPiAccountCandidates(routingSnapshot, "anthropic", signals, {
      preferredProfileId: IDS.a,
    })
      .map((candidate) => candidate.profile.id)
      .join(",") === [IDS.a, IDS.b, IDS.c].join(","),
  );

  const excludedSignals = signals.map((signal) =>
    signal.profileId === IDS.b
      ? { ...signal, limitReached: true }
      : signal.profileId === IDS.a
        ? { ...signal, available: false }
        : signal,
  );
  check(
    "unavailable and limited accounts are ineligible",
    selectPiAccountCandidate(routingSnapshot, "anthropic", excludedSignals)?.profile.id ===
      IDS.c,
    JSON.stringify(excludedSignals),
  );
  check(
    "missing signals do not make an account implicitly eligible",
    selectPiAccountCandidate(routingSnapshot, "anthropic", []) === null,
  );

  const equalSignals = [
    { profileId: IDS.a, available: true, limitReached: false, headroomPercent: 50 },
    { profileId: IDS.b, available: true, limitReached: false, headroomPercent: 50 },
  ];
  check(
    "provider default deterministically breaks equal-headroom ties",
    selectPiAccountCandidate(routingSnapshot, "anthropic", equalSignals)?.profile.id ===
      IDS.a,
  );
  await expectThrows(
    "duplicate headroom signals fail instead of depending on array order",
    () =>
      Promise.resolve(
        rankPiAccountCandidates(routingSnapshot, "anthropic", [
          equalSignals[0],
          equalSignals[0],
        ]),
      ),
    "TypeError",
  );
  await expectThrows(
    "out-of-range headroom fails closed",
    () =>
      Promise.resolve(
        rankPiAccountCandidates(routingSnapshot, "anthropic", [
          {
            profileId: IDS.a,
            available: true,
            limitReached: false,
            headroomPercent: 101,
          },
        ]),
      ),
    "TypeError",
  );

  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} pi-account-profile assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll Pi account profile assertions passed.");
}

main().catch((error) => {
  console.error(error);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
