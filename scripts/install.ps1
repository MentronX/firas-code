# =============================================================================
# Firas Code 2 - installer for Windows (Windows PowerShell 5.1 and PowerShell 7+)
#
#   irm https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.ps1 | iex
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.ps1))) -Code FC2-XXXXX-XXXXX
#
# Options (run with -Help for the list). Every option has an environment twin so the
# plain `| iex` form can use them too: FIRAS_CODE, FIRAS_INSTALL_DIR, FIRAS_INSTALL_ARCHIVE,
# FIRAS_NO_LAUNCH=1, FIRAS_NO_PATH_UPDATE=1, FIRAS_UNINSTALL=1. Also: FIRAS_LANG=en prints English lines
# only, FIRAS_ARABIC=off prints Arabic as plain logical text (for terminals that reorder it themselves).
# Test hooks: FIRAS_NODE_INDEX_URL, FIRAS_NODE_DIST_URL, FIRAS_FORCE_PS_SHIM=1, FIRAS_FORCE_LAUNCH=1,
# FIRAS_TEST_PATH_KEY=<registry key under HKCU used instead of Environment>.
#
# Design decisions (kept here because this file is the only thing a stranger runs):
# * The file is pure ASCII on purpose. A BOM breaks `irm | iex` on Windows PowerShell 5.1, and a file
#   without a BOM is read as ANSI when run from disk. Arabic text is therefore stored as \uXXXX
#   escapes and decoded at run time.
# * No `param()` block: with `| iex` a param block would leak variables into the user's session, and
#   named parameters are not needed. Options are read from $args and the environment instead.
# * Everything lives inside one function, so nothing leaks into the caller's session, and nothing
#   calls `exit` unless the script runs from a file (an `exit` under `iex` would close the window).
# * Only the user PATH is written. No admin rights, no other registry keys, no telemetry.
# * The app is replaced as a whole folder (extract to app.new, rename). Settings and sessions are
#   never inside app\, so updates cannot lose them.
# * Console fonts and terminals draw Arabic one code point per cell, so Arabic lines are joined
#   and reordered here before printing (the app does the same with its own text layer).
# =============================================================================

