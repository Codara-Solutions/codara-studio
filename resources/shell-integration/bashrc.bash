# spark-shell-integration (bashrc)
#
# Differences vs zsh integration:
# - We emulate login-shell init manually (/etc/profile, profile files) because
#   bash ignores --rcfile when started with -l.
# - Pre-exec marker uses PS0 (bash 4.4+). On older bash (macOS default 3.2) we
#   skip it; a fragile DEBUG-trap alternative would clobber the user's own
#   traps and interact badly with debuggers.

# Follow the Active account. A plain user pane carries
# SPARK_FOLLOW_ACTIVE_ACCOUNT=1 and main rewrites
# $SPARK_HOME_DIR/shell/active-cli-env on every account switch. The file is
# data, never sourced or evaluated: only CLAUDE_CONFIG_DIR, CODEX_HOME and
# GROK_HOME lines whose value sits under this Codara home's directory for
# that CLI are honored, and a variable is only ever written when it is unset
# or itself inside that root or matches the personal home supplied at spawn.
# A different value the user exports manually is never touched.
# Cost per prompt is one builtin read of the header line: no fork, no stat,
# and an unchanged revision returns before anything else is parsed. Every
# failure (missing file, unreadable, bad header) is silent and leaves the
# environment alone. bash 3.2 safe: nothing newer than its builtins is used.
#
# Runs from PROMPT_COMMAND AND a DEBUG trap. The prompt alone is too late
# for the common case: the prompt is already drawn when the user switches
# accounts in Settings, so a `claude` typed next would still start under
# the old selector. The DEBUG trap fires right before each top-level
# command, so the switch lands on that very command (see the install below).
_spark_follow_active_account() {
  [ "${SPARK_FOLLOW_ACTIVE_ACCOUNT-}" = "1" ] || return 0
  local home="${SPARK_HOME_DIR:-$HOME/.codarastudio}"
  local file="$home/shell/active-cli-env"
  local word version rev
  { IFS=' ' read -r word version rev < "$file"; } 2>/dev/null || return 0
  [ "$word" = "codara-active-cli-env" ] || return 0
  [ -n "$rev" ] || return 0
  [ "$rev" = "${__SPARK_ACTIVE_ENV_REV-}" ] && return 0
  local claude_root="$home/claude-cli/"
  local codex_root="$home/codex-cli/accounts/"
  local grok_root="$home/grok-cli/accounts/"
  local line value claude="" codex="" grok=""
  {
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        CLAUDE_CONFIG_DIR=*|CODEX_HOME=*|GROK_HOME=*) ;;
        *) continue ;;
      esac
      value="${line#*=}"
      case "$value" in
        *[[:cntrl:]]*|*"/../"*|*"/..") continue ;;
      esac
      case "$line" in
        CLAUDE_CONFIG_DIR=*)
          case "$value" in "$claude_root"?*) claude="$value" ;; esac ;;
        CODEX_HOME=*)
          case "$value" in "$codex_root"?*) codex="$value" ;; esac ;;
        GROK_HOME=*)
          case "$value" in "$grok_root"?*) grok="$value" ;; esac ;;
      esac
    done < "$file"
  } 2>/dev/null || return 0
  _spark_follow_var CLAUDE_CONFIG_DIR "$claude_root" "$claude" "${SPARK_PERSONAL_CLAUDE_CONFIG_DIR-}"
  _spark_follow_var CODEX_HOME "$codex_root" "$codex" "${SPARK_PERSONAL_CODEX_HOME-}"
  _spark_follow_var GROK_HOME "$grok_root" "$grok" "${SPARK_PERSONAL_GROK_HOME-}"
  __SPARK_ACTIVE_ENV_REV="$rev"
}

