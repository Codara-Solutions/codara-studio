; Codara Studio: additions to the Windows uninstaller (package.json build.nsis.include).
;
; Before the app's files go, take claude-follow's line out of the user's shell
; startup files (src/main/claude-follow/uninstall-entry.ts), so a plain
; `claude` typed in another terminal is exactly as it was before Codara.
; The script runs through the app's own executable as plain Node, hidden, and
; always exits 0, so it can never block the uninstall.
;
; Never for an update: electron-updater runs the old uninstaller on its way to
; the new version, which keeps the line, and the line must not blink out.
!macro customUnInstall
  ${ifNot} ${isUpdated}
  ${AndIf} ${FileExists} "$INSTDIR\resources\app.asar.unpacked\out\main\claude-follow-uninstall.js"
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")i'
    nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\app.asar.unpacked\out\main\claude-follow-uninstall.js"'
    Pop $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", n)i'
  ${endIf}
!macroend
