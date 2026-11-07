' Starts the game-sauce launcher without leaving a console window open while you play.
' Windows calls this through the gamesauce:// link (registered by install-windows.bat).
Option Explicit
Dim sh, fso, here, q
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
If WScript.Arguments.Count < 1 Then WScript.Quit 2
' Window style 0 = hidden, False = do not wait (the launcher itself waits for the emulator).
sh.Run q & "node" & q & " " & q & here & "\gamesauce-launcher.mjs" & q & " " & q & WScript.Arguments(0) & q, 0, False
