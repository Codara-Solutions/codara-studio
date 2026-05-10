# spark-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _spark_user_zdotdir="${SPARK_USER_ZDOTDIR:-$HOME}"
  [ -f "$_spark_user_zdotdir/.zprofile" ] && source "$_spark_user_zdotdir/.zprofile"
  unset _spark_user_zdotdir
}
:
