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