# Write one selector: only when the current value is unset, empty, or
# already under the managed root (the spawn-time selector and a previous
# hook write both look like that), or still matches the saved personal home.
# An empty target restores that home; an originally unset selector stays unset.
_spark_follow_var() {
  local name="$1" root="$2" target="$3" personal="${4-}" current
  current="${!name-}"
  if [ -n "$current" ] && [ "$current" != "$personal" ]; then
    case "$current" in
      "$root"*) ;;
      *) return 0 ;;
    esac
  fi
  target="${target:-$personal}"
  if [ -n "$target" ]; then
    [ "$current" = "$target" ] || export "$name=$target"
  elif [ -n "$current" ]; then
    unset "$name"
  fi
}

# Worker and agent sessions (Claude / Codex hosted in bash) set this var so
# the prompt integration is skipped: its OSC writes confuse Ink-based TUIs
# that take over the alternate screen. The account-follow hook writes
# nothing to the terminal, so a pane that carries the follow flag still
# installs it (prompt side here, the DEBUG trap at the end of this file):
# an agent pane's shell, the one left after `claude` exits, follows the
# Active account exactly like a plain pane. This rcfile replaced ~/.bashrc
# on the command line, so the user's own rc is sourced here.
if [ "$SPARK_NO_SHELL_INTEGRATION" = "1" ]; then
  if [ -z "$__SPARK_HOOKS_LOADED" ] && [ "${SPARK_FOLLOW_ACTIVE_ACCOUNT-}" = "1" ]; then
    __SPARK_HOOKS_LOADED=1
    [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"
    case ":${PROMPT_COMMAND:-}:" in
      *":_spark_follow_active_account:"*) ;;
      *) PROMPT_COMMAND="_spark_follow_active_account${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
    esac
    _spark_follow_active_account
  fi
fi

