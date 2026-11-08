# Lets Chrome and Edge open gamesauce:// links from ONE game-sauce address without asking every time.
# Run through allow-in-browser-windows.bat (as administrator). It adds (or with -Remove, takes away) one entry in the
# browsers' AutoLaunchProtocolsFromOrigins policy and keeps any entries that are already there.
# Keep this file plain ASCII: Windows PowerShell 5 reads other text as ANSI.
param(
  [Parameter(Mandatory = $true)][string]$Origin,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'

$u = $null
if (-not [Uri]::TryCreate($Origin.Trim(), [UriKind]::Absolute, [ref]$u) -or
    ($u.Scheme -ne 'http' -and $u.Scheme -ne 'https') -or -not $u.Host) {
  throw 'That is not a web address such as http://192.168.1.50:8765'
}
# scheme://host[:port] with no path: the policy ignores patterns that have a path.
$pattern = $u.GetLeftPart([UriPartial]::Authority)

$name = 'AutoLaunchProtocolsFromOrigins'
$keys = @('HKLM:\SOFTWARE\Policies\Google\Chrome', 'HKLM:\SOFTWARE\Policies\Microsoft\Edge')

foreach ($key in $keys) {
  $current = @()
  if (Test-Path $key) {
    $raw = (Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue).$name
    if ($raw) {
      try { $current = @($raw | ConvertFrom-Json) }
      catch { throw "$key\$name already holds something I cannot read, so I have not changed it." }
    }
  }

  # Keep every other protocol as it is; rebuild only the gamesauce entry.
  $list = @()
  $origins = @()
  foreach ($e in $current) {
    if ($e.protocol -eq 'gamesauce') { $origins += @($e.allowed_origins) } else { $list += $e }
  }
  if ($Remove) { $origins = @($origins | Where-Object { $_ -ne $pattern }) }
  elseif ($origins -notcontains $pattern) { $origins += $pattern }
  if ($origins.Count -gt 0) { $list += [pscustomobject]@{ protocol = 'gamesauce'; allowed_origins = @($origins) } }

  if ($list.Count -eq 0) {
    if (Test-Path $key) { Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue }
  } else {
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    $json = ConvertTo-Json -InputObject @($list) -Depth 5 -Compress
    Set-ItemProperty -Path $key -Name $name -Value $json -Type String
    Write-Host "$key : $json"
  }
}

if ($Remove) { Write-Host "Removed $pattern. Restart the browser." }
else { Write-Host "Allowed gamesauce:// links from $pattern. Restart the browser, then check chrome://policy or edge://policy." }
