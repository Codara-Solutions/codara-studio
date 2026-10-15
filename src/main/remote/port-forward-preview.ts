// What codara_preview_navigate asks before it opens a loopback URL: in a
// remote (SSH) workspace, localhost:<port> means that port on the host, which
// the browser here reaches through a forward (port-forwarding.ts). The
// runtime provides the resolver, so the browser tools never load the SSH
// stack themselves.

export type RemotePreviewResolution = { url: string } | { error: string };

type Resolver = (workspaceId: unknown, url: string) => Promise<RemotePreviewResolution | null>;

let resolver: Resolver | null = null;

export function provideRemotePreviewResolver(next: Resolver | null): void {
  resolver = next;
}

/** Null when the URL is not a loopback URL of a remote workspace. */
export async function resolveRemotePreviewUrl(
  workspaceId: unknown,
  url: string,
): Promise<RemotePreviewResolution | null> {
  if (!resolver) return null;
  try {
    return await resolver(workspaceId, url);
  } catch {
    return null;
  }
}