function Invoke-FirasInstaller {
  param([object[]]$Arguments)

  $ErrorActionPreference = 'Stop'
  Set-StrictMode -Version 2.0
  $ProgressPreference = 'SilentlyContinue'

  $DefaultArchive = 'https://codeload.github.com/MentronX/firas-code/zip/refs/heads/main'
  $DefaultNodeIndex = 'https://nodejs.org/dist/index.json'
  $DefaultNodeDist = 'https://nodejs.org/dist'
  $MinNode = [version]'18.17.0'
  $Slash = [string][IO.Path]::DirectorySeparatorChar

  # --- messages:begin ---
  # Arabic is stored as \uXXXX escapes and decoded below, so this file can stay pure ASCII.
  $ArabicCodes = @{
    title         = '\u062a\u062b\u0628\u064a\u062a \u0641\u0631\u0627\u0633 \u0643\u0648\u062f 2'
    step_node     = '\u0627\u0644\u062a\u062d\u0642\u0642 \u0645\u0646 Node.js'
    node_ok       = 'Node.js \u062c\u0627\u0647\u0632 \u0639\u0644\u0649 \u062c\u0647\u0627\u0632\u0643'
    node_old      = '\u0646\u0633\u062e\u0629 Node.js \u0627\u0644\u0645\u0648\u062c\u0648\u062f\u0629 \u0642\u062f\u064a\u0645\u0629'
    node_get      = '\u0633\u0623\u0646\u0632\u0644 \u0646\u0633\u062e\u0629 Node.js \u062e\u0627\u0635\u0629 \u0628\u0627\u0644\u062a\u0637\u0628\u064a\u0642'
    node_sum      = '\u0623\u062a\u062d\u0642\u0642 \u0645\u0646 \u0633\u0644\u0627\u0645\u0629 \u0627\u0644\u0645\u0644\u0641'
    node_ready    = '\u062a\u0645 \u062a\u062c\u0647\u064a\u0632 Node.js'
    step_app      = '\u062a\u0646\u0632\u064a\u0644 \u0627\u0644\u062a\u0637\u0628\u064a\u0642'
    step_unpack   = '\u0641\u0643 \u0627\u0644\u0636\u063a\u0637 \u0648\u0627\u0644\u062a\u062b\u0628\u064a\u062a'
    step_shims    = '\u0625\u0639\u062f\u0627\u062f \u0627\u0644\u0623\u0645\u0631 firas'
    path_added    = '\u0623\u0636\u0641\u062a \u0623\u0645\u0631 firas \u0625\u0644\u0649 \u0645\u0633\u0627\u0631 \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645'
    path_present  = '\u0627\u0644\u0623\u0645\u0631 firas \u0645\u0636\u0627\u0641 \u0625\u0644\u0649 \u0627\u0644\u0645\u0633\u0627\u0631 \u0645\u0646 \u0642\u0628\u0644'
    path_skipped  = '\u062a\u0631\u0643\u062a \u0627\u0644\u0645\u0633\u0627\u0631 \u0643\u0645\u0627 \u0647\u0648'
    path_hint     = '\u0627\u0641\u062a\u062d \u0646\u0627\u0641\u0630\u0629 \u0637\u0631\u0641\u064a\u0629 \u062c\u062f\u064a\u062f\u0629 \u062b\u0645 \u0627\u0643\u062a\u0628: firas'
    done_new      = '\u062a\u0645 \u0627\u0644\u062a\u062b\u0628\u064a\u062a \u0628\u0646\u062c\u0627\u062d'
    done_upd      = '\u062a\u0645 \u0627\u0644\u062a\u062d\u062f\u064a\u062b \u0628\u0646\u062c\u0627\u062d'
    done_code     = '\u0633\u062a\u062d\u062a\u0627\u062c \u0631\u0645\u0632 \u0627\u0644\u062f\u062e\u0648\u0644 \u0639\u0646\u062f \u0623\u0648\u0644 \u062a\u0634\u063a\u064a\u0644'
    done_run      = '\u0644\u0644\u0628\u062f\u0621 \u0627\u0643\u062a\u0628: firas'
    launching     = '\u0623\u0634\u063a\u0644 \u0641\u0631\u0627\u0633 \u0643\u0648\u062f \u0627\u0644\u0622\u0646'
    warn_code     = '\u062a\u062c\u0627\u0647\u0644\u062a \u0631\u0645\u0632 \u0627\u0644\u062f\u062e\u0648\u0644 \u0644\u0623\u0646 \u0634\u0643\u0644\u0647 \u063a\u064a\u0631 \u0635\u062d\u064a\u062d'
    err_usage     = '\u062e\u064a\u0627\u0631 \u063a\u064a\u0631 \u0645\u0639\u0631\u0648\u0641'
    err_value     = '\u0627\u0644\u062e\u064a\u0627\u0631 \u064a\u062d\u062a\u0627\u062c \u0625\u0644\u0649 \u0642\u064a\u0645\u0629'
    err_offline   = '\u062a\u0639\u0630\u0631 \u0627\u0644\u0627\u062a\u0635\u0627\u0644 \u0628\u0627\u0644\u0625\u0646\u062a\u0631\u0646\u062a'
    err_proxy     = '\u0627\u0644\u0648\u0633\u064a\u0637 (Proxy) \u064a\u0637\u0644\u0628 \u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644'
    err_tls       = '\u062a\u0639\u0630\u0631 \u062a\u0623\u0645\u064a\u0646 \u0627\u0644\u0627\u062a\u0635\u0627\u0644'
    err_404       = '\u0644\u0645 \u0623\u062c\u062f \u0627\u0644\u0645\u0644\u0641 \u0639\u0644\u0649 \u0627\u0644\u062e\u0627\u062f\u0645'
    err_http      = '\u0641\u0634\u0644 \u0627\u0644\u062a\u0646\u0632\u064a\u0644'
    err_hash      = '\u0627\u0644\u0645\u0644\u0641 \u0627\u0644\u0630\u064a \u0646\u0632\u0644 \u0644\u0627 \u064a\u0637\u0627\u0628\u0642 \u0628\u0635\u0645\u062a\u0647'
    err_zip       = '\u0645\u0644\u0641 \u0627\u0644\u062a\u0637\u0628\u064a\u0642 \u062a\u0627\u0644\u0641 \u0623\u0648 \u0646\u0627\u0642\u0635'
    err_layout    = '\u0627\u0644\u0645\u0644\u0641 \u0644\u0627 \u064a\u0628\u062f\u0648 \u0646\u0633\u062e\u0629 \u0645\u0646 \u0641\u0631\u0627\u0633 \u0643\u0648\u062f'
    err_av        = '\u0642\u062f \u064a\u0643\u0648\u0646 \u0645\u0636\u0627\u062f \u0627\u0644\u0641\u064a\u0631\u0648\u0633\u0627\u062a \u062d\u062c\u0628 \u0627\u0644\u0645\u0644\u0641\u0627\u062a'
    err_write     = '\u0644\u0627 \u0623\u0633\u062a\u0637\u064a\u0639 \u0627\u0644\u0643\u062a\u0627\u0628\u0629 \u0641\u064a \u0647\u0630\u0627 \u0627\u0644\u0645\u062c\u0644\u062f'
    err_busy      = '\u0641\u0631\u0627\u0633 \u0643\u0648\u062f \u0645\u0641\u062a\u0648\u062d \u0627\u0644\u0622\u0646\u060c \u0623\u063a\u0644\u0642\u0647 \u0648\u0623\u0639\u062f \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629'
    err_node_bad  = '\u062a\u0639\u0630\u0631 \u062a\u0634\u063a\u064a\u0644 Node.js'
    err_arch      = '\u0647\u0630\u0627 \u0627\u0644\u062c\u0647\u0627\u0632 \u063a\u064a\u0631 \u0645\u062f\u0639\u0648\u0645'
    err_os        = '\u0647\u0630\u0627 \u0627\u0644\u0645\u062b\u0628\u062a \u0644\u0646\u0638\u0627\u0645 \u0648\u064a\u0646\u062f\u0648\u0632 \u0641\u0642\u0637'
    err_psver     = '\u064a\u0644\u0632\u0645 Windows PowerShell 5.1 \u0623\u0648 \u0623\u062d\u062f\u062b'
    err_clm       = 'PowerShell \u0645\u0642\u064a\u062f \u0628\u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u062c\u0647\u0627\u0632'
    err_repo      = '\u0639\u0646\u0648\u0627\u0646 \u0627\u0644\u062a\u0637\u0628\u064a\u0642 \u0644\u0645 \u064a\u0636\u0628\u0637 \u0628\u0639\u062f'
    err_dir       = '\u0645\u062c\u0644\u062f \u0627\u0644\u062a\u062b\u0628\u064a\u062a \u063a\u064a\u0631 \u0622\u0645\u0646'
    err_unknown   = '\u062d\u062f\u062b \u062e\u0637\u0623 \u063a\u064a\u0631 \u0645\u062a\u0648\u0642\u0639'
    un_title      = '\u0625\u0632\u0627\u0644\u0629 \u0641\u0631\u0627\u0633 \u0643\u0648\u062f 2'
    un_none       = '\u0644\u0627 \u064a\u0648\u062c\u062f \u062a\u062b\u0628\u064a\u062a \u0641\u064a \u0647\u0630\u0627 \u0627\u0644\u0645\u0643\u0627\u0646'
    un_done       = '\u062a\u0645\u062a \u0625\u0632\u0627\u0644\u0629 \u0641\u0631\u0627\u0633 \u0643\u0648\u062f \u0645\u0646 \u062c\u0647\u0627\u0632\u0643'
    un_kept       = '\u0623\u0628\u0642\u064a\u062a \u0625\u0639\u062f\u0627\u062f\u0627\u062a\u0643 \u0648\u062c\u0644\u0633\u0627\u062a\u0643 \u0627\u0644\u0645\u062d\u0641\u0648\u0638\u0629'
    un_purged     = '\u062d\u0630\u0641\u062a \u0643\u0644 \u0634\u064a\u0621 \u0628\u0645\u0627 \u0641\u064a\u0647 \u0625\u0639\u062f\u0627\u062f\u0627\u062a\u0643'
    un_nopurge    = '\u062a\u062c\u0627\u0647\u0644\u062a \u062e\u064a\u0627\u0631 \u0627\u0644\u062d\u0630\u0641 \u0627\u0644\u0643\u0627\u0645\u0644 \u0644\u0623\u0646 \u0627\u0644\u0645\u062c\u0644\u062f \u0644\u0627 \u064a\u062d\u0645\u0644 \u0639\u0644\u0627\u0645\u0629 \u062a\u062b\u0628\u064a\u062a \u0641\u0631\u0627\u0633 \u0643\u0648\u062f\u060c \u0641\u0623\u0632\u0644\u062a \u0645\u062c\u0644\u062f\u0627\u062a \u0627\u0644\u0628\u0631\u0646\u0627\u0645\u062c \u0641\u0642\u0637'
    un_path       = '\u0623\u0632\u0644\u062a \u0627\u0644\u0623\u0645\u0631 \u0645\u0646 \u0645\u0633\u0627\u0631 \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645'
    help_title    = '\u062a\u062b\u0628\u064a\u062a \u0641\u0631\u0627\u0633 \u0643\u0648\u062f 2 \u0639\u0644\u0649 \u0648\u064a\u0646\u062f\u0648\u0632'
  }
  $EnglishText = @{
    title         = 'Firas Code 2 installer'
    step_node     = 'Checking for Node.js'
    node_ok       = 'Using Node.js {0} ({1})'
    node_old      = 'The Node.js on this computer ({0}) is older than 18.17.'
    node_get      = 'Downloading a private copy of Node.js {0}. No admin rights needed.'
    node_sum      = 'Verifying the SHA-256 checksum'
    node_ready    = 'Node.js is ready ({0})'
    step_app      = 'Downloading Firas Code 2'
    step_unpack   = 'Unpacking and installing'
    step_shims    = 'Creating the firas command'
    path_added    = 'Added {0} to your user PATH.'
    path_present  = 'firas is already on your PATH.'
    path_skipped  = 'PATH was left untouched.'
    path_hint     = 'Open a new terminal window, then type: firas'
    done_new      = 'Installed successfully (version {0}).'
    done_upd      = 'Updated successfully (version {0}).'
    done_code     = 'On first run, enter the access code you were given.'
    done_run      = 'To start, type: firas'
    launching     = 'Starting Firas Code 2...'
    warn_code     = 'The access code looks wrong, so it was ignored. You can enter it on first run.'
    err_usage     = 'Unknown option: {0}. Run with -Help to see the options.'
    err_value     = 'The option {0} needs a value.'
    err_offline   = 'Could not reach {0}. Check your internet connection, proxy or firewall, then run the same command again.'
    err_proxy     = 'A proxy server refused the download ({0}). Ask your network administrator or try another network.'
    err_tls       = 'A secure connection to {0} could not be made. Check your computer date and time, and any antivirus that scans HTTPS.'
    err_404       = 'The server answered ''not found'' for {0}.'
    err_http      = 'The download failed: {0}'
    err_hash      = 'The Node.js download does not match its published SHA-256 checksum, so nothing was installed. Run the command again.'
    err_zip       = 'The downloaded archive is damaged or incomplete ({0}). Run the command again.'
    err_layout    = 'The archive does not look like Firas Code 2 (bin\firas.js is missing).'
    err_av        = 'Files were blocked or removed while installing. Antivirus software may be quarantining them. Allow the folder {0} or pause it briefly, then run the command again.'
    err_write     = 'Cannot write to {0}. Choose another folder with -InstallDir.'
    err_busy      = 'Firas Code seems to be running from {0}. Close it, then run the command again.'
    err_node_bad  = 'Node.js could not be started: {0}'
    err_arch      = '64-bit Windows is required (found {0}).'
    err_os        = 'This installer is for Windows. On macOS or Linux use scripts/install.sh.'
    err_psver     = 'Windows PowerShell 5.1 or newer is required.'
    err_clm       = 'PowerShell is in a restricted mode (Constrained Language) on this computer, so the installer cannot run. Ask your IT administrator, or use another computer.'
    err_repo      = 'This copy of the installer has no repository address. Pass -ArchiveUrl with a zip file or address.'
    err_dir       = 'Refusing to use {0} as the install folder.'
    err_unknown   = 'Unexpected error: {0}'
    un_title      = 'Uninstalling Firas Code 2'
    un_none       = 'Nothing is installed in {0}.'
    un_done       = 'Firas Code was removed from {0}.'
    un_kept       = 'Your settings and saved sessions were kept. Use -Purge to delete them too.'
    un_purged     = 'Everything in {0} was deleted, including settings and sessions.'
    un_nopurge    = 'The -Purge option was ignored: {0} has no Firas Code install marker, so only the program''s own folders were removed.'
    un_path       = 'Removed {0} from your user PATH.'
    help_title    = 'Firas Code 2 installer for Windows'
  }
  $M = @{}
  foreach ($key in $ArabicCodes.Keys) { $M[$key] = @([regex]::Unescape($ArabicCodes[$key]), $EnglishText[$key]) }
  # --- messages:end ---

  # ---------------------------------------------------------------- output
  $useColor = -not $env:NO_COLOR
  $arabicRaw = ($env:FIRAS_ARABIC -eq 'off')
  $englishOnly = ($env:FIRAS_LANG -eq 'en')
  $lineWidth = 64
  try { $lineWidth = [Math]::Max(30, [Math]::Min(64, [Console]::WindowWidth - 4)) } catch { }

  function Write-Fc([string]$text, [string]$color) {
    if ($useColor -and $color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
  }

  $ar = @{ ready = $false; forms = @{}; lig = @{} }

  function Initialize-FcArabic {
    if ($ar.ready) { return }
    # Presentation forms come in the order isolated, final, initial, medial; NFKC maps each back to its letter.
    $groups = @{}
    foreach ($cp in 0xFE80..0xFEF4) {
      $glyph = [string][char]$cp
      $base = $glyph.Normalize([System.Text.NormalizationForm]::FormKC)
      if ($base.Length -ne 1) { continue }
      if (-not $groups.ContainsKey($base)) { $groups[$base] = New-Object System.Collections.ArrayList }
      [void]$groups[$base].Add($glyph)
    }
    foreach ($base in @($groups.Keys)) {
      $g = $groups[$base]
      $f = @{ iso = $g[0] }
      if ($g.Count -ge 2) { $f['fin'] = $g[1] }
      if ($g.Count -ge 4) { $f['ini'] = $g[2]; $f['med'] = $g[3] }
      $ar.forms[$base] = $f
    }
    foreach ($cp in 0xFEF5..0xFEFC) {
      $glyph = [string][char]$cp
      $pair = $glyph.Normalize([System.Text.NormalizationForm]::FormKC)
      if (-not $ar.lig.ContainsKey($pair)) { $ar.lig[$pair] = @{ iso = $glyph } } else { $ar.lig[$pair]['fin'] = $glyph }
    }
    $ar.ready = $true
  }

  function ConvertTo-FcShaped([string]$s) {
    $sb = New-Object System.Text.StringBuilder
    $lam = [string][char]0x0644
    $n = $s.Length
    $i = 0
    while ($i -lt $n) {
      $c = [string]$s[$i]
      if (-not $ar.forms.ContainsKey($c)) { [void]$sb.Append($c); $i++; continue }
      $prevJoins = $false
      if ($i -gt 0) {
        $p = [string]$s[$i - 1]
        if ($ar.forms.ContainsKey($p) -and $ar.forms[$p].ContainsKey('ini')) { $prevJoins = $true }
      }
      $next = ''
      if ($i + 1 -lt $n) { $next = [string]$s[$i + 1] }
      if ($c -eq $lam -and $next -ne '' -and $ar.lig.ContainsKey($c + $next)) {
        $l = $ar.lig[$c + $next]
        if ($prevJoins -and $l.ContainsKey('fin')) { [void]$sb.Append($l['fin']) } else { [void]$sb.Append($l['iso']) }
        $i += 2
        continue
      }
      $f = $ar.forms[$c]
      $nextJoins = $f.ContainsKey('ini') -and $next -ne '' -and $ar.forms.ContainsKey($next) -and $ar.forms[$next].ContainsKey('fin')
      $glyph = $f['iso']
      if ($prevJoins -and $nextJoins) { $glyph = $f['med'] }
      elseif ($prevJoins -and $f.ContainsKey('fin')) { $glyph = $f['fin'] }
      elseif ($nextJoins) { $glyph = $f['ini'] }
      [void]$sb.Append($glyph)
      $i++
    }
    return $sb.ToString()
  }

  function Get-FcBidiType([char]$ch) {
    $cp = [int]$ch
    if (($cp -ge 0x0590 -and $cp -le 0x08FF) -or ($cp -ge 0xFB1D -and $cp -le 0xFDFF) -or ($cp -ge 0xFE70 -and $cp -le 0xFEFF)) { return 'R' }
    if ($cp -ge 0x30 -and $cp -le 0x39) { return 'EN' }
    if ([char]::IsLetter($ch)) { return 'L' }
    return 'NI'
  }

  # A small slice of the Unicode bidirectional algorithm for one right-to-left line:
  # Latin words and numbers keep their order, neutrals take the surrounding direction, brackets mirror.
  function ConvertTo-FcVisual([string]$logical) {
    Initialize-FcArabic
    $shaped = ConvertTo-FcShaped $logical
    $n = $shaped.Length
    $types = New-Object 'string[]' $n
    for ($i = 0; $i -lt $n; $i++) { $types[$i] = Get-FcBidiType $shaped[$i] }
    if (-not ($types -contains 'R')) { return $shaped }
    for ($i = 1; $i -lt ($n - 1); $i++) {
      if ($types[$i] -eq 'NI' -and '.,/:'.IndexOf($shaped[$i]) -ge 0 -and $types[$i - 1] -eq 'EN' -and $types[$i + 1] -eq 'EN') { $types[$i] = 'EN' }
    }
    $last = 'R'
    for ($i = 0; $i -lt $n; $i++) {
      if ($types[$i] -eq 'R' -or $types[$i] -eq 'L') { $last = $types[$i] }
      elseif ($types[$i] -eq 'EN' -and $last -eq 'L') { $types[$i] = 'L' }
    }
    $levels = New-Object 'int[]' $n
    $i = 0
    while ($i -lt $n) {
      if ($types[$i] -ne 'NI') {
        if ($types[$i] -eq 'R') { $levels[$i] = 1 } else { $levels[$i] = 2 }
        $i++
        continue
      }
      $j = $i
      while ($j -lt $n -and $types[$j] -eq 'NI') { $j++ }
      $left = 'R'
      if ($i -gt 0) { $left = $types[$i - 1] }
      $right = 'R'
      if ($j -lt $n) { $right = $types[$j] }
      $level = 1
      if ($left -eq 'L' -and $right -eq 'L') { $level = 2 }
      for ($k = $i; $k -lt $j; $k++) { $levels[$k] = $level }
      $i = $j
    }
    $mirror = @{ '(' = ')'; ')' = '('; '[' = ']'; ']' = '['; '{' = '}'; '}' = '{'; '<' = '>'; '>' = '<' }
    $vis = $shaped.ToCharArray()
    for ($i = 0; $i -lt $n; $i++) {
      if ($levels[$i] -eq 1 -and $mirror.ContainsKey([string]$vis[$i])) { $vis[$i] = [char]$mirror[[string]$vis[$i]] }
    }
    foreach ($want in 2, 1) {
      $i = 0
      while ($i -lt $n) {
        if ($levels[$i] -lt $want) { $i++; continue }
        $j = $i
        while ($j -lt $n -and $levels[$j] -ge $want) { $j++ }
        [Array]::Reverse($vis, $i, $j - $i)
        [Array]::Reverse($levels, $i, $j - $i)
        $i = $j
      }
    }
    return (-join $vis)
  }

  function Write-FcArabic([string]$logical, [string]$color) {
    $text = $logical
    if (-not $arabicRaw) {
      try {
        $text = ConvertTo-FcVisual $logical
        if ($text.Length -lt $lineWidth) { $text = (' ' * ($lineWidth - $text.Length)) + $text }
      } catch { $text = $logical }
    }
    Write-Fc ('  ' + $text) $color
  }

  function Say([string]$key, [object[]]$values, [string]$arColor, [string]$enColor, [string]$prefix) {
    $pair = $M[$key]
    $en = $pair[1]
    if ($values -and $values.Count) { $en = $en -f $values }
    if (-not $englishOnly) { Write-FcArabic $pair[0] $arColor }
    Write-Fc ('  ' + $prefix + $en) $enColor
  }

  # ---------------------------------------------------------------- errors
  function New-FcError([int]$code, [string]$key, [object[]]$values) {
    $ex = New-Object System.Exception($key)
    $ex.Data['code'] = $code
    $ex.Data['key'] = $key
    $ex.Data['values'] = [string[]]@($values | ForEach-Object { [string]$_ })
    return $ex
  }

  function Get-FcErrorInfo($ex) {
    $cur = $ex
    while ($cur) {
      if ($cur.Data -and $cur.Data.Contains('code')) { return $cur }
      $cur = $cur.InnerException
    }
    return $null
  }

  function Resolve-FcFsError($ex, [string]$where) {
    $text = ''
    $cur = $ex
    while ($cur) { $text += ' ' + $cur.Message; $cur = $cur.InnerException }
    if ($text -match 'virus|potentially unwanted') { return (New-FcError 5 'err_av' @($where)) }
    if ($text -match 'being used by another process|sharing violation') { return (New-FcError 5 'err_busy' @($where)) }
    if ($text -match 'denied|not have permission|read-only|not authorized') { return (New-FcError 5 'err_write' @($where)) }
    return (New-FcError 5 'err_write' @($where))
  }

  # ---------------------------------------------------------------- files
  function Get-FcFullPath([string]$path) {
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($path)
  }

  function Remove-FcTree([string]$path, [switch]$BestEffort) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    try {
      Remove-Item -LiteralPath $path -Recurse -Force
    } catch {
      try { & cmd.exe /d /c ('rd /s /q "' + $path + '"') | Out-Null } catch { }
      if ((Test-Path -LiteralPath $path) -and -not $BestEffort) { throw }
    }
  }

  function Set-FcTextFile([string]$path, [string]$text) {
    $text = $text -replace "`r?`n", "`r`n"
    if ((Test-Path -LiteralPath $path) -and ([IO.File]::ReadAllText($path) -ceq $text)) { return }
    [IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
  }

  function Switch-FcDir([string]$new, [string]$final) {
    $old = $final + '.old'
    Remove-FcTree $old
    $moved = $false
    try {
      if (Test-Path -LiteralPath $final) { Move-Item -LiteralPath $final -Destination $old; $moved = $true }
      Move-Item -LiteralPath $new -Destination $final
    } catch {
      if ($moved -and -not (Test-Path -LiteralPath $final) -and (Test-Path -LiteralPath $old)) { Move-Item -LiteralPath $old -Destination $final }
      throw
    }
    Remove-FcTree $old -BestEffort
  }

  # ---------------------------------------------------------------- network
  function Get-FcLocalSource([string]$source) {
    if ($source -match '^https?://') { return $null }
    if ($source -match '^file:') { return ([System.Uri]$source).LocalPath }
    return (Get-FcFullPath $source)
  }

  function New-FcWebClient {
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add('User-Agent', 'firas-code-installer')
    try {
      $proxy = [System.Net.WebRequest]::GetSystemWebProxy()
      $proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
      $wc.Proxy = $proxy
    } catch { }
    return $wc
  }

  function Resolve-FcNetError($ex, [string]$url) {
    $hostName = $url
    try { $hostName = ([System.Uri]$url).Host } catch { }
    $web = $ex
    while ($web -and -not ($web -is [System.Net.WebException])) { $web = $web.InnerException }
    if (-not $web) {
      return [pscustomobject]@{ Retry = $false; Error = (New-FcError 3 'err_http' @($ex.Message)) }
    }
    $status = [string]$web.Status
    if ($status -eq 'ProtocolError' -and $web.Response) {
      $http = [int]$web.Response.StatusCode
      if ($http -eq 404 -or $http -eq 410) { return [pscustomobject]@{ Retry = $false; Error = (New-FcError 3 'err_404' @($url)) } }
      if ($http -eq 407) { return [pscustomobject]@{ Retry = $false; Error = (New-FcError 3 'err_proxy' @($hostName)) } }
      if ($http -ge 500 -or $http -eq 429) { return [pscustomobject]@{ Retry = $true; Error = (New-FcError 3 'err_http' @("HTTP $http from $hostName")) } }
      return [pscustomobject]@{ Retry = $false; Error = (New-FcError 3 'err_http' @("HTTP $http from $hostName")) }
    }
    if ($status -match 'SecureChannelFailure|TrustFailure|CertificateError') {
      return [pscustomobject]@{ Retry = $false; Error = (New-FcError 3 'err_tls' @($hostName)) }
    }
    if ($status -match 'ProxyNameResolutionFailure') {
      return [pscustomobject]@{ Retry = $true; Error = (New-FcError 3 'err_proxy' @($hostName)) }
    }
    return [pscustomobject]@{ Retry = $true; Error = (New-FcError 3 'err_offline' @($hostName)) }
  }

  function Show-FcProgress([long]$bytes) {
    if ([Console]::IsOutputRedirected) { return }
    $mb = [Math]::Round($bytes / 1MB, 1)
    [Console]::Write("`r    $mb MB   ")
  }

  function Clear-FcProgress {
    if ([Console]::IsOutputRedirected) { return }
    [Console]::Write("`r" + (' ' * 24) + "`r")
  }

  function Get-FcFile([string]$url, [string]$dest) {
    $local = Get-FcLocalSource $url
    if ($local) {
      if (-not (Test-Path -LiteralPath $local -PathType Leaf)) { throw (New-FcError 3 'err_404' @($url)) }
      Copy-Item -LiteralPath $local -Destination $dest -Force
      return
    }
    $attempt = 0
    while ($true) {
      $attempt++
      $failure = $null
      $wc = New-FcWebClient
      try {
        $task = $wc.DownloadFileTaskAsync((New-Object System.Uri($url)), $dest)
        $lastSize = -1L
        $lastMove = Get-Date
        $stalled = $false
        while (-not $task.Wait(400)) {
          $size = 0L
          if (Test-Path -LiteralPath $dest) { $size = (Get-Item -LiteralPath $dest).Length }
          if ($size -ne $lastSize) { $lastSize = $size; $lastMove = Get-Date; Show-FcProgress $size }
          elseif (((Get-Date) - $lastMove).TotalSeconds -gt 90) { $stalled = $true; $wc.CancelAsync(); break }
        }
        Clear-FcProgress
        if ($stalled) {
          try { [void]$task.Wait(5000) } catch { }
          $failure = [pscustomobject]@{ Retry = $true; Error = (New-FcError 3 'err_offline' @(([System.Uri]$url).Host)) }
        } else {
          return
        }
      } catch {
        Clear-FcProgress
        $failure = Resolve-FcNetError $_.Exception $url
      } finally {
        $wc.Dispose()
      }
      if (-not $failure.Retry -or $attempt -ge 3) { throw $failure.Error }
      Start-Sleep -Seconds (2 * $attempt)
    }
  }

  function Get-FcText([string]$url, [string]$tempDir) {
    $file = Join-Path $tempDir ('text-' + [guid]::NewGuid().ToString('N'))
    Get-FcFile $url $file
    $text = [IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
    Remove-Item -LiteralPath $file -Force
    return $text
  }

  function Get-FcSha256([string]$file) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($file)
    try { $bytes = $sha.ComputeHash($stream) } finally { $stream.Dispose(); $sha.Dispose() }
    return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
  }

  # ---------------------------------------------------------------- zip
  # Extracts by hand: it flattens the single top-level folder GitHub adds, can keep only some
  # files, and refuses entries that would land outside the destination.
  function Expand-FcZip([string]$zip, [string]$dest, [string[]]$only) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    try {
      $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    } catch {
      throw (New-FcError 4 'err_zip' @($_.Exception.Message))
    }
    try {
      $prefix = ''
      $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
      if ($names.Count -eq 0) { throw (New-FcError 4 'err_zip' @('empty archive')) }
      $first = $names[0]
      $cut = $first.IndexOf('/')
      if ($cut -gt 0) {
        $candidate = $first.Substring(0, $cut + 1)
        $shared = $true
        foreach ($name in $names) { if (-not $name.StartsWith($candidate)) { $shared = $false; break } }
        if ($shared) { $prefix = $candidate }
      }
      [void](New-Item -ItemType Directory -Force -Path $dest)
      $root = (Get-FcFullPath $dest).TrimEnd('\', '/') + $Slash
      foreach ($entry in $archive.Entries) {
        $rel = $entry.FullName.Replace('\', '/')
        if ($prefix -and $rel.StartsWith($prefix)) { $rel = $rel.Substring($prefix.Length) }
        if ($rel -eq '') { continue }
        $isDir = $rel.EndsWith('/')
        $rel = $rel.TrimEnd('/')
        if ($only -and ($only -notcontains $rel)) { continue }
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $rel.Replace('/', $Slash)))
        if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw (New-FcError 4 'err_zip' @('unsafe path in archive')) }
        if ($isDir) { [void](New-Item -ItemType Directory -Force -Path $target); continue }
        $parent = [IO.Path]::GetDirectoryName($target)
        if (-not (Test-Path -LiteralPath $parent)) { [void](New-Item -ItemType Directory -Force -Path $parent) }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
      }
    } catch [System.IO.InvalidDataException] {
      throw (New-FcError 4 'err_zip' @($_.Exception.Message))
    } finally {
      $archive.Dispose()
    }
  }

  # ---------------------------------------------------------------- node
  function Get-FcNodeVersion([string]$exe) {
    try {
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $exe
      $psi.Arguments = '-v'
      $psi.UseShellExecute = $false
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      $psi.CreateNoWindow = $true
      $proc = [System.Diagnostics.Process]::Start($psi)
      if (-not $proc.WaitForExit(20000)) { try { $proc.Kill() } catch { }; return $null }
      $out = $proc.StandardOutput.ReadToEnd().Trim()
      if ($proc.ExitCode -eq 0 -and $out -match '^v(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
    } catch { }
    return $null
  }

  function Find-FcSystemNode {
    $oldest = $null
    foreach ($cmd in @(Get-Command node -All -CommandType Application -ErrorAction SilentlyContinue)) {
      if (-not $cmd.Source.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) { continue }
      $v = Get-FcNodeVersion $cmd.Source
      if ($v -and $v -ge $MinNode) { return [pscustomobject]@{ Path = $cmd.Source; Version = $v; Old = $null } }
      if ($v -and (-not $oldest -or $v -gt $oldest)) { $oldest = $v }
    }
    return [pscustomobject]@{ Path = $null; Version = $null; Old = $oldest }
  }

  function Install-FcRuntime([string]$dir, [string]$temp) {
    $indexUrl = $env:FIRAS_NODE_INDEX_URL
    if (-not $indexUrl) { $indexUrl = $DefaultNodeIndex }
    $distBase = $env:FIRAS_NODE_DIST_URL
    if (-not $distBase) { $distBase = $DefaultNodeDist }
    $distBase = $distBase.TrimEnd('/')

    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if (-not $arch) { $arch = '' }
    switch ($arch.ToUpperInvariant()) {
      'AMD64' { $wanted = 'x64' }
      'ARM64' { $wanted = 'arm64' }
      default { throw (New-FcError 7 'err_arch' @($arch)) }
    }

    # Windows PowerShell 5.1 hands back a JSON array as one object, PowerShell 7 as its items; the pipeline normalises both.
    $parsed = ConvertFrom-Json -InputObject (Get-FcText $indexUrl $temp)
    $entries = @($parsed | ForEach-Object { $_ })
    $release = $null
    foreach ($entry in $entries) {
      if (-not $entry.lts) { continue }
      $files = @($entry.files)
      if ($files -contains "win-$wanted-zip") { $release = $entry; break }
      if ($wanted -eq 'arm64' -and $files -contains 'win-x64-zip') { $release = $entry; $wanted = 'x64'; break }
    }
    if (-not $release) { throw (New-FcError 3 'err_http' @('no Node.js LTS build for this computer was listed')) }
    $version = [string]$release.version
    $zipName = "node-$version-win-$wanted.zip"

    Say 'node_get' @($version) 'White' 'Gray' '    '
    $zipFile = Join-Path $temp $zipName
    Get-FcFile "$distBase/$version/$zipName" $zipFile

    Say 'node_sum' @() 'White' 'Gray' '    '
    $sums = Get-FcText "$distBase/$version/SHASUMS256.txt" $temp
    $expected = $null
    foreach ($line in ($sums -split "`r?`n")) {
      if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $zipName) { $expected = $Matches[1].ToLowerInvariant(); break }
    }
    if (-not $expected -or (Get-FcSha256 $zipFile) -ne $expected) { throw (New-FcError 4 'err_hash' @()) }

    $staging = Join-Path $dir 'runtime.new'
    Remove-FcTree $staging
    try {
      Expand-FcZip $zipFile $staging @('node.exe', 'LICENSE')
      $exe = Join-Path $staging 'node.exe'
      if (-not (Test-Path -LiteralPath $exe)) { throw (New-FcError 5 'err_av' @($dir)) }
      if (-not (Get-FcNodeVersion $exe)) { throw (New-FcError 6 'err_node_bad' @('the downloaded node.exe did not start')) }
      Switch-FcDir $staging (Join-Path $dir 'runtime')
    } catch {
      Remove-FcTree $staging -BestEffort
      $known = Get-FcErrorInfo $_.Exception
      if ($known) { throw $known }
      throw (Resolve-FcFsError $_.Exception $dir)
    }
    Say 'node_ready' @($version) 'White' 'Gray' '    '
  }

  # ---------------------------------------------------------------- PATH (user scope only)
  function Get-FcPathParts([string]$value) {
    return @($value -split ';' | Where-Object { $_.Trim() -ne '' })
  }

  function ConvertTo-FcPathKey([string]$entry) {
    return [Environment]::ExpandEnvironmentVariables($entry.Trim()).TrimEnd('\', '/').ToLowerInvariant()
  }

  function Update-FcUserPath([string]$binDir, [bool]$add) {
    # Tests point this at a scratch key so the real user PATH is never touched.
    $keyName = $env:FIRAS_TEST_PATH_KEY
    if (-not $keyName) { $keyName = 'Environment' }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyName)
    try {
      $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
      try { $kind = $key.GetValueKind('Path') } catch { }
      $wanted = ConvertTo-FcPathKey $binDir
      $parts = @(Get-FcPathParts $current)
      $present = @($parts | Where-Object { (ConvertTo-FcPathKey $_) -eq $wanted }).Count -gt 0
      if ($add -and $present) { return 'present' }
      if (-not $add -and -not $present) { return 'absent' }
      if ($add) { $parts = $parts + $binDir } else { $parts = @($parts | Where-Object { (ConvertTo-FcPathKey $_) -ne $wanted }) }
      $key.SetValue('Path', ($parts -join ';'), $kind)
    } finally {
      $key.Dispose()
    }
    # Setting a user variable to nothing deletes it if it exists and broadcasts the "environment
    # changed" message, so terminals opened from the Start menu pick the new PATH up without a sign-out.
    if ($keyName -eq 'Environment') {
      try { [Environment]::SetEnvironmentVariable('FIRAS_PATH_REFRESH', $null, 'User') } catch { }
    }
    if ($add) { return 'added' }
    return 'removed'
  }

  # PowerShell prefers firas.ps1 over firas.cmd, and Windows PowerShell 5.1 refuses to run
  # scripts by default. Only write the .ps1 shim when a policy that allows it is set explicitly.
  function Test-FcScriptsAllowed {
    if ($env:FIRAS_FORCE_PS_SHIM -eq '1') { return $true }
    try {
      foreach ($row in @(Get-ExecutionPolicy -List)) {
        if ([string]$row.Scope -eq 'Process') { continue }
        $policy = [string]$row.ExecutionPolicy
        if ($policy -eq 'Undefined') { continue }
        return (@('RemoteSigned', 'Unrestricted', 'Bypass') -contains $policy)
      }
    } catch { }
    return $false
  }

  # ---------------------------------------------------------------- shims
  $cmdShim = @'
