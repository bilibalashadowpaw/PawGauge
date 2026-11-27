; Uninstalling PawGauge also takes its status line out of Claude Code's settings (only its own entry).
; An update runs the old version's uninstaller with --updated: the setup must survive that.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --remove-statusline'
  ${endIf}
!macroend
