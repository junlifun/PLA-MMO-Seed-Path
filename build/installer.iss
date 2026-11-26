#define AppName "PLA MMO Seed & Path"
#define AppVersion "0.9.9"
#define AppPublisher "君粒"
#define PythonwExe "python\pythonw.exe"

#define SourceDir "..\dist-python\PLA-MMO-Seed-Path"
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
DisableDirPage=auto
UsePreviousAppDir=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=PLA-MMO-Seed-Path-{#AppVersion}-Setup
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\static\app.ico
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
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#PythonwExe}"; Parameters: """{app}\app.py"""; WorkingDir: "{app}"; IconFilename: "{app}\static\app.ico"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#PythonwExe}"; Parameters: """{app}\app.py"""; WorkingDir: "{app}"; IconFilename: "{app}\static\app.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#PythonwExe}"; Parameters: """{app}\app.py"""; WorkingDir: "{app}"; Description: "启动 {#AppName}"; Flags: postinstall nowait skipifsilent

[Code]
var
  RemoveCache: Boolean;
  RemoveLogs: Boolean;
  RemoveSettings: Boolean;
  RemoveUpdates: Boolean;

function InitializeUninstall(): Boolean;
var
  Form: TSetupForm;
  Title: TNewStaticText;
  Note: TNewStaticText;
  CacheBox: TNewCheckBox;
  LogsBox: TNewCheckBox;
  SettingsBox: TNewCheckBox;
  UpdatesBox: TNewCheckBox;
  OKButton: TNewButton;
  CancelButton: TNewButton;
begin
  RemoveCache := True;
  RemoveLogs := True;
  RemoveSettings := False;
  RemoveUpdates := True;
  Result := True;

  Form := CreateCustomForm(ScaleX(600), ScaleY(430), True, True);
  try
    Form.Caption := '卸载 ' + ExpandConstant('{#AppName}');

    Title := TNewStaticText.Create(Form);
    Title.Parent := Form;
    Title.Left := ScaleX(18);
    Title.Top := ScaleY(16);
    Title.Width := Form.ClientWidth - ScaleX(36);
    Title.WordWrap := True;
    Title.Caption := '程序文件会被自动删除。下面这些本地数据可以选择是否一起清理；勾选后会立即删除，无法恢复。';

    CacheBox := TNewCheckBox.Create(Form);
    CacheBox.Parent := Form;
    CacheBox.Left := ScaleX(18);
    CacheBox.Top := ScaleY(72);
    CacheBox.Width := Form.ClientWidth - ScaleX(36);
    CacheBox.Caption := '资源缓存（Pokeldn、求解器、固件、地图、宝可梦图片）';
    CacheBox.Checked := True;

    Note := TNewStaticText.Create(Form);
    Note.Parent := Form;
    Note.Left := ScaleX(40);
    Note.Top := ScaleY(94);
    Note.Width := Form.ClientWidth - ScaleX(58);
    Note.WordWrap := True;
    Note.Caption := ExpandConstant('{app}') + '\cache';

    LogsBox := TNewCheckBox.Create(Form);
    LogsBox.Parent := Form;
    LogsBox.Left := ScaleX(18);
    LogsBox.Top := ScaleY(130);
    LogsBox.Width := Form.ClientWidth - ScaleX(36);
    LogsBox.Caption := '运行日志（runtime_errors.log、app-console.log）';
    LogsBox.Checked := True;

    SettingsBox := TNewCheckBox.Create(Form);
    SettingsBox.Parent := Form;
    SettingsBox.Left := ScaleX(18);
    SettingsBox.Top := ScaleY(174);
    SettingsBox.Width := Form.ClientWidth - ScaleX(36);
    SettingsBox.Caption := '设置、偏好、更新检查记录和 WebView2 窗口缓存';
    SettingsBox.Checked := False;

    Note := TNewStaticText.Create(Form);
    Note.Parent := Form;
    Note.Left := ScaleX(40);
    Note.Top := ScaleY(196);
    Note.Width := Form.ClientWidth - ScaleX(58);
    Note.WordWrap := True;
    Note.Caption := ExpandConstant('{localappdata}') + '\PLA-MMO-Path-Finder';

    UpdatesBox := TNewCheckBox.Create(Form);
    UpdatesBox.Parent := Form;
    UpdatesBox.Left := ScaleX(18);
    UpdatesBox.Top := ScaleY(232);
    UpdatesBox.Width := Form.ClientWidth - ScaleX(36);
    UpdatesBox.Caption := '更新包缓存（cache\updates）';
    UpdatesBox.Checked := True;

    Note := TNewStaticText.Create(Form);
    Note.Parent := Form;
    Note.Left := ScaleX(18);
    Note.Top := ScaleY(274);
    Note.Width := Form.ClientWidth - ScaleX(36);
    Note.WordWrap := True;
    Note.Caption := '自定义图片和地图标注存放在 cache 内；如果你希望保留它们，请取消勾选“资源缓存”。';

    OKButton := TNewButton.Create(Form);
    OKButton.Parent := Form;
    OKButton.Caption := '继续卸载';
    OKButton.ModalResult := mrOk;
    OKButton.Default := True;

    CancelButton := TNewButton.Create(Form);
    CancelButton.Parent := Form;
    CancelButton.Caption := '取消';
    CancelButton.ModalResult := mrCancel;
    CancelButton.Cancel := True;

    OKButton.Width := Form.CalculateButtonWidth([OKButton.Caption, CancelButton.Caption]);
    CancelButton.Width := OKButton.Width;
    OKButton.Left := Form.ClientWidth - ScaleX(18) - OKButton.Width;
    CancelButton.Left := OKButton.Left - ScaleX(8) - CancelButton.Width;
    OKButton.Top := Form.ClientHeight - ScaleY(44);
    CancelButton.Top := OKButton.Top;
    OKButton.Height := ScaleY(26);
    CancelButton.Height := OKButton.Height;

    if Form.ShowModal = mrOk then
    begin
      RemoveCache := CacheBox.Checked;
      RemoveLogs := LogsBox.Checked;
      RemoveSettings := SettingsBox.Checked;
      RemoveUpdates := UpdatesBox.Checked;
    end
    else
    begin
      RemoveCache := False;
      RemoveLogs := False;
      RemoveSettings := False;
      RemoveUpdates := False;
      Result := False;
    end;
  finally
    Form.Free;
  end;
  if not Result then
    Exit;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    SaveStringToFile(ExpandConstant('{app}\.installed'), 'installed', False);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if RemoveUpdates then
      DelTree(ExpandConstant('{app}\cache\updates'), True, True, True);
    if RemoveCache then
      DelTree(ExpandConstant('{app}\cache'), True, True, True);
    if RemoveLogs then
    begin
      DeleteFile(ExpandConstant('{app}\runtime_errors.log'));
      DeleteFile(ExpandConstant('{app}\app-console.log'));
      DeleteFile(ExpandConstant('{app}\offline_engine_setup.log'));
    end;
    if RemoveSettings then
      DelTree(ExpandConstant('{localappdata}\PLA-MMO-Path-Finder'), True, True, True);
  end;
end;
