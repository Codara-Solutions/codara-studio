import { validGitHubReviewDiscussionRequest, type GitHubReviewDiscussion, type GitHubReviewDiscussionComment, type GitHubReviewDiscussionPage, type GitHubReviewDiscussionRequest } from "@shared/github-review";
import { reviewSession } from "./github-review";

const COMMENTS = `comments(first: 3, after: $commentCursor) {
  nodes { id author { login } body createdAt url }
  pageInfo { hasNextPage endCursor }
}`;
const THREAD = `id path line originalLine diffSide isResolved isOutdated ${COMMENTS}`;
const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String, $commentCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 5, after: $cursor) { nodes { ${THREAD} } pageInfo { hasNextPage endCursor } }
  } }
}`;
const COMMENTS_QUERY = `query($threadId: ID!, $commentCursor: String) {
  node(id: $threadId) { ... on PullRequestReviewThread {
    ${THREAD} pullRequest { number repository { url } }
  } }
}`;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub returned an invalid discussion.");
  return value as Record<string, unknown>;
}

function string(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.length > max) throw new Error("GitHub returned invalid discussion metadata.");
  return value;
}

function nextCursor(value: unknown): string | undefined {
  const page = record(value);
  if (typeof page.hasNextPage !== "boolean") throw new Error("GitHub returned invalid discussion pagination.");
  return page.hasNextPage ? string(page.endCursor, 1024) : undefined;
}

function boundedComment(body: string): string {
  // JSON escaping can expand control characters sixfold on the phone wire.
  let low = 0;
  let high = Math.min(body.length, 16000);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(body.slice(0, middle))) <= 16000) low = middle;
    else high = middle - 1;
  }
  if (low < body.length && /[\uD800-\uDBFF]/.test(body.charAt(low - 1))) low -= 1;
  return body.slice(0, low);
}

function parseThread(value: unknown, input: GitHubReviewDiscussionRequest): GitHubReviewDiscussion {
  const thread = record(value);
  if (typeof thread.isResolved !== "boolean" || typeof thread.isOutdated !== "boolean" ||
      (thread.diffSide !== "LEFT" && thread.diffSide !== "RIGHT")) throw new Error("GitHub returned invalid discussion status.");
  const location = thread.isOutdated ? thread.originalLine : thread.line;
  if (location !== null && (!Number.isSafeInteger(location) || Number(location) <= 0)) throw new Error("GitHub returned an invalid discussion line.");
  const connection = record(thread.comments);
  if (!Array.isArray(connection.nodes) || connection.nodes.length > 3) throw new Error("GitHub returned an invalid comment page.");
  const comments: GitHubReviewDiscussionComment[] = connection.nodes.map((raw) => {
    const comment = record(raw);
    const url = string(comment.url, 4096);
    const expected = new URL(`${input.target.repositoryUrl}/pull/${input.target.pullRequestNumber}`);
    const actual = new URL(url);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.username || actual.password || actual.search ||
        !/^#discussion_r\d+$/.test(actual.hash)) throw new Error("GitHub returned an invalid discussion link.");
    if (typeof comment.body !== "string" || comment.body.length > 262144) throw new Error("GitHub returned an invalid discussion comment.");
    const createdAt = string(comment.createdAt, 64);
    if (!Number.isFinite(Date.parse(createdAt))) throw new Error("GitHub returned an invalid discussion date.");
    const body = boundedComment(comment.body);
    return { id: string(comment.id, 1024), author: comment.author === null ? "Deleted user" : string(record(comment.author).login, 256),
      body, truncated: body !== comment.body, createdAt, url };
  });
  const cursor = nextCursor(connection.pageInfo);
  return { id: string(thread.id, 1024), path: string(thread.path, 4096), line: location as number | null,
    side: thread.diffSide, resolved: thread.isResolved, outdated: thread.isOutdated, comments,
    ...(cursor ? { nextCursor: cursor } : {}) };
}

export async function readGitHubReviewDiscussions(
  cwd: string, input: GitHubReviewDiscussionRequest, dependencies: Parameters<typeof reviewSession>[2] = {},
): Promise<GitHubReviewDiscussionPage> {
  if (!validGitHubReviewDiscussionRequest(input)) throw new Error("Choose a valid discussion page.");
  const session = await reviewSession(cwd, input.target, dependencies);
  const baseCommitOid = await session.checkHead();
  let threads: GitHubReviewDiscussion[];
  let cursor: string | undefined;
  if (input.threadId) {
    const data = record(await session.graphql(COMMENTS_QUERY, { threadId: input.threadId, commentCursor: input.cursor ?? null }));
    const thread = record(data.node);
    const pr = record(thread.pullRequest);
    if (thread.id !== input.threadId || pr.number !== input.target.pullRequestNumber ||
        record(pr.repository).url !== session.repository.url) throw new Error("This discussion belongs to a different pull request.");
    threads = [parseThread(thread, input)];
  } else {
    const data = record(await session.graphql(THREADS_QUERY, { owner: session.repository.owner, name: session.repository.name,
      number: input.target.pullRequestNumber, cursor: input.cursor ?? null, commentCursor: null }));
    const connection = record(record(record(data.repository).pullRequest).reviewThreads);
    if (!Array.isArray(connection.nodes) || connection.nodes.length > 5) throw new Error("GitHub returned an invalid discussion page.");
    threads = connection.nodes.map((thread) => parseThread(thread, input));
    cursor = nextCursor(connection.pageInfo);
  }
  if (await session.checkHead() !== baseCommitOid) throw new Error("The PR base changed while loading. Reopen the current review.");
  return { headCommitOid: input.target.expectedHeadCommitOid, baseCommitOid, threads, ...(cursor ? { nextCursor: cursor } : {}) };
}
