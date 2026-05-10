# spark-shell-integration (zshenv)
#
# Trailing `:` is load-bearing: without it, a missing user .zshenv leaves $?=1,
# which propagates through the rest of init and ultimately into the first
# prompt's `%?` (rendering robbyrussell's `➜` red on a clean shell start).
{
  _spark_user_zdotdir="${SPARK_USER_ZDOTDIR:-$HOME}"
  [ -f "$_spark_user_zdotdir/.zshenv" ] && source "$_spark_user_zdotdir/.zshenv"
  unset _spark_user_zdotdir
}
:
