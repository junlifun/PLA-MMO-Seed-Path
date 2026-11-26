#define AppName "PLA MMO Seed & Path"
#define AppVersion "0.9.5"
#define AppPublisher "君粒"
#define AppExeName "PLA-MMO-Seed-Path.exe"
#define SourceDir "..\dist\PLA-MMO-Seed-Path"
#define OutputDir "..\release"
#define AppIcon "..\static\app.ico"

[Setup]
AppId={{B7F2D7A5-3F3D-4E2A-9C8E-6A2B5D9C4E10}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} v{#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\PLA-MMO-Seed-Path
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=PLA-MMO-Seed-Path-{#AppVersion}-Setup
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=PLA MMO Seed & Path Installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "启动 {#AppName}"; Flags: postinstall nowait skipifsilent
