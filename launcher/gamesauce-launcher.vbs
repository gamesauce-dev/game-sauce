' Starts the game-sauce launcher without leaving a console window open while you play, and shows a message box
' if the launcher could not start the game (it runs hidden, so otherwise a problem would look like "nothing happened").
' Windows calls this through the gamesauce:// link (registered by install-windows.bat).
Option Explicit
Dim sh, fso, here, q, env, rc, logFile, msg, ts, ln, lastFail
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
If WScript.Arguments.Count < 1 Then WScript.Quit 2

' This script shows the message itself, so the launcher must not also show its own.
Set env = sh.Environment("Process")
env("GAMESAUCE_LAUNCHER_QUIET") = "1"

' Window style 0 = hidden. True = wait until the launcher ends (it ends when the emulator closes).
On Error Resume Next
' Inside the desktop app this folder sits at app\launcher next to the app's own runtime\node.exe: use that one. A launcher copied on its own uses the node on the PATH.
Dim nodeExe
nodeExe = "node"
If fso.FileExists(here & "\..\..\runtime\node.exe") Then nodeExe = fso.GetAbsolutePathName(here & "\..\..\runtime\node.exe")
rc = sh.Run(q & nodeExe & q & " " & q & here & "\gamesauce-launcher.mjs" & q & " " & q & WScript.Arguments(0) & q, 0, True)
If Err.Number <> 0 Then
  MsgBox "Node.js was not found, so the game-sauce launcher could not start." & vbCrLf & vbCrLf & "Install Node.js 18 or newer from https://nodejs.org, then try again.", 48, "game-sauce launcher"
  WScript.Quit 1
End If
On Error GoTo 0

If rc <> 0 Then
  logFile = env("GAMESAUCE_LAUNCHER_LOG")
  If logFile = "" Then logFile = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.gamesauce\launcher.log"
  msg = "The launcher could not start the game."
  lastFail = ""
  If fso.FileExists(logFile) Then
    Set ts = fso.OpenTextFile(logFile, 1)
    Do While Not ts.AtEndOfStream
      ln = ts.ReadLine
      If InStr(ln, "FAILED:") > 0 Then lastFail = Mid(ln, InStr(ln, "FAILED:") + 8)
    Loop
    ts.Close
    If lastFail <> "" Then msg = msg & vbCrLf & vbCrLf & lastFail
  End If
  msg = msg & vbCrLf & vbCrLf & "Log: " & logFile
  MsgBox msg, 48, "game-sauce launcher"
End If
