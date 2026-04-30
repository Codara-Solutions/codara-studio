# Spark Agent shell integration for PowerShell.
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

function Global:Prompt {
    $exit = $LASTEXITCODE
    if ($null -eq $exit) { $exit = if ($?) { 0 } else { 1 } }

    $out = ''

    # Emit E + C + D retroactively for the command that just finished. Reading
    # from Get-History is robust against TUI exits, Ctrl+C, and paste, and
    # avoids hooking PSReadLine's input path (which can desync the cursor and
    # break child TUIs like Claude / Codex).
    if ($Global:__SparkPromptStarted) {
        $hist = Get-History -Count 1
        if ($hist -and $hist.Id -ne $Global:__SparkLastHistoryId) {
            $Global:__SparkLastHistoryId = $hist.Id
            $out += __Spark-Osc ('633;E;' + (__Spark-Esc $hist.CommandLine))
            $out += __Spark-Osc '633;C'
        }
        $out += __Spark-Osc "633;D;$exit"
    }

    $cwd = (Get-Location).Path
    if ($cwd) {
        $out += __Spark-Osc ('633;P;Cwd=' + (__Spark-Esc $cwd))
    }

    $out += __Spark-Osc '633;A'

    try {
        $out += & $Global:__SparkOriginalPrompt
    } catch {
        $out += "PS $cwd> "
    }

    $out += __Spark-Osc '633;B'
    $Global:__SparkPromptStarted = $true
    return $out
}
