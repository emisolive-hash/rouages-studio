@echo off
rem Rouages Studio : double-clic pour ouvrir. Le moteur tourne en arriere-plan, sans fenetre.
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE=%ProgramFiles%\nodejs\node.exe"
  ) else (
    echo.
    echo  Rouages Studio a besoin de Node.js ^(gratuit^) pour fonctionner.
    echo.
    choice /c ON /m "  L'installer maintenant avec winget"
    if errorlevel 2 (
      echo  Installe Node.js LTS depuis https://nodejs.org puis relance ce fichier.
      pause
      exit /b 1
    )
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if not exist "%ProgramFiles%\nodejs\node.exe" (
      echo  L'installation n'a pas abouti. Installe Node.js LTS depuis https://nodejs.org puis relance ce fichier.
      pause
      exit /b 1
    )
    set "NODE=%ProgramFiles%\nodejs\node.exe"
  )
)

rem Si l'application vient de GitHub (ou est rangee dans un depot git), on la met a jour (sans bloquer si internet manque).
if exist "%~dp0.git" git -C "%~dp0." pull --ff-only -q >nul 2>nul
if exist "%~dp0..\..\.git" git -C "%~dp0..\.." pull --rebase --autostash -q >nul 2>nul

rem Module Claude (SDK officiel Anthropic) : installe une seule fois, puis a chaque mise a jour.
set "NPM=npm"
if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM=%ProgramFiles%\nodejs\npm.cmd"
if not exist "%~dp0node_modules\@anthropic-ai\sdk" (
  echo  Installation du module Claude, une seule fois...
  call "%NPM%" install --omit=dev --no-audit --no-fund --loglevel=error
)

rem Raccourci « Rouages Studio » sur le Bureau, cree une seule fois.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $l=Join-Path $d 'Rouages Studio.lnk'; if(-not (Test-Path $l)){ $s=(New-Object -ComObject WScript.Shell).CreateShortcut($l); $s.TargetPath='%~dp0Rouages-Studio.bat'; $s.WorkingDirectory='%~dp0'; $s.IconLocation=\"$env:SystemRoot\System32\imageres.dll,186\"; $s.WindowStyle=7; $s.Save() }" >nul 2>nul

rem Lance le moteur sans fenetre. S'il tourne deja, ca ouvre juste la fenetre.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%NODE%' -ArgumentList 'serveur.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
exit /b 0