@echo off
setlocal
set "FC_ROOT=%~dp0.."
set "FC_NODE=%FC_ROOT%\runtime\node.exe"
if exist "%FC_NODE%" goto run
set "FC_NODE=node"
where node >nul 2>nul
if errorlevel 1 goto nonode
:run
"%FC_NODE%" "%FC_ROOT%\app\bin\firas.js" %*
exit /b %ERRORLEVEL%
:nonode
echo Node.js was not found. Run the Firas Code installer again.
exit /b 9009
'@

  $psShim = @'
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
  $found = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) { [Console]::Error.WriteLine('Node.js was not found. Run the Firas Code installer again.'); exit 9009 }
  $node = $found.Source
}
& $node (Join-Path $root 'app\bin\firas.js') @args
exit $LASTEXITCODE
'@

  $shimNames = @('firas', 'fc2', 'firas-code')

  # ---------------------------------------------------------------- steps
  function Show-FcHelp {
    Say 'help_title' @() 'Cyan' 'Cyan' ''
    Write-Host @'

  Usage
    irm https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.ps1 | iex
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.ps1))) -Code FC2-XXXXX-XXXXX

  Options
    -Code <code>        access code for the first launch (passed in the FIRAS_CODE variable; the app saves it once it is accepted)
    -InstallDir <dir>   install folder (default: %USERPROFILE%\.firas-code)
    -ArchiveUrl <x>     address or path of the app zip (default: the main branch on GitHub)
    -NoLaunch           do not start Firas Code at the end
    -NoPathUpdate       do not change your user PATH
    -Uninstall          remove the app, its Node.js copy and the PATH entry (settings are kept)
    -Purge              with -Uninstall: also delete settings and saved sessions
    -Help               show this text

  Environment twins: FIRAS_CODE, FIRAS_INSTALL_DIR, FIRAS_INSTALL_ARCHIVE,
  FIRAS_NO_LAUNCH=1, FIRAS_NO_PATH_UPDATE=1, FIRAS_UNINSTALL=1
