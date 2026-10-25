import { SettingRow } from "./SettingsPrimitives";

// The repositories switched off from a row's "Stop watching pull requests in
// this repo", each with the way back.
export function PullRequestWatchOffRepos({
  repositories,
  onWatch,
}: {
  repositories: readonly string[];
  onWatch: (repository: string) => void;
}) {
  if (repositories.length === 0) return null;
  return (
    <>
      {repositories.map((repository) => (
        <SettingRow
          key={repository}
          title={repository}
          desc="Pull requests here are not watched."
          control={
            <button type="button" className="spark-btn" onClick={() => onWatch(repository)}>
              Watch again
            </button>
          }
        />
      ))}
    </>
  );
}
