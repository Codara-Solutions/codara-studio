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
    nextDefaultAfterDeletion,
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

  // The CLI link column: a row may name its terminal half ("personal" for
  // the user's own CLI home, a managed profile id otherwise). Links are unique
  // per provider. The link is followed, never inferred, so the file must
  // refuse every shape that would let the credential mirror copy tokens
  // between two accounts of one provider.
  const CLI_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const CLI_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const linkRoot = path.join(TMP, "links");
  const linkIds = sequence([
    IDS.a,
    IDS.b,
    IDS.c,
    IDS.d,
    "10000000-0000-4000-8000-000000000011",
    "10000000-0000-4000-8000-000000000012",
    "10000000-0000-4000-8000-000000000013",
  ]);
  const links = new PiAccountProfileRegistry(linkRoot, {
    idFactory: linkIds,
    now: () => new Date("2026-08-30T08:00:00.000Z"),
  });
  const linkedAtRegister = await links.registerProfile({
    provider: "anthropic",
    label: "Account 1",
    cliProfileId: "personal",
  });
  check(
    "a link given at registration round-trips through the file",
    linkedAtRegister.profile.cliProfileId === "personal" &&
      (await links.getProfile(IDS.a))?.cliProfileId === "personal" &&
      (await links.accountOneProfile("anthropic"))?.id === IDS.a,
  );
  const unlinked = await links.registerProfile({ provider: "anthropic", label: "Work" });
  const recorded = await links.recordCliProfileId(unlinked.profile.id, CLI_A);
  check(
    "recordCliProfileId pairs a row and profileForCliProfileId finds it",
    recorded.cliProfileId === CLI_A &&
      (await links.profileForCliProfileId("anthropic", CLI_A))?.id === IDS.b &&
      (await links.profileForCliProfileId("anthropic", CLI_B)) === undefined &&
      (await links.profileForCliProfileId("openai-codex", CLI_A)) === undefined,
  );
  check(
    "recording the same link again is a no-op",
    (await links.recordCliProfileId(IDS.b, CLI_A)).updatedAt === recorded.updatedAt,
  );
  const third = await links.registerProfile({ provider: "anthropic", label: "Third" });
  await expectThrows(
    "a link held by another row cannot be recorded on a second one",
    () => links.recordCliProfileId(third.profile.id, CLI_A),
    "PiAccountProfileLinkCollisionError",
  );
  await expectThrows(
    "a second personal link is refused",
    () => links.recordCliProfileId(third.profile.id, "personal"),
    "PiAccountProfileLinkCollisionError",
  );
  await expectThrows(
    "registering with a link another row holds is refused",
    () =>
      links.registerProfile({
        provider: "anthropic",
        label: "Duplicate link",
        cliProfileId: CLI_A,
      }),
    "PiAccountProfileLinkCollisionError",
  );
  await expectThrows(
    "a malformed link is a TypeError",
    () => links.recordCliProfileId(third.profile.id, "Personal"),
    "TypeError",
  );
  // Links are scoped per provider: a Codex row and a Grok row may each link
  // a managed profile, "personal" may be linked once per provider, and the
  // reverse lookup never crosses providers.
  const codexRow = await links.registerProfile({ provider: "openai-codex", label: "Codex" });
  const codexLinked = await links.recordCliProfileId(codexRow.profile.id, CLI_A);
  const grokRow = await links.registerProfile({ provider: "xai", label: "Grok", cliProfileId: CLI_B });
  const grokOne = await links.registerProfile({ provider: "xai", label: "Grok 1", cliProfileId: "personal" });
  const codexOne = await links.registerProfile({ provider: "openai-codex", label: "Codex 1", cliProfileId: "personal" });
  check(
    "an openai-codex and an xai row may link a managed profile and their own personal",
    codexLinked.cliProfileId === CLI_A &&
      grokRow.profile.cliProfileId === CLI_B &&
      grokOne.profile.cliProfileId === "personal" &&
      codexOne.profile.cliProfileId === "personal" &&
      (await links.accountOneProfile("xai"))?.id === grokOne.profile.id &&
      (await links.accountOneProfile("openai-codex"))?.id === codexOne.profile.id &&
      (await links.accountOneProfile("anthropic"))?.id === IDS.a,
  );
  check(
    "the reverse lookup is scoped by provider",
    (await links.profileForCliProfileId("openai-codex", CLI_A))?.id === codexRow.profile.id &&
      (await links.profileForCliProfileId("anthropic", CLI_A))?.id === IDS.b &&
      (await links.profileForCliProfileId("xai", CLI_A)) === undefined &&
      (await links.profileForCliProfileId("xai", CLI_B))?.id === grokRow.profile.id,
  );
  await expectThrows(
    "a second personal link within one provider is refused",
    () => links.recordCliProfileId(grokRow.profile.id, "personal"),
    "PiAccountProfileLinkCollisionError",
  );
  for (const row of [grokRow, grokOne, codexOne]) await links.deleteProfile(row.profile.id);
  await links.recordCliProfileId(codexRow.profile.id, null);
  const cleared = await links.recordCliProfileId(IDS.b, null);
  check(
    "null clears a link and leaves the rest of the row intact",
    cleared.cliProfileId === undefined &&
      cleared.label === "Work" &&
      !("cliProfileId" in JSON.parse(fs.readFileSync(links.filePath, "utf8")).profiles[1]),
    JSON.stringify(cleared),
  );
  const persistedLinks = JSON.parse(fs.readFileSync(links.filePath, "utf8"));
  check(
    "the persisted link column carries only the allowed values",
    persistedLinks.profiles.every(
      (profile) =>
        profile.cliProfileId === undefined ||
        profile.cliProfileId === "personal" ||
        /^[0-9a-f-]{36}$/.test(profile.cliProfileId),
    ),
  );

  // Deleting the Anthropic default lands on Account 1 even when an older row
  // exists; other providers keep the oldest-row rule.
  await links.recordCliProfileId(IDS.b, CLI_A);
  await links.setDefaultProfile("anthropic", IDS.c);
  const promoted = await links.deleteProfile(IDS.c);
  check(
    "deleting the anthropic default promotes the Account 1 row over older rows",
    promoted.snapshot.defaults.anthropic === IDS.a,
    JSON.stringify(promoted.snapshot.defaults),
  );
  check(
    "nextDefaultAfterDeletion falls back to the oldest row without an Account 1",
    nextDefaultAfterDeletion(
      [
        { id: IDS.c, provider: "anthropic", label: "c", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
        { id: IDS.d, provider: "anthropic", label: "d", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      "anthropic",
    ) === IDS.d,
  );

  for (const [name, profiles, expectedName] of [
    [
      "two rows sharing one link are a corrupt registry",
      [
        { id: IDS.e, provider: "anthropic", label: "One", createdAt: "2026-08-30T08:00:00.000Z", updatedAt: "2026-08-30T08:00:00.000Z", cliProfileId: CLI_B },
        { id: IDS.f, provider: "anthropic", label: "Two", createdAt: "2026-08-30T08:00:00.000Z", updatedAt: "2026-08-30T08:00:00.000Z", cliProfileId: CLI_B },
      ],
      "PiAccountProfilesCorruptError",
    ],
    [
      "two personal links are a corrupt registry",
      [
        { id: IDS.e, provider: "anthropic", label: "One", createdAt: "2026-08-30T08:00:00.000Z", updatedAt: "2026-08-30T08:00:00.000Z", cliProfileId: "personal" },
        { id: IDS.f, provider: "anthropic", label: "Two", createdAt: "2026-08-30T08:00:00.000Z", updatedAt: "2026-08-30T08:00:00.000Z", cliProfileId: "personal" },
      ],
      "PiAccountProfilesCorruptError",
    ],
    [
      "two personal links in one provider are a corrupt registry even beside other providers",
      [
        { id: IDS.e, provider: "openai-codex", label: "One", createdAt: "2026-08-30T08:00:00.000Z", updatedAt: "2026-08-30T08:00:00.000Z", cliProfileId: "personal" },
        { id: IDS.f, provider: "openai-codex", label: "Two", createdAt: "2026-08-30T08:00:00.000Z", updatedAt: "2026-08-30T08:00:00.000Z", cliProfileId: "personal" },
      ],
      "PiAccountProfilesCorruptError",
    ],
    [
      "an uppercase link is a corrupt registry",
      [
        { id: IDS.e, provider: "anthropic", label: "One", createdAt: "2026-08-30T08:00:00.000Z", updatedAt: "2026-08-30T08:00:00.000Z", cliProfileId: CLI_B.toUpperCase() },
      ],
      "PiAccountProfilesCorruptError",
    ],
  ]) {
    const corruptLinkRoot = path.join(TMP, `corrupt-link-${IDS.e}-${name.length}`);
    fs.mkdirSync(corruptLinkRoot, { recursive: true });
    fs.writeFileSync(
      path.join(corruptLinkRoot, PI_ACCOUNT_PROFILES_FILE),
      JSON.stringify({ version: 1, profiles, defaults: {} }),
    );
    await expectThrows(
      name,
      () => new PiAccountProfileRegistry(corruptLinkRoot).snapshot(),
      expectedName,
    );
  }

  {
    const threeRoot = path.join(TMP, "three-personal");
    fs.mkdirSync(threeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(threeRoot, PI_ACCOUNT_PROFILES_FILE),
      JSON.stringify({
        version: 1,
        profiles: [
          { id: IDS.e, provider: "anthropic", label: "One", createdAt: "2026-08-30T08:00:00.000Z", updatedAt: "2026-08-30T08:00:00.000Z", cliProfileId: "personal" },
          { id: IDS.f, provider: "openai-codex", label: "Two", createdAt: "2026-08-30T08:00:00.000Z", updatedAt: "2026-08-30T08:00:00.000Z", cliProfileId: "personal" },
          { id: IDS.a, provider: "xai", label: "Three", createdAt: "2026-08-30T08:00:00.000Z", updatedAt: "2026-08-30T08:00:00.000Z", cliProfileId: "personal" },
        ],
        defaults: {},
      }),
    );
    const three = await new PiAccountProfileRegistry(threeRoot).snapshot();
    check(
      "three rows of different providers may each link personal",
      three.profiles.length === 3 && three.profiles.every((profile) => profile.cliProfileId === "personal"),
    );
  }

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
