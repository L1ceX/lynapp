!macro NSIS_HOOK_PREINSTALL
  StrCmp $INSTDIR "$APPDATA\lynapp" _lynapp_bad_dir
  StrLen $0 "$APPDATA\lynapp\"
  StrCpy $1 $INSTDIR $0
  StrCmp $1 "$APPDATA\lynapp\" _lynapp_bad_dir _lynapp_dir_ok
  _lynapp_bad_dir:
  MessageBox MB_OK|MB_ICONSTOP "lynapp cannot be installed inside its data folder:$\n$APPDATA\lynapp$\n$\nThat folder is reserved for instances and saves. Please choose another folder."
  Abort
  _lynapp_dir_ok:

  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\54ddb8b8-52b5-51a0-9091-ea9539d3fd54" "QuietUninstallString"
  StrCmp $0 "" _lynapp_try_uninst_str
  ExecWait '$0'
  Sleep 1500
  Goto _lynapp_electron_done
  _lynapp_try_uninst_str:
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\54ddb8b8-52b5-51a0-9091-ea9539d3fd54" "UninstallString"
  StrCmp $0 "" _lynapp_electron_done
  ExecWait '$0 /S'
  Sleep 1500
  _lynapp_electron_done:
!macroend
