# Codara shell integration for PowerShell.
#
# Emits FinalTerm OSC 133 + VS Code OSC 633 boundary markers around each
# prompt and command so the renderer can group output into per-command
# blocks. Implemented from the public OSC 133 / 633 specs — see
# https://code.visualstudio.com/docs/terminal/shell-integration for the
# wire format.
#
# Sequences emitted:
#   OSC 633 ; A ST                  prompt start
#   OSC 633 ; B ST                  prompt end
#   OSC 633 ; E ; <commandline> ST  explicit commandline (escaped)
#   OSC 633 ; C ST                  pre-execution
#   OSC 633 ; D ; <exitcode> ST     execution finished
#   OSC 633 ; P ; Cwd=<path> ST     property: cwd
#
# OSC = ESC ]   ST = BEL (0x07)

# Worker sessions (Claude / Codex hosted in pwsh) set this var so the
# integration is skipped — its OSC writes confuse Ink-based TUIs and the
# PSReadLine key hook can desync the cursor before claude takes over.
if ($env:SPARK_NO_SHELL_INTEGRATION -eq '1') { return }
if ($env:SPARK_SHELL_INTEGRATION_LOADED -eq '1') { return }
$env:SPARK_SHELL_INTEGRATION_LOADED = '1'

$Global:__SparkPromptStarted = $false
$Global:__SparkOriginalPrompt = $function:Prompt
$Global:__SparkLastHistoryId = 0

function Global:__Spark-Esc {
    param([string]$value)
    if ($null -eq $value) { return '' }
    $sb = [System.Text.StringBuilder]::new($value.Length)
    foreach ($ch in $value.ToCharArray()) {
        $code = [int]$ch
        if ($code -lt 0x20 -or $ch -eq ';' -or $ch -eq '\') {
            [void]$sb.AppendFormat('\x{0:X2}', $code)
        } else {
            [void]$sb.Append($ch)
        }
    }
    return $sb.ToString()
}

function Global:__Spark-Osc {
    param([string]$payload)
    return ([char]27 + ']' + $payload + [char]7)
}

# URL-encode a UTF-8 string so multi-byte paths stay valid in the `file://`
# URI emitted via OSC 7. Spec-correct (unreserved chars + slash kept as-is).
function Global:__Spark-UrlEncode {
    param([string]$s)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($s)
    $sb = [System.Text.StringBuilder]::new($bytes.Length)
    foreach ($b in $bytes) {
        if (($b -ge 0x30 -and $b -le 0x39) -or
            ($b -ge 0x41 -and $b -le 0x5A) -or
            ($b -ge 0x61 -and $b -le 0x7A) -or
            $b -eq 0x2F -or $b -eq 0x2E -or $b -eq 0x5F -or
            $b -eq 0x7E -or $b -eq 0x2D) {
            [void]$sb.Append([char]$b)
        } else {
            [void]$sb.AppendFormat('%{0:X2}', $b)
        }
    }
    $sb.ToString()
}

# spark_open: open file in editor tab via OSC 8888.
# Usage: spark_open <file>
function Global:spark_open {
    param([Parameter(Mandatory)][string]$file)
    if (-not $file) {
        Write-Error 'usage: spark_open <file>'
        return
    }
    if (-not [System.IO.Path]::IsPathRooted($file)) {
        $file = Join-Path (Get-Location).Path $file
    }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        Write-Error "spark_open: not a file: $file"
        return
    }
    $encoded = __Spark-UrlEncode $file
    [Console]::Write((__Spark-Osc "8888;file=$encoded"))
}

Set-Alias -Name tp -Value spark_open -Scope Global -ErrorAction SilentlyContinue

