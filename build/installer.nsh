!macro preInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $0 == ""
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$APPDATA\Programs\lynapp"
  ${EndIf}
!macroend

Function .onVerifyInstDir
  StrCmp $INSTDIR "$APPDATA\lynapp" 0 done
  MessageBox MB_OK|MB_ICONSTOP "lynapp cannot be installed into its data folder:$\n$APPDATA\lynapp$\n$\nThat folder is reserved for instances and saves. Please choose another folder, for example $APPDATA\Programs\lynapp."
  Abort
  done:
FunctionEnd

!macro customFinishPage
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "lynappStartApp"
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "lynappCreateDesktopShortcut"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW "lynappFinishShow"
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE "lynappFinishLeave"
  !insertmacro MUI_PAGE_FINISH

  Function lynappStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function lynappFinishShow
    ${If} $LANGUAGE == 1049
      SendMessage $mui.FinishPage.ShowReadme ${WM_SETTEXT} 0 "STR:Создать ярлык на рабочем столе"
    ${EndIf}
    ${If} ${isUpdated}
    ${AndIfNot} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      SendMessage $mui.FinishPage.ShowReadme ${BM_SETCHECK} ${BST_UNCHECKED} 0
    ${EndIf}
  FunctionEnd

  Function lynappCreateDesktopShortcut
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
    System::Call "Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)"
  FunctionEnd

  Function lynappFinishLeave
    SendMessage $mui.FinishPage.ShowReadme ${BM_GETCHECK} 0 0 $0
    ${If} $0 != ${BST_CHECKED}
    ${AndIf} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
      System::Call "Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)"
    ${EndIf}
  FunctionEnd
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ${endIf}
!macroend
