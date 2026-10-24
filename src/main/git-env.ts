// Environment for every git child Codara starts on a user's repository,
// whether through runGit or a direct spawn that needs stdin or its own index.
// GIT_TERMINAL_PROMPT=0 makes an auth-required op fail instead of waiting on a
// prompt nobody sees. GIT_OPTIONAL_LOCKS=0 keeps reads such as `git status`
// from taking the index lock a stash or stage of the user's needs at the same
// moment; locks a write requires are taken all the same.
export function gitChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}