if [ -z "$__SPARK_HOOKS_LOADED" ] && [ "$SPARK_NO_SHELL_INTEGRATION" != "1" ]; then
  __SPARK_HOOKS_LOADED=1

  [ -f /etc/profile ] && source /etc/profile
  [ -f /etc/bashrc ] && source /etc/bashrc
  if [ -f "$HOME/.bash_profile" ]; then
    source "$HOME/.bash_profile"
  elif [ -f "$HOME/.bash_login" ]; then
    source "$HOME/.bash_login"
  elif [ -f "$HOME/.profile" ]; then
    source "$HOME/.profile"
  fi
  # .bashrc may have been sourced already by .bash_profile; sourcing again is
  # safe for idempotent rc files (the common case). If yours has side effects
  # on reload, guard with a flag.
  [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"

  _spark_urlencode() {
    local LC_ALL=C s="$1" i c
    for (( i=0; i<${#s}; i++ )); do
      c="${s:i:1}"
      case "$c" in
        [a-zA-Z0-9/._~-]) printf '%s' "$c" ;;
        *) printf '%%%02X' "'$c" ;;
      esac
    done
  }

  _spark_precmd() {
    local _spark_ret=$?
    _spark_follow_active_account
    printf '\e]133;D;%s\e\\' "$_spark_ret"
    printf '\e]7;file://%s%s\e\\' "${HOSTNAME:-$(uname -n 2>/dev/null)}" "$(_spark_urlencode "$PWD")"
    if [ -z "$__SPARK_PS1_INJECTED" ]; then
      PS1='\[\e]133;B\e\\\]'"$PS1"
      __SPARK_PS1_INJECTED=1
    fi
    printf '\e]133;A\e\\'
  }

  case ":${PROMPT_COMMAND:-}:" in
    *":_spark_precmd:"*) ;;
    *) PROMPT_COMMAND="_spark_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac

  # Pre-exec marker via PS0 (bash 4.4+). PS0 is expanded just before a command
  # runs, cleaner than a DEBUG trap, which would clobber user traps and fire
  # on every command including inside PROMPT_COMMAND.
  if [ "${BASH_VERSINFO[0]:-0}" -gt 4 ] \
     || { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 4 ]; }; then
    PS0='\[\e]133;C\e\\\]'"${PS0:-}"
  fi

  # spark_open: open file in editor tab via OSC 8888.
  # Usage: spark_open <file>
  spark_open() {
    local file="$1"

    if [ -z "$file" ]; then
      printf "usage: spark_open <file>\n" >&2
      return 1
    fi

    # Resolve relative paths relative to PWD.
    if [[ "$file" != /* ]]; then
      file="$PWD/$file"
    fi

    # Check that the path exists and is a regular file.
    if [ ! -f "$file" ]; then
      printf "spark_open: not a file: %s\n" "$file" >&2
      return 1
    fi

    # Emit OSC 8888 with URL-encoded file path.
    printf '\e]8888;file=%s\e\\' "$(_spark_urlencode "$file")"
  }

  # Shorthand alias.
  alias tp='spark_open'

  _spark_precmd
fi

# A `claude` or `codex` typed in a Codara pane gets Codara's hooks, MCP
# server and Codex notify as flags read from $SPARK_AGENT_ARGS_DIR (one
# argument per line, data that is never evaluated), so nothing is written
# to the user's own CLI config. Defined after the user's rc files, and only
# when Codara set that folder and the user has no function of that name. An
# alias such as `claude='claude --verbose'` still reaches the function, since
# its expansion starts with that word; the `function` keyword keeps the alias
# from being expanded in the definition itself. Management subcommands and a
# missing file run the CLI untouched. A
# `--settings` of the user's keeps Codara's out (Claude honors only the last
# one), and `--strict-mcp-config` keeps Codara's server out of that strict
# set. bash 3.2 safe: an empty array is expanded with the `+` guard.
_spark_agent_exec() {
  local cli="$1" file line arg own_settings=0 strict=0 skip=0
  shift
  local -a extra=()
  case "$cli:${1-}" in
    claude:auth|claude:mcp|claude:config|claude:doctor|claude:update|claude:upgrade|claude:install|claude:setup-token|claude:plugin|claude:plugins|claude:migrate-installer|\
    claude:agents|claude:attach|claude:logs|claude:rm|claude:stop|claude:kill|claude:respawn|claude:purge|claude:auto-mode|claude:import|claude:gateway|claude:ultrareview|\
    claude:-v|claude:--version|claude:-h|claude:--help|\
    grok:agent|grok:clone|grok:completions|grok:cursor-worker|grok:dashboard|grok:doctor|grok:du|grok:disk-usage|grok:export|grok:help|grok:inspect|grok:leader|grok:login|grok:logout|grok:mcp|grok:memory|grok:models|grok:plugin|grok:sessions|grok:setup|grok:trace|grok:update|grok:usage|grok:version|grok:v|grok:worktree|grok:wrap|grok:-h|grok:--help|grok:-V|grok:--version|\
    pi:-h|pi:--help|pi:-v|pi:--version|pi:[!-]*|\
    codex:login|codex:logout|codex:mcp|codex:completion|codex:update|codex:doctor|codex:sandbox|codex:debug|codex:apply|codex:plugin|codex:app-server|codex:remote-control|codex:agents|codex:--version|codex:-V|codex:--help|codex:-h)
      command "$cli" "$@"
      return ;;
  esac
  file="${SPARK_AGENT_ARGS_DIR-}/$cli/args.txt"
  if [ -n "${SPARK_AGENT_ARGS_DIR-}" ] && [ -r "$file" ]; then
    for arg in "$@"; do
      case "$arg" in
        --settings|--settings=*) own_settings=1 ;;
        --strict-mcp-config) strict=1 ;;
      esac
    done
    {
      while IFS= read -r line || [ -n "$line" ]; do
        if [ "$skip" = 1 ]; then skip=0; continue; fi
        if [ "$line" = "--settings" ] && [ "$own_settings" = 1 ]; then skip=1; continue; fi
        case "$line" in --mcp-config=*) [ "$strict" = 1 ] && continue ;; esac
        extra+=("$line")
      done < "$file"
    } 2>/dev/null
  fi
  command "$cli" ${extra[@]+"${extra[@]}"} "$@"
}

if [ -n "${SPARK_AGENT_ARGS_DIR-}" ]; then
  if ! declare -F claude >/dev/null 2>&1; then
    function claude { _spark_agent_exec claude "$@"; }
  fi
  if ! declare -F codex >/dev/null 2>&1; then
    function codex { _spark_agent_exec codex "$@"; }
  fi
  # grok and pi get only the flags set in Settings > Accounts > Startup flags.
  if ! declare -F grok >/dev/null 2>&1; then
    function grok { _spark_agent_exec grok "$@"; }
  fi
  if ! declare -F pi >/dev/null 2>&1; then
    function pi { _spark_agent_exec pi "$@"; }
  fi
fi

# Follow the pointer right before a command runs. bash has no preexec;
# PS0 expands in a subshell (cannot export) so a DEBUG trap is the only
# hook that runs in the shell before the fork. An existing DEBUG trap (a
# user's bash-preexec, iTerm2 or Starship integration) is chained after
# ours, never replaced: `trap -p` prints it as a reusable trap command and
# the body is unquoted with builtin expansions only. Ours passes "$_" as its
# last argument, so the chained body still reads the user's $_ (bash-preexec
# does), and the chained body runs last, so its status is the trap's.
# Without functrace the trap never fires inside functions, so the hook
# itself stays cheap.
#
# The trap is only ever set at top level, here and from PROMPT_COMMAND: when
# a DEBUG trap is already set, bash saves it on function entry and restores
# it on return, so a `trap` issued inside a function can be silently
# discarded.
_spark_follow_trap_hit() {
  __SPARK_FOLLOW_TRAP_HIT=1
  _spark_follow_active_account
}

# The trap command body that puts the hook in front of the trap `trap -p
# DEBUG` printed ($1), in __SPARK_FOLLOW_TRAP; empty when it is there already.
_spark_follow_trap_for() {
  local body="" q="'" esc="'\\''"
  if [ -n "${1-}" ]; then
    body="${1#trap -- $q}"
    body="${body%$q DEBUG}"
    body="${body//"$esc"/$q}"
  fi
  case "$body" in
    *_spark_follow_trap_hit*) __SPARK_FOLLOW_TRAP="" ;;
    *) __SPARK_FOLLOW_TRAP="_spark_follow_trap_hit \"\$_\"${body:+;$body}" ;;
  esac
}

# bash-preexec (loaded by WezTerm, iTerm2 and Atuin) installs at the first
# prompt, after this file ran, and replaces the DEBUG trap with its own; the
# switch would then reach a command only after its prompt, one command late.
# The last PROMPT_COMMAND entry clears the hit mark and the DEBUG trap fires
# before the test that follows, so a mark still clear means another hook
# owns the trap. Only then does the entry pay a fork to read and re-chain it.
# `trap -p` is read at top level because inside a function it prints nothing.
if [ "${SPARK_FOLLOW_ACTIVE_ACCOUNT-}" = "1" ]; then
  _spark_follow_trap_for "$(trap -p DEBUG)"
  [ -n "$__SPARK_FOLLOW_TRAP" ] && trap -- "$__SPARK_FOLLOW_TRAP" DEBUG
  case "${PROMPT_COMMAND:-}" in
    *__SPARK_FOLLOW_TRAP_HIT=*) ;;
    *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND
}__SPARK_FOLLOW_TRAP_HIT=; [ -n \"\$__SPARK_FOLLOW_TRAP_HIT\" ] || { _spark_follow_trap_for \"\$(trap -p DEBUG)\"; [ -n \"\$__SPARK_FOLLOW_TRAP\" ] && trap -- \"\$__SPARK_FOLLOW_TRAP\" DEBUG; }" ;;
  esac
fi
:
