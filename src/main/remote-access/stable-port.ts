// A paired phone needs LAN ports that survive a Studio process restart.
// Deriving a small ordered candidate set from the already-pinned, random
// 32-byte computer identity gives each installation stable discovery without
// adding mutable state. The listener takes the first available candidate.
//
// This is discovery only, never authentication: every connection still has to
// complete Noise IK against the full pinned computer key, and the listener
// remains silent to unknown phone keys.
//
// Keep the constants and arithmetic in this file in sync with
// codara-mobile/worklet/lib/stable-port.js. scripts/test-remote-access.cjs
// verifies the complete ordered sequence byte-for-byte across the repos.

export const REMOTE_ACCESS_PORT_MIN = 41_000;
export const REMOTE_ACCESS_PORT_SPAN = 20_000;
export const REMOTE_ACCESS_PUBLIC_KEY_BYTES = 32;
export const REMOTE_ACCESS_PORT_CANDIDATE_COUNT = 4;
// Coprime to 20,000, so every offset below is distinct. Candidate zero is
// intentionally the old single stable port, preserving rolling-upgrade and
// already-paired-device compatibility.
export const REMOTE_ACCESS_PORT_CANDIDATE_STEP = 7_919;

export function stableRemoteAccessPortCandidates(publicKey: Uint8Array): number[] {
  if (publicKey.byteLength !== REMOTE_ACCESS_PUBLIC_KEY_BYTES) {
    throw new Error("Remote Access identity public key must be 32 bytes.");
  }

  // FNV-1a with explicit unsigned 32-bit arithmetic is identical in Node and
  // the phone's Bare JavaScript runtime. The key is already uniformly random;
  // the hash simply mixes all 32 bytes before mapping into our port range.
  let hash = 0x811c9dc5;
  for (const byte of publicKey) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }

  return Array.from(
    { length: REMOTE_ACCESS_PORT_CANDIDATE_COUNT },
    (_, index) =>
      REMOTE_ACCESS_PORT_MIN +
      ((hash + index * REMOTE_ACCESS_PORT_CANDIDATE_STEP) % REMOTE_ACCESS_PORT_SPAN),
  );
}
