' PLA MMO Path Finder - single visible-window launcher.
' No console window. Python runs app.py in desktop/webview mode.
Option Explicit
Const EXPECTED_VERSION = "0.9.5"
Dim fso, shell, folder, http, text, pos, start, version
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder

' Do not silently start a second window on another port when an older copy is
' still running: the user would keep looking at the old version.
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://127.0.0.1:5000/api/health", False
http.Send
If Err.Number = 0 And http.Status = 200 Then
    text = http.responseText
    pos = InStr(text, """version"":""")
    If pos > 0 Then
        start = pos + Len("""version"":""")
        version = Mid(text, start, InStr(start, text, """") - start)
    End If
End If
Err.Clear
Set http = Nothing

If Len(version) > 0 Then
    If version = EXPECTED_VERSION Then
        shell.AppActivate "PLA MMO 闪光路径助手"
        WScript.Quit 0
    End If
    MsgBox "An old version (" & version & ") is still running." & vbCrLf & _
           "Close all PLA MMO Path Finder windows, then start again.", 16, "PLA MMO Path Finder"
    WScript.Quit 0
End If

shell.Environment("Process")("PLA_DESKTOP") = "1"
On Error Resume Next
shell.Run "pythonw.exe -u app.py", 1, False
If Err.Number <> 0 Then
    Err.Clear
    shell.Run "pyw.exe -3 -u app.py", 1, False
End If
If Err.Number <> 0 Then
    MsgBox "Python was not found. Install Python 3.10+ and enable Add to PATH.", 16, "PLA MMO Path Finder"
End If
