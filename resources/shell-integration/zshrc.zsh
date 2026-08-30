# spark-shell-integration (zshrc)
#
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D (prompt-start / prompt-end / pre-exec /
# command-done-with-exit-code) + OSC 633;E (escaped command line) so the host
# can detect command boundaries, identify `claude`/`codex` launches, and
# track cwd without re-parsing the prompt. `status` is a read-only special in
# zsh, so we shadow $? into `_spark_ret`.

{
  _spark_user_zdotdir="${SPARK_USER_ZDOTDIR:-$HOME}"
  [ -f "$_spark_user_zdotdir/.zshrc" ] && source "$_spark_user_zdotdir/.zshrc"
  unset _spark_user_zdotdir
}

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
# environment alone. Builtins only, no subshell.
#
# Runs from precmd AND preexec. precmd alone is too late for the common
# case: the prompt is already drawn when the user switches accounts in
# Settings, so a `claude` typed next would still start under the old
# selector and only the command after it would follow. preexec runs in the
# shell right before the fork, so the switch lands on that very command.
_spark_follow_active_account() {
  emulate -L zsh
  [[ "$SPARK_FOLLOW_ACTIVE_ACCOUNT" = "1" ]] || return 0
  local spark_home="${SPARK_HOME_DIR:-$HOME/.codarastudio}"
  local file="$spark_home/shell/active-cli-env"
  local word version rev
  { IFS=' ' read -r word version rev < "$file"; } 2>/dev/null || return 0
  [[ "$word" = "codara-active-cli-env" ]] || return 0
  [[ -n "$rev" ]] || return 0
  [[ "$rev" = "$__SPARK_ACTIVE_ENV_REV" ]] && return 0
  local claude_root="$spark_home/claude-cli/accounts/"
  local grok_root="$spark_home/grok-cli/accounts/"
  local line value claude="" grok=""
  {
    while IFS= read -r line || [[ -n "$line" ]]; do
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
  emulate -L zsh
  local name="$1" root="$2" target="$3" current
  current="${(P)name}"
  if [[ -n "$current" ]]; then
    case "$current" in
      "$root"*) ;;
      *) return 0 ;;
    esac
  fi
  if [[ -n "$target" ]]; then
    [[ "$current" = "$target" ]] || export "$name=$target"
  elif [[ -n "$current" ]]; then
    unset "$name"
  fi
}

# Worker and agent sessions (Claude / Codex hosted in zsh) set this var so
# the prompt integration is skipped: its OSC writes confuse Ink-based TUIs
# that take over the alternate screen. The account-follow hook writes
# nothing to the terminal, so a pane that carries the follow flag still
# installs it: an agent pane's shell (the one left after `claude` exits)
# follows the Active account exactly like a plain pane.
if [[ "$SPARK_NO_SHELL_INTEGRATION" = "1" ]]; then
  if [[ -z "$__SPARK_HOOKS_LOADED" && "$SPARK_FOLLOW_ACTIVE_ACCOUNT" = "1" ]]; then
    __SPARK_HOOKS_LOADED=1
    autoload -Uz add-zsh-hook 2>/dev/null
    if (( $+functions[add-zsh-hook] )); then
      add-zsh-hook precmd _spark_follow_active_account
      add-zsh-hook preexec _spark_follow_active_account
    fi
    _spark_follow_active_account
  fi
  return 0 2>/dev/null
fi

# Re-source guard within a single shell (e.g. user runs `source ~/.zshrc`).
# This is NOT exported, so each nested zsh installs its own hooks; desired,
# since every interactive shell needs its own prompt integration.
if [[ -z "$__SPARK_HOOKS_LOADED" ]]; then
  __SPARK_HOOKS_LOADED=1
  autoload -Uz add-zsh-hook 2>/dev/null

  # URL-encode $PWD byte-wise so multi-byte paths stay valid in the `file://`
  # URI emitted via OSC 7. `no_multibyte` forces ${s[i]} to index bytes (not
  # code points), and LC_ALL=C keeps the [a-zA-Z0-9...] class single-byte.
  _spark_urlencode() {
    emulate -L zsh
    setopt localoptions no_multibyte
    local LC_ALL=C s="$1" i byte
    for (( i=1; i<=${#s}; i++ )); do
      byte="${s[i]}"
      case "$byte" in
        [a-zA-Z0-9/._~-]) printf '%s' "$byte" ;;
        *) printf '%%%02X' "'$byte" ;;
      esac
    done
  }

  _spark_precmd() {
    local _spark_ret=$?
    _spark_follow_active_account
    printf '\e]133;D;%s\e\\' "$_spark_ret"
    printf '\e]7;file://%s%s\e\\' "${HOST}" "$(_spark_urlencode "$PWD")"
    # Re-inject prompt-end marker in case a framework rebuilt PS1 (p10k, starship).
    if [[ "$PS1" != *$'\e]133;B\e\\'* ]]; then
      PS1=$'%{\e]133;B\e\\%}'"$PS1"
    fi
    printf '\e]133;A\e\\'
  }

  _spark_osc633_esc() {
    emulate -L zsh
    setopt localoptions no_multibyte
    local LC_ALL=C s="$1" i byte
    for (( i=1; i<=${#s}; i++ )); do
      byte="${s[i]}"
      case "$byte" in
        [\;\\]|[[:cntrl:]]) printf '\\x%02X' "'$byte" ;;
        *) printf '%s' "$byte" ;;
      esac
    done
  }

  _spark_preexec() {
    _spark_follow_active_account
    printf '\e]633;E;%s\e\\' "$(_spark_osc633_esc "$1")"
    printf '\e]133;C\e\\'
  }

  if (( $+functions[add-zsh-hook] )); then
    add-zsh-hook precmd _spark_precmd
    add-zsh-hook preexec _spark_preexec
  fi

  # spark_open: open file in editor tab via OSC 8888.
  # Usage: spark_open <file>
  spark_open() {
    local file="$1"

    if [[ -z "$file" ]]; then
      printf "usage: spark_open <file>\n" >&2
      return 1
    fi

    # Resolve relative paths relative to PWD.
    if [[ "$file" != /* ]]; then
      file="$PWD/$file"
    fi

    # Check that the path exists and is a regular file.
    if [[ ! -f "$file" ]]; then
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
:
