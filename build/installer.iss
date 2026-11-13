; DiskJanitor 安装脚本(按用户级安装,无需管理员;适配 EnableLUA=0 环境)
; 编译:ISCC.exe build\installer.iss

#define AppName "DiskJanitor"
#define AppDispName "磁盘清道夫 DiskJanitor"
#define AppVersion "0.1.0"
#define AppPublisher "KTEC"

[Setup]
AppId={{7C1D4E90-6B3A-4F5D-9E28-DISKJANITOR1}}
AppName={#AppDispName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\DiskJanitor
PrivilegesRequired=lowest
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\DiskJanitor.exe
OutputDir=..\dist
OutputBaseFilename=DiskJanitor-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallFilesDir={localappdata}\Programs\DiskJanitor\unins

[Files]
Source: "..\dist\win-unpacked\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{userprograms}\{#AppDispName}"; Filename: "{app}\DiskJanitor.exe"
Name: "{userdesktop}\磁盘清道夫"; Filename: "{app}\DiskJanitor.exe"; IconFilename: "{app}\DiskJanitor.exe"

[Run]
Filename: "{app}\DiskJanitor.exe"; Description: "启动 {#AppDispName}"; Flags: nowait postinstall skipifsilent

[Code]
// 卸载尾声:询问是否清空各盘 staging(默认保留,防止未恢复的清理项丢失)
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    if MsgBox('是否同时清空各磁盘的 DiskJanitorStaging 暂存区? 保留则未撤销的清理项之后仍可找回。', mbConfirmation, MB_YESNO) = IDYES then
    begin
      DelTree('C:\DiskJanitorStaging', True, True, True);
      DelTree('D:\DiskJanitorStaging', True, True, True);
      DelTree('E:\DiskJanitorStaging', True, True, True);
      DelTree('F:\DiskJanitorStaging', True, True, True);
      DelTree('G:\DiskJanitorStaging', True, True, True);
      DelTree('H:\DiskJanitorStaging', True, True, True);
    end;
end;
