# Claude Code status line command that feeds PawGauge's Claude row (Windows, no Node.js needed).
# Claude Code pipes a JSON document to the status line on stdin; on a Claude plan it contains `rate_limits`
# (five_hour / seven_day, each with used_percentage and resets_at). This saves that part to
# %USERPROFILE%\.claude\usage-snapshot.json, which PawGauge reads, and prints a one-line summary as the status line.
# It reads nothing else and sends nothing anywhere. Same behaviour as statusline-snapshot.js. Keep this file ASCII:
# Windows PowerShell 5.1 reads a script without a byte-order mark as ANSI.
$ErrorActionPreference = 'Stop'
try {
  $utf8 = New-Object Text.UTF8Encoding $false
  $raw = (New-Object IO.StreamReader ([Console]::OpenStandardInput()), $utf8).ReadToEnd()
  $rl = ($raw | ConvertFrom-Json).rate_limits
  if ($null -eq $rl) { exit 0 }  # other backends carry no rate_limits: leave the last snapshot alone
  try {
    # Always ~/.claude, even when CLAUDE_CONFIG_DIR moves the settings: the app is not started from your shell, so a
    # fixed place is the one both sides are sure to agree on.
    $dir = [IO.Path]::Combine($env:USERPROFILE, '.claude')
    [void][IO.Directory]::CreateDirectory($dir)
    $out = [IO.Path]::Combine($dir, 'usage-snapshot.json')
    # Claude Code cancels a run that is still going when a new update arrives, which can strand a temporary file.
    foreach ($old in [IO.Directory]::GetFiles($dir, 'usage-snapshot.json.*.tmp')) {
      try { if ([IO.File]::GetLastWriteTimeUtc($old) -lt [DateTime]::UtcNow.AddMinutes(-1)) { [IO.File]::Delete($old) } } catch { }
    }
    $tmp = "$out.$PID.tmp"
    $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    [IO.File]::WriteAllText($tmp, '{"updatedAt":' + $ms + ',"rate_limits":' + (ConvertTo-Json -InputObject $rl -Compress -Depth 5) + '}', $utf8)
    # Swapped in one step, so PawGauge never reads half a file.
    if ([IO.File]::Exists($out)) { [IO.File]::Replace($tmp, $out, [NullString]::Value) } else { [IO.File]::Move($tmp, $out) }
  } catch { }  # the status line must never fail
  $text = foreach ($w in @($rl.five_hour, $rl.seven_day)) {
    if ($null -ne $w.used_percentage) { '{0}%' -f [math]::Floor([double]$w.used_percentage + 0.5) } else { '--' }
  }
  $bytes = $utf8.GetBytes('5h ' + $text[0] + ' ' + [char]0x00B7 + ' week ' + $text[1])
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
} catch { }  # not JSON: print nothing
exit 0
