; FrostDance 改名兼容：保留应用标识与 hoyo-auth.exe，接管旧安装位置。
; 不读取、移动或删除账号数据库与应用数据目录。
Var FrostDanceLegacyInstall

!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  StrCpy $FrostDanceLegacyInstall ""
  ReadRegStr $R0 SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $R0 == ""
    ReadRegStr $R1 SHCTX "${MANUKEY}\hoyo-auth" ""
    ${If} $R1 != ""
    ${AndIf} ${FileExists} "$R1\hoyo-auth.exe"
      StrCpy $INSTDIR $R1
      StrCpy $FrostDanceLegacyInstall $R1
    ${EndIf}
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

!macro FrostDanceRenameShortcut PATH
  !insertmacro IsShortcutTarget "${PATH}\hoyo-auth.lnk" "$INSTDIR\hoyo-auth.exe"
  Pop $0
  ${If} $0 = 1
    CreateShortcut "${PATH}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "${PATH}\${PRODUCTNAME}.lnk"
    Delete "${PATH}\hoyo-auth.lnk"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $FrostDanceLegacyInstall != ""
  ${AndIf} $FrostDanceLegacyInstall == $INSTDIR
    Push $0
    !insertmacro FrostDanceRenameShortcut "$SMPROGRAMS"
    !insertmacro FrostDanceRenameShortcut "$DESKTOP"
    ; 新安装器已在同一位置写入新的卸载信息，移除旧名称的重复条目。
    DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\hoyo-auth"
    DeleteRegKey SHCTX "${MANUKEY}\hoyo-auth"
    Pop $0
  ${EndIf}
!macroend