'@
  }

  function Read-FcOptions([object[]]$list) {
    $opt = @{ Code = ''; InstallDir = ''; ArchiveUrl = ''; NoLaunch = $false; NoPathUpdate = $false; Uninstall = $false; Purge = $false; Help = $false }
    $i = 0
    while ($i -lt $list.Count) {
      $raw = [string]$list[$i]
      $i++
      if ($raw -notmatch '^[-/]{1,2}([A-Za-z]+)(?:[:=](.*))?$') { throw (New-FcError 2 'err_usage' @($raw)) }
      $name = $Matches[1].ToLowerInvariant()
      $inline = $null
      if ($Matches.ContainsKey(2)) { $inline = $Matches[2] }
      switch ($name) {
        { $_ -in 'code', 'installdir', 'archiveurl' } {
          $value = $inline
          if (-not $value) {
            if ($i -ge $list.Count) { throw (New-FcError 2 'err_value' @($raw)) }
            $value = [string]$list[$i]
            $i++
          }
          switch ($name) { 'code' { $opt.Code = $value } 'installdir' { $opt.InstallDir = $value } 'archiveurl' { $opt.ArchiveUrl = $value } }
        }
        'nolaunch' { $opt.NoLaunch = $true }
        'nopathupdate' { $opt.NoPathUpdate = $true }
        'uninstall' { $opt.Uninstall = $true }
        'purge' { $opt.Purge = $true }
        { $_ -in 'help', 'h', '?' } { $opt.Help = $true }
        default { throw (New-FcError 2 'err_usage' @($raw)) }
      }
    }
    return $opt
  }

  function Test-FcSafeInstallDir([string]$dir) {
    $root = [IO.Path]::GetPathRoot($dir)
    $unsafe = @($root, $env:USERPROFILE, $env:windir, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:SystemDrive) | Where-Object { $_ }
    foreach ($bad in $unsafe) {
      if ($dir.TrimEnd('\', '/') -ieq $bad.TrimEnd('\', '/')) { return $false }
    }
    return $true
  }

  function Invoke-FcUninstall($opt, [string]$dir) {
    Say 'un_title' @() 'Cyan' 'Cyan' ''
    Write-Host ''
    $binDir = Join-Path $dir 'bin'
    $parts = @('app', 'app.new', 'app.old', 'runtime', 'runtime.new', 'runtime.old', 'bin')
    $marker = Join-Path $dir '.firas-install'
    # Only the marker this installer writes proves that a whole folder is ours. The folder's name, or an app\bin\firas.js
    # left by an older install, is enough to remove the program's own sub-folders and nothing more: a folder that is
    # merely called .firas-code (or a stranger's folder that happens to hold a bin) is never deleted as a whole.
    $hasMarker = Test-Path -LiteralPath $marker -PathType Leaf
    $looksOurs = $hasMarker -or ((Split-Path -Leaf $dir) -ieq '.firas-code') -or (Test-Path -LiteralPath (Join-Path $dir 'app\bin\firas.js'))
    $found = $hasMarker -or ($looksOurs -and @($parts | Where-Object { Test-Path -LiteralPath (Join-Path $dir $_) }).Count -gt 0)
    if (-not $found) { Say 'un_none' @($dir) 'Yellow' 'Yellow' ''; return }
    try {
      foreach ($name in $parts) { Remove-FcTree (Join-Path $dir $name) }
      if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
    } catch {
      $problem = Resolve-FcFsError $_.Exception $dir
      if ($problem.Data['key'] -eq 'err_write') { throw (New-FcError 5 'err_busy' @($dir)) }
      throw $problem
    }
    if (-not $opt.NoPathUpdate) {
      $changed = Update-FcUserPath $binDir $false
      if ($changed -eq 'removed') { Say 'un_path' @($binDir) 'White' 'Gray' '' }
    }
    if ($opt.Purge -and $hasMarker) {
      Remove-FcTree $dir -BestEffort
      Say 'un_purged' @($dir) 'Green' 'Green' ''
      return
    }
    if ((Test-Path -LiteralPath $dir) -and @(Get-ChildItem -LiteralPath $dir -Force).Count -eq 0) { Remove-FcTree $dir -BestEffort }
    Say 'un_done' @($dir) 'Green' 'Green' ''
    if (Test-Path -LiteralPath $dir) {
      if ($opt.Purge) { Say 'un_nopurge' @($dir) 'Yellow' 'Yellow' '' } else { Say 'un_kept' @() 'Gray' 'Gray' '' }
    }
  }

  function Invoke-FcInstall($opt, [string]$dir) {
    $archiveSource = $opt.ArchiveUrl
    if (-not $archiveSource) {
      if ($DefaultArchive.Contains('__' + 'REPO')) { throw (New-FcError 2 'err_repo' @()) }
      $archiveSource = $DefaultArchive
    }
    $code = $opt.Code
    if ($code -and $code -notmatch '^FC2-[0-9A-Z]+(-[0-9A-Z]+)+$') {
      Say 'warn_code' @() 'Yellow' 'Yellow' ''
      $code = ''
    }

    Say 'title' @() 'Cyan' 'Cyan' ''
    Write-Host ''

    try {
      [void](New-Item -ItemType Directory -Force -Path $dir)
      $probe = Join-Path $dir ('.write-test-' + [guid]::NewGuid().ToString('N'))
      [IO.File]::WriteAllText($probe, 'x')
      Remove-Item -LiteralPath $probe -Force
    } catch {
      throw (New-FcError 5 'err_write' @($dir))
    }

    $temp = Join-Path ([IO.Path]::GetTempPath()) ('firas-code-' + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Force -Path $temp)
    $existed = Test-Path -LiteralPath (Join-Path $dir 'app\bin\firas.js')
    try {
      # 1 - Node.js
      Say 'step_node' @() 'White' 'Gray' '[1/4] '
      $bundled = Join-Path $dir 'runtime\node.exe'
      $ready = $false
      if (Test-Path -LiteralPath $bundled) {
        $bundledVersion = Get-FcNodeVersion $bundled
        if ($bundledVersion -and $bundledVersion -ge $MinNode) {
          Say 'node_ok' @($bundledVersion, 'private copy') 'Green' 'Gray' '      '
          $ready = $true
        } else {
          Remove-FcTree (Join-Path $dir 'runtime')
        }
      }
      if (-not $ready) {
        $system = Find-FcSystemNode
        if ($system.Path) {
          Say 'node_ok' @($system.Version, 'on PATH') 'Green' 'Gray' '      '
        } else {
          if ($system.Old) { Say 'node_old' @($system.Old) 'Yellow' 'Yellow' '      ' }
          Install-FcRuntime $dir $temp
        }
      }

      # 2 - download
      Write-Host ''
      Say 'step_app' @() 'White' 'Gray' '[2/4] '
      $zip = Join-Path $temp 'app.zip'
      Get-FcFile $archiveSource $zip

      # 3 - unpack and swap
      Write-Host ''
      Say 'step_unpack' @() 'White' 'Gray' '[3/4] '
      $staging = Join-Path $dir 'app.new'
      Remove-FcTree $staging
      try {
        Expand-FcZip $zip $staging $null
        if (-not (Test-Path -LiteralPath (Join-Path $staging 'bin\firas.js'))) { throw (New-FcError 4 'err_layout' @()) }
        try {
          Switch-FcDir $staging (Join-Path $dir 'app')
        } catch {
          $problem = Resolve-FcFsError $_.Exception $dir
          if ($problem.Data['key'] -eq 'err_av') { throw $problem }
          throw (New-FcError 5 'err_busy' @($dir))
        }
      } catch {
        Remove-FcTree $staging -BestEffort
        $known = Get-FcErrorInfo $_.Exception
        if ($known) { throw $known }
        throw (Resolve-FcFsError $_.Exception $dir)
      }
    } finally {
      Remove-FcTree $temp -BestEffort
    }

    # 4 - commands and PATH
    Write-Host ''
    Say 'step_shims' @() 'White' 'Gray' '[4/4] '
    $binDir = Join-Path $dir 'bin'
    [void](New-Item -ItemType Directory -Force -Path $binDir)
    foreach ($name in $shimNames) { Set-FcTextFile (Join-Path $binDir "$name.cmd") $cmdShim }
    $psShimPath = Join-Path $binDir 'firas.ps1'
    if (Test-FcScriptsAllowed) { Set-FcTextFile $psShimPath $psShim }
    elseif (Test-Path -LiteralPath $psShimPath) { Remove-Item -LiteralPath $psShimPath -Force }

    $version = '2'
    try { $version = [string](Get-Content -LiteralPath (Join-Path $dir 'app\package.json') -Raw | ConvertFrom-Json).version } catch { }
    $stamp = ConvertTo-Json -Compress @{ version = $version; installedAt = (Get-Date).ToUniversalTime().ToString('o') }
    [IO.File]::WriteAllText((Join-Path $dir '.firas-install'), $stamp)

    $pathAdded = $false
    if ($opt.NoPathUpdate) {
      Say 'path_skipped' @() 'Gray' 'Gray' '      '
    } elseif ((Update-FcUserPath $binDir $true) -eq 'added') {
      Say 'path_added' @($binDir) 'Green' 'Gray' '      '
      $pathAdded = $true
    } else {
      Say 'path_present' @() 'Green' 'Gray' '      '
    }
    if (@($env:Path -split ';') -notcontains $binDir) { $env:Path = "$binDir;$env:Path" }

    $interactive = $true
    try { $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected } catch { }
    if (Test-FcFlag $env:FIRAS_FORCE_LAUNCH) { $interactive = $true }
    $willLaunch = (-not $opt.NoLaunch) -and $interactive

    Write-Host ''
    if ($existed) { Say 'done_upd' @($version) 'Green' 'Green' '' } else { Say 'done_new' @($version) 'Green' 'Green' '' }
    # A code given with -Code only travels with the first launch (the installer never writes it; the app saves it once the service accepts it); without a launch it has to be typed later.
    if (-not $code -or -not $willLaunch) { Say 'done_code' @() 'Gray' 'Gray' '' }
    if ($pathAdded) { Say 'path_hint' @() 'Gray' 'Gray' '' } else { Say 'done_run' @() 'Gray' 'Gray' '' }

    if ($willLaunch) {
      Write-Host ''
      Say 'launching' @() 'Cyan' 'Cyan' ''
      Write-Host ''
      # The caller runs it: output of a native program started inside this function would be
      # captured as the function result instead of reaching the console.
      $state.launch = Join-Path $binDir 'firas.cmd'
      # The code travels in the environment of the launched program, never on its command line (a command line is visible
      # to every program on the computer and is kept in the shell history).
      $state.launchCode = $code
    }
  }

  function Test-FcFlag($value) {
    return ($value -and ([string]$value -notmatch '^(0|false|no|off)$'))
  }

  function New-FcResult([int]$code) {
    return [pscustomobject]@{ Code = $code; Launch = [string]$state.launch; LaunchCode = [string]$state.launchCode }
  }

  # ---------------------------------------------------------------- main
  $state = @{ launch = ''; launchCode = '' }
  try {
    $opt = Read-FcOptions @($Arguments)
    if ($opt.Help) { Show-FcHelp; return (New-FcResult 0) }
    if (-not $opt.Code) { $opt.Code = [string]$env:FIRAS_CODE }
    if (-not $opt.InstallDir) { $opt.InstallDir = [string]$env:FIRAS_INSTALL_DIR }
    if (-not $opt.ArchiveUrl) { $opt.ArchiveUrl = [string]$env:FIRAS_INSTALL_ARCHIVE }
    if (Test-FcFlag $env:FIRAS_NO_LAUNCH) { $opt.NoLaunch = $true }
    if (Test-FcFlag $env:FIRAS_NO_PATH_UPDATE) { $opt.NoPathUpdate = $true }
    if (Test-FcFlag $env:FIRAS_UNINSTALL) { $opt.Uninstall = $true }

    if ($env:OS -ne 'Windows_NT') { throw (New-FcError 7 'err_os' @()) }
    if ($PSVersionTable.PSVersion.Major -lt 5) { throw (New-FcError 7 'err_psver' @()) }
    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw (New-FcError 7 'err_clm' @()) }
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

    if (-not $opt.InstallDir) {
      $userHome = $env:USERPROFILE
      if (-not $userHome) { $userHome = [Environment]::GetFolderPath('UserProfile') }
      $opt.InstallDir = Join-Path $userHome '.firas-code'
    }
    $dir = Get-FcFullPath $opt.InstallDir
    if (-not (Test-FcSafeInstallDir $dir)) { throw (New-FcError 2 'err_dir' @($dir)) }

    if ($opt.Uninstall) { Invoke-FcUninstall $opt $dir } else { Invoke-FcInstall $opt $dir }
    return (New-FcResult 0)
  } catch {
    $info = Get-FcErrorInfo $_.Exception
    Write-Host ''
    if ($info) {
      Say $info.Data['key'] @($info.Data['values']) 'Red' 'Red' ''
      return (New-FcResult ([int]$info.Data['code']))
    }
    Say 'err_unknown' @($_.Exception.Message) 'Red' 'Red' ''
    return (New-FcResult 1)
  }
}