# Follow the Active account. A plain user pane carries
# SPARK_FOLLOW_ACTIVE_ACCOUNT=1 and main rewrites
# $env:SPARK_HOME_DIR\shell\active-cli-env on every account switch. The file
# is data, never dot-sourced or invoked: only CLAUDE_CONFIG_DIR and GROK_HOME
# lines whose value sits under this Codara home's managed accounts root are
# honored, and a variable is only ever written when it is unset or itself
# inside that root (a value the user set elsewhere is never touched). Cost per
# prompt is one read of the header line; an unchanged revision returns before
# anything else is parsed. Every failure (missing file, unreadable, bad
# header) is silent and leaves the environment alone.
function Global:__Spark-FollowVar {
    param([string]$name, [string]$root, [string]$target, [System.StringComparison]$cmp)
    $current = [System.Environment]::GetEnvironmentVariable($name)
    if ($current -and -not $current.StartsWith($root, $cmp)) { return }
    if ($target) {
        if ($current -ne $target) { [System.Environment]::SetEnvironmentVariable($name, $target) }
    } elseif ($current) {
        [System.Environment]::SetEnvironmentVariable($name, $null)
    }
}

function Global:__Spark-FollowActiveAccount {
    if ($env:SPARK_FOLLOW_ACTIVE_ACCOUNT -ne '1') { return }
    try {
        $sparkHome = $env:SPARK_HOME_DIR
        if (-not $sparkHome) { $sparkHome = Join-Path $HOME '.codarastudio' }
        $file = Join-Path (Join-Path $sparkHome 'shell') 'active-cli-env'
        $header = Get-Content -LiteralPath $file -TotalCount 1 -ErrorAction SilentlyContinue
        if (-not $header) { return }
        $parts = ([string]$header) -split ' '
        if ($parts.Length -lt 3 -or $parts[0] -ne 'codara-active-cli-env' -or -not $parts[2]) { return }
        $rev = $parts[2]
        if ($rev -eq $Global:__SparkActiveEnvRev) { return }
        $lines = Get-Content -LiteralPath $file -ErrorAction SilentlyContinue
        if ($null -eq $lines) { return }
        $sep = [System.IO.Path]::DirectorySeparatorChar
        # Windows paths compare case-insensitively; elsewhere the prefix
        # rule is byte-exact like the bash and zsh hooks.
        $cmp = if ($sep -eq '\') { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
        $claudeRoot = (Join-Path (Join-Path $sparkHome 'claude-cli') 'accounts') + $sep
        $grokRoot = (Join-Path (Join-Path $sparkHome 'grok-cli') 'accounts') + $sep
        $claude = ''
        $grok = ''
        foreach ($line in @($lines)) {
            $text = [string]$line
            $eq = $text.IndexOf('=')
            if ($eq -lt 1) { continue }
            $key = $text.Substring(0, $eq)
            $value = $text.Substring($eq + 1)
            if ($key -ne 'CLAUDE_CONFIG_DIR' -and $key -ne 'GROK_HOME') { continue }
            if ($value -match '[\x00-\x1f\x7f]' -or $value -match '(^|[\\/])\.\.([\\/]|$)') { continue }
            if ($key -eq 'CLAUDE_CONFIG_DIR') {
                if ($value.Length -gt $claudeRoot.Length -and $value.StartsWith($claudeRoot, $cmp)) { $claude = $value }
            } else {
                if ($value.Length -gt $grokRoot.Length -and $value.StartsWith($grokRoot, $cmp)) { $grok = $value }
            }
        }
        __Spark-FollowVar 'CLAUDE_CONFIG_DIR' $claudeRoot $claude $cmp
        __Spark-FollowVar 'GROK_HOME' $grokRoot $grok $cmp
        $Global:__SparkActiveEnvRev = $rev
    } catch {
        # Silent by contract: the environment is left alone.
    }
}

function Global:Prompt {
    $exit = $LASTEXITCODE
    if ($null -eq $exit) { $exit = if ($?) { 0 } else { 1 } }

    __Spark-FollowActiveAccount

    $out = ''

    # We emit C live (on Enter, see PSReadLine hook below). If a TUI ate the
    # whole turn without ever yielding C — e.g. shell crash, Ctrl-C before
    # exec — fall back to the retroactive E+C path so the block still closes.
    if ($Global:__SparkPromptStarted) {
        if (-not $Global:__SparkCommandRunning) {
            $hist = Get-History -Count 1
            if ($hist -and $hist.Id -ne $Global:__SparkLastHistoryId) {
                $Global:__SparkLastHistoryId = $hist.Id
                $out += __Spark-Osc ('633;E;' + (__Spark-Esc $hist.CommandLine))
                $out += __Spark-Osc '633;C'
            }
        }
        $out += __Spark-Osc "633;D;$exit"
    }
    $Global:__SparkCommandRunning = $false

    $loc = Get-Location
    if ($loc -and $loc.Provider.Name -eq 'FileSystem') {
        $cwd = $loc.ProviderPath
        $out += __Spark-Osc ('633;P;Cwd=' + (__Spark-Esc $cwd))
        # OSC 7: classic cwd reporting consumed by VS Code, iTerm2, kitty,
        # and the Codara renderer's TerminalStrip. Forward-slashed and
        # leading-slashed for Windows so the URL parses as a real `file://`.
        $cwdNorm = $cwd -replace '\\','/'
        if ($cwdNorm -match '^[A-Za-z]:') { $cwdNorm = "/$cwdNorm" }
        $hostName = [System.Environment]::MachineName
        $out += __Spark-Osc ("7;file://$hostName" + (__Spark-UrlEncode $cwdNorm))
    }

    $out += __Spark-Osc '633;A'
    # Emit FinalTerm OSC 133 ; A so the strip's prompt-marker tracker can
    # land an inline marker. VS Code's 633 is a superset, but the strip's
    # generic OSC 7/133/8888 module also listens to plain 133.
    $out += __Spark-Osc '133;A'

    try {
        $out += & $Global:__SparkOriginalPrompt
    } catch {
        $out += "PS $cwd> "
    }

    $out += __Spark-Osc '633;B'
    $Global:__SparkPromptStarted = $true
    return $out
}

# Hook Enter so OSC 633;C fires the moment the user submits — *before* the
# command starts producing output. Without this, claude/codex run for minutes
# without the renderer knowing the pane is busy, because the next Prompt
# (which emits C retroactively) only fires once the TUI exits.
#
# We don't replace PSReadLine's AcceptLine logic; we just emit the markers
# straight to the host's RawUI BEFORE forwarding to the original handler.
# That keeps PSReadLine's cursor/selection bookkeeping intact, which is what
# previously broke when the integration tried to fully take over Enter.
if (Get-Module -ListAvailable PSReadLine) {
    Import-Module PSReadLine -ErrorAction SilentlyContinue
    # Disable inline prediction (gray-text autocomplete). PredictionSource was
    # added in PSReadLine 2.1; on Windows PowerShell 5.1 the bundled module is
    # often 2.0, where the parameter doesn't exist and -ErrorAction can't
    # suppress the binding error. Probe the cmdlet first so older hosts stay
    # silent.
    $__sparkPsrCmd = Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue
    if ($__sparkPsrCmd -and $__sparkPsrCmd.Parameters.ContainsKey('PredictionSource')) {
        Set-PSReadLineOption -PredictionSource None -ErrorAction SilentlyContinue
    }
    if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {
        $Global:__SparkAcceptLine = {
            param($key, $arg)
            $line = $null
            $cursor = $null
            [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
            $marker = (__Spark-Osc ('633;E;' + (__Spark-Esc $line))) + (__Spark-Osc '633;C')
            [Console]::Write($marker)
            $Global:__SparkCommandRunning = $true
            [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine($key, $arg)
        }
        Set-PSReadLineKeyHandler -Key Enter -ScriptBlock $Global:__SparkAcceptLine
        Set-PSReadLineKeyHandler -Key Ctrl+m -ScriptBlock $Global:__SparkAcceptLine
    }
}
