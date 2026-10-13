' הפעלת מערכת אמא במשמרת (משימות + קמפיין המכירה הסינית) + פתיחת הדפדפן, בלי חלון שחור
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)

On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://localhost:3900/api/integration/health", False
http.Send
alreadyRunning = (Err.Number = 0 And http.Status = 200)
On Error GoTo 0

If Not alreadyRunning Then
  shell.CurrentDirectory = appDir
  shell.Run "cmd /c set PORT=3900&& node server.js", 0, False
  WScript.Sleep 2500
End If

shell.Run "http://localhost:3900"