$fcRun = @(Invoke-FirasInstaller -Arguments $args)
Remove-Item -Path Function:\Invoke-FirasInstaller -ErrorAction SilentlyContinue
$fcCode = 1
$fcLaunch = ''
$fcLaunchCode = ''
if ($fcRun.Count -gt 0 -and $fcRun[-1] -and $fcRun[-1].PSObject.Properties['Code']) {
  $fcCode = [int]$fcRun[-1].Code
  $fcLaunch = [string]$fcRun[-1].Launch
  $fcLaunchCode = [string]$fcRun[-1].LaunchCode
}
if ($fcLaunch) {
  $fcPrevCode = $env:FIRAS_CODE
  if ($fcLaunchCode) { $env:FIRAS_CODE = $fcLaunchCode }
  try { & $fcLaunch } finally {
    if ($null -eq $fcPrevCode) { Remove-Item Env:\FIRAS_CODE -ErrorAction SilentlyContinue } else { $env:FIRAS_CODE = $fcPrevCode }
  }
}
Remove-Variable fcRun, fcLaunch, fcLaunchCode, fcPrevCode -ErrorAction SilentlyContinue
if ($PSCommandPath) { exit $fcCode }
$global:LASTEXITCODE = $fcCode
Remove-Variable fcCode -ErrorAction SilentlyContinue
