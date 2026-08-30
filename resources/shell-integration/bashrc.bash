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
# data, never sourced or evaluated: only CLAUDE_CONFIG_DIR and GROK_HOME lines
# whose value sits under this Codara home's managed accounts root are
# honored, and a variable is only ever written when it is unset or itself
# inside that root (a value the user exported elsewhere is never touched).
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
  local claude_root="$home/claude-cli/accounts/"
  local grok_root="$home/grok-cli/accounts/"
  local line value claude="" grok=""
  {
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        CLAUDE_CONFIG_DIR=*|GROK_HOME=*) ;;
        *) continue ;;
      esac
      value="${line#*=}"
      case "$value" in
        *[[:cntrl:]]*|*"/../"*|*"/..") continue ;;
      esac
      case "$line" in
        CLAUDE_CONFIG_DIR=*)
          case "$value" in "$claude_root"?*) claude="$value" ;; esac ;;
        GROK_HOME=*)
          case "$value" in "$grok_root"?*) grok="$value" ;; esac ;;
      esac
    done < "$file"
  } 2>/dev/null || return 0
  _spark_follow_var CLAUDE_CONFIG_DIR "$claude_root" "$claude"
  _spark_follow_var GROK_HOME "$grok_root" "$grok"
  __SPARK_ACTIVE_ENV_REV="$rev"
}

# Write one selector: only when the current value is unset, empty, or
# already under the managed root (the spawn-time selector and a previous
# hook write both look like that). An empty target means "personal", so
# the variable is unset rather than exported empty.
_spark_follow_var() {
  local name="$1" root="$2" target="$3" current
  current="${!name-}"
  if [ -n "$current" ]; then
    case "$current" in
      "$root"*) ;;
      *) return 0 ;;
    esac
  fi
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

# Follow the pointer right before a command runs. bash has no preexec;
# PS0 expands in a subshell (cannot export) so a DEBUG trap is the only
# hook that runs in the shell before the fork. An existing DEBUG trap (a
# user's bash-preexec, iTerm2 or Starship integration) is chained after
# ours, never replaced: `trap -p` prints it as a reusable trap command and
# the body is unquoted with builtin expansions only. Without functrace the
# trap never fires inside functions, so the hook itself stays cheap.
#
# Installed at top level on purpose: when a DEBUG trap is already set, bash
# saves it on function entry and restores it on return, so a `trap` issued
# inside a function would be silently discarded.
if [ "${SPARK_FOLLOW_ACTIVE_ACCOUNT-}" = "1" ]; then
  __spark_prev_trap="$(trap -p DEBUG)"
  __spark_trap_body=""
  if [ -n "$__spark_prev_trap" ]; then
    __spark_q="'"
    __spark_esc="'\\''"
    __spark_trap_body="${__spark_prev_trap#trap -- $__spark_q}"
    __spark_trap_body="${__spark_trap_body%$__spark_q DEBUG}"
    __spark_trap_body="${__spark_trap_body//"$__spark_esc"/$__spark_q}"
    unset __spark_q __spark_esc
  fi
  case "$__spark_trap_body" in
    *_spark_follow_active_account*) ;;
    *) trap "_spark_follow_active_account${__spark_trap_body:+;$__spark_trap_body}" DEBUG ;;
  esac
  unset __spark_prev_trap __spark_trap_body
fi
:
