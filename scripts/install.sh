#!/usr/bin/env bash
# =============================================================================
# Firas Code 2 - installer for macOS and Linux
#
#   curl -fsSL https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.sh | bash -s -- --code FC2-XXXXX-XXXXX
#
# Options: --code <code>  --dir <folder>  --archive <file or address>  --no-launch
#          --no-path-update  --uninstall  --purge  --help
# Environment twins: FIRAS_CODE, FIRAS_INSTALL_DIR, FIRAS_INSTALL_ARCHIVE, FIRAS_NO_LAUNCH=1,
# FIRAS_NO_PATH_UPDATE=1, FIRAS_UNINSTALL=1, FIRAS_LANG=en (English lines only).
# Test hooks: FIRAS_NODE_INDEX_URL, FIRAS_NODE_DIST_URL, FIRAS_NODE_TARGET=<os>-<arch>, FIRAS_FORCE_LAUNCH=1.
#
# Same behaviour as install.ps1: use the Node.js already on the machine if it is new enough,
# otherwise download a private copy (checksum verified) into <dir>/runtime; download the app into
# <dir>/app by extracting to app.new and renaming; put launchers in <dir>/bin and add that folder to
# the PATH in the shell start-up files inside a marked block. No root, no telemetry, nothing else is
# written. Settings and saved sessions live next to app/, never inside it, so updates keep them.
# Arabic lines are printed as logical text: macOS Terminal and most Linux terminals reorder them.
# =============================================================================
set -Eeuo pipefail

DEFAULT_ARCHIVE="https://codeload.github.com/MentronX/firas-code/tar.gz/refs/heads/main"
DEFAULT_NODE_INDEX="https://nodejs.org/dist/index.json"
DEFAULT_NODE_DIST="https://nodejs.org/dist"
MIN_MAJOR=18
MIN_MINOR=17
MARK_BEGIN="# >>> firas-code >>>"
MARK_END="# <<< firas-code <<<"

CODE="${FIRAS_CODE:-}"
INSTALL_DIR="${FIRAS_INSTALL_DIR:-}"
ARCHIVE="${FIRAS_INSTALL_ARCHIVE:-}"
NO_LAUNCH=0
NO_PATH_UPDATE=0
UNINSTALL=0
PURGE=0
flag_on() { case "${1:-}" in ""|0|false|no|off) return 1 ;; *) return 0 ;; esac; }
if flag_on "${FIRAS_NO_LAUNCH:-}"; then NO_LAUNCH=1; fi
if flag_on "${FIRAS_NO_PATH_UPDATE:-}"; then NO_PATH_UPDATE=1; fi
if flag_on "${FIRAS_UNINSTALL:-}"; then UNINSTALL=1; fi

TMP_DIR=""
STAGING_APP=""
STAGING_RUNTIME=""

# ------------------------------------------------------------------ output
SHOW_AR=1
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *UTF-8*|*utf-8*|*UTF8*|*utf8*) ;;
  *) SHOW_AR=0 ;;
esac
if [ "${FIRAS_LANG:-}" = "en" ]; then SHOW_AR=0; fi

C_RESET="" C_RED="" C_GREEN="" C_YELLOW="" C_CYAN="" C_DIM=""
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_DIM=$'\033[2m'
fi

# text KEY sets AR and EN. English uses printf placeholders.
text() {
  case "$1" in
    title)        AR="تثبيت فراس كود 2"; EN="Firas Code 2 installer" ;;
    step_node)    AR="التحقق من Node.js"; EN="Checking for Node.js" ;;
    node_ok)      AR="Node.js جاهز على جهازك"; EN="Using Node.js %s (%s)" ;;
    node_old)     AR="نسخة Node.js الموجودة قديمة"; EN="The Node.js on this computer (%s) is older than 18.17." ;;
    node_get)     AR="سأنزل نسخة Node.js خاصة بالتطبيق"; EN="Downloading a private copy of Node.js %s. No root access needed." ;;
    node_sum)     AR="أتحقق من سلامة الملف"; EN="Verifying the SHA-256 checksum" ;;
    node_ready)   AR="تم تجهيز Node.js"; EN="Node.js is ready (%s)" ;;
    step_app)     AR="تنزيل التطبيق"; EN="Downloading Firas Code 2" ;;
    step_unpack)  AR="فك الضغط والتثبيت"; EN="Unpacking and installing" ;;
    step_shims)   AR="إعداد الأمر firas"; EN="Creating the firas command" ;;
    path_added)   AR="أضفت أمر firas إلى مسار المستخدم"; EN="Added %s to your PATH in: %s" ;;
    path_present) AR="الأمر firas مضاف إلى المسار من قبل"; EN="firas is already on your PATH." ;;
    path_skipped) AR="تركت المسار كما هو"; EN="PATH was left untouched." ;;
    path_hint)    AR="افتح نافذة طرفية جديدة ثم اكتب: firas"; EN="Open a new terminal window, then type: firas" ;;
    done_new)     AR="تم التثبيت بنجاح"; EN="Installed successfully (version %s)." ;;
    done_upd)     AR="تم التحديث بنجاح"; EN="Updated successfully (version %s)." ;;
    done_code)    AR="ستحتاج رمز الدخول عند أول تشغيل"; EN="On first run, enter the access code you were given." ;;
    done_run)     AR="للبدء اكتب: firas"; EN="To start, type: firas" ;;
    launching)    AR="أشغل فراس كود الآن"; EN="Starting Firas Code 2..." ;;
    warn_code)    AR="تجاهلت رمز الدخول لأن شكله غير صحيح"; EN="The access code looks wrong, so it was ignored. You can enter it on first run." ;;
    err_usage)    AR="خيار غير معروف"; EN="Unknown option: %s. Run with --help to see the options." ;;
    err_value)    AR="الخيار يحتاج إلى قيمة"; EN="The option %s needs a value." ;;
    err_offline)  AR="تعذر الاتصال بالإنترنت"; EN="Could not reach %s. Check your internet connection, proxy or firewall, then run the same command again." ;;
    err_proxy)    AR="الوسيط (Proxy) يطلب تسجيل الدخول"; EN="A proxy server refused the download (%s). Ask your network administrator or try another network." ;;
    err_tls)      AR="تعذر تأمين الاتصال"; EN="A secure connection to %s could not be made. Check your computer date and time." ;;
    err_404)      AR="لم أجد الملف على الخادم"; EN="The server answered 'not found' for %s." ;;
    err_http)     AR="فشل التنزيل"; EN="The download failed: %s" ;;
    err_tools)    AR="ينقصك curl أو wget"; EN="Neither curl nor wget was found. Install one of them and run the command again." ;;
    err_hash)     AR="الملف الذي نزل لا يطابق بصمته"; EN="The Node.js download does not match its published SHA-256 checksum, so nothing was installed. Run the command again." ;;
    err_hashtool) AR="لا توجد أداة لحساب البصمة"; EN="No SHA-256 tool (sha256sum, shasum or openssl) was found." ;;
    err_zip)      AR="ملف التطبيق تالف أو ناقص"; EN="The downloaded archive is damaged or incomplete. Run the command again." ;;
    err_layout)   AR="الملف لا يبدو نسخة من فراس كود"; EN="The archive does not look like Firas Code 2 (bin/firas.js is missing)." ;;
    err_write)    AR="لا أستطيع الكتابة في هذا المجلد"; EN="Cannot write to %s. Choose another folder with --dir." ;;
    err_busy)     AR="تعذر استبدال التطبيق"; EN="Could not replace the app in %s. Close any running Firas Code window, then run the command again." ;;
    err_node_bad) AR="تعذر تشغيل Node.js"; EN="Node.js could not be started: %s" ;;
    err_platform) AR="هذا النظام غير مدعوم"; EN="This system is not supported (%s). Install Node.js 18.17 or newer yourself and run the command again." ;;
    err_repo)     AR="عنوان التطبيق لم يضبط بعد"; EN="This copy of the installer has no repository address. Pass --archive with a file or address." ;;
    err_dir)      AR="مجلد التثبيت غير آمن"; EN="Refusing to use %s as the install folder." ;;
    err_home)     AR="لا أجد مجلد المستخدم"; EN="HOME is not set." ;;
    un_title)     AR="إزالة فراس كود 2"; EN="Uninstalling Firas Code 2" ;;
    un_none)      AR="لا يوجد تثبيت في هذا المكان"; EN="Nothing is installed in %s." ;;
    un_done)      AR="تمت إزالة فراس كود من جهازك"; EN="Firas Code was removed from %s." ;;
    un_kept)      AR="أبقيت إعداداتك وجلساتك المحفوظة"; EN="Your settings and saved sessions were kept. Use --purge to delete them too." ;;
    un_purged)    AR="حذفت كل شيء بما فيه إعداداتك"; EN="Everything in %s was deleted, including settings and sessions." ;;
    un_nopurge)   AR="تجاهلت خيار الحذف الكامل لأن المجلد لا يحمل علامة تثبيت فراس كود، فأزلت مجلدات البرنامج فقط"; EN="The --purge option was ignored: %s has no Firas Code install marker, so only the program's own folders were removed." ;;
    un_path)      AR="أزلت الأمر من مسار المستخدم"; EN="Removed the PATH entry from: %s" ;;
    *)            AR=""; EN="$1" ;;
  esac
}

# say KEY [args...]  (prefix via SAY_PREFIX, colour via SAY_COLOR)
say() {
  local key="$1"; shift
  text "$key"
  local color="${SAY_COLOR:-$C_RESET}" line
  if [ "$SHOW_AR" = 1 ] && [ -n "$AR" ]; then printf '  %s%s%s\n' "$color" "$AR" "$C_RESET"; fi
  # shellcheck disable=SC2059
  line=$(printf "$EN" "$@")
  printf '  %s%s%s%s\n' "$C_DIM" "${SAY_PREFIX:-}" "$line" "$C_RESET"
}

blank() { printf '\n'; }

fail() {
  local code="$1"; shift
  blank
  SAY_COLOR="$C_RED" SAY_PREFIX="" say "$@"
  exit "$code"
}

cleanup() {
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
  if [ -n "$STAGING_APP" ]; then rm -rf "$STAGING_APP"; fi
  if [ -n "$STAGING_RUNTIME" ]; then rm -rf "$STAGING_RUNTIME"; fi
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

on_error() {
  local code=$?
  blank
  printf '  %sUnexpected error (line %s, exit %s).%s\n' "$C_RED" "$1" "$code" "$C_RESET" >&2
  exit 1
}
trap 'on_error $LINENO' ERR

have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------ options
usage() {
  text title
  if [ "$SHOW_AR" = 1 ]; then printf '  %s\n' "$AR"; fi
  printf '  %s\n' "$EN"
  cat <<'EOF'

  Usage
    curl -fsSL https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.sh | bash
    curl -fsSL https://raw.githubusercontent.com/MentronX/firas-code/main/scripts/install.sh | bash -s -- --code FC2-XXXXX-XXXXX

  Options
    --code <code>       access code for the first launch (passed in the FIRAS_CODE variable; the app saves it once it is accepted)
    --dir <folder>      install folder (default: ~/.firas-code)
    --archive <x>       address or path of the app archive (.tar.gz); default: the main branch on GitHub
    --no-launch         do not start Firas Code at the end
    --no-path-update    do not touch your shell start-up files
    --uninstall         remove the app, its Node.js copy and the PATH entry (settings are kept)
    --purge             with --uninstall: also delete settings and saved sessions
    --help              show this text
EOF
}

need_value() {
  if [ "$1" -lt 2 ]; then fail 2 err_value "$2"; fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --code)             need_value "$#" "$1"; CODE="$2"; shift 2 ;;
    --code=*)           CODE="${1#*=}"; shift ;;
    --dir)              need_value "$#" "$1"; INSTALL_DIR="$2"; shift 2 ;;
    --dir=*)            INSTALL_DIR="${1#*=}"; shift ;;
    --archive)          need_value "$#" "$1"; ARCHIVE="$2"; shift 2 ;;
    --archive=*)        ARCHIVE="${1#*=}"; shift ;;
    --no-launch)        NO_LAUNCH=1; shift ;;
    --no-path-update)   NO_PATH_UPDATE=1; shift ;;
    --uninstall)        UNINSTALL=1; shift ;;
    --purge)            PURGE=1; shift ;;
    -h|--help)          usage; exit 0 ;;
    *)                  fail 2 err_usage "$1" ;;
  esac
done

if [ -z "${HOME:-}" ]; then fail 7 err_home; fi
if [ -z "$INSTALL_DIR" ]; then INSTALL_DIR="$HOME/.firas-code"; fi
case "$INSTALL_DIR" in
  "~") INSTALL_DIR="$HOME" ;;
  "~/"*) INSTALL_DIR="$HOME/${INSTALL_DIR#"~/"}" ;;
esac
case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;; esac
while [ "${#INSTALL_DIR}" -gt 1 ] && [ "${INSTALL_DIR%/}" != "$INSTALL_DIR" ]; do INSTALL_DIR="${INSTALL_DIR%/}"; done
case "$INSTALL_DIR" in
  /|"$HOME"|/usr|/bin|/etc|/var|/tmp|/opt|/home|/Users) fail 2 err_dir "$INSTALL_DIR" ;;
esac
BIN_DIR="$INSTALL_DIR/bin"

# ------------------------------------------------------------------ helpers
make_tmp() {
  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/firas-code.XXXXXX")
}

# fetch SOURCE DEST: a local path, a file: address or http(s).
fetch() {
  local src="$1" dest="$2" status rc
  case "$src" in
    http://*|https://*) ;;
    file://*) src="${src#file://}"; [ -f "$src" ] || fail 3 err_404 "$1"; cp "$src" "$dest"; return 0 ;;
    *) [ -f "$src" ] || fail 3 err_404 "$src"; cp "$src" "$dest"; return 0 ;;
  esac
  local host="${src#*://}"; host="${host%%/*}"
  if have curl; then
    rc=0
    status=$(curl -sSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 1800 -o "$dest" -w '%{http_code}' "$src") || rc=$?
    case "$rc" in
      0) ;;
      6|7|28|35|52|55|56) fail 3 err_offline "$host" ;;
      60|51|58|59|77) fail 3 err_tls "$host" ;;
      *) fail 3 err_http "curl exit $rc" ;;
    esac
    case "$status" in
      2*) return 0 ;;
      404|410) fail 3 err_404 "$src" ;;
      407) fail 3 err_proxy "$host" ;;
      *) fail 3 err_http "HTTP $status from $host" ;;
    esac
  elif have wget; then
    rc=0
    wget -q --tries=3 --timeout=30 -O "$dest" "$src" || rc=$?
    case "$rc" in
      0) return 0 ;;
      4) fail 3 err_offline "$host" ;;
      5) fail 3 err_tls "$host" ;;
      8) fail 3 err_404 "$src" ;;
      *) fail 3 err_http "wget exit $rc" ;;
    esac
  else
    fail 3 err_tools
  fi
}

# sha256_of FILE sets SHA (not echoed, so a failure message is never swallowed by a command substitution).
sha256_of() {
  if have sha256sum; then SHA=$(sha256sum "$1" | cut -d' ' -f1)
  elif have shasum; then SHA=$(shasum -a 256 "$1" | cut -d' ' -f1)
  elif have openssl; then SHA=$(openssl dgst -sha256 "$1" | sed 's/^.*= *//')
  else fail 6 err_hashtool
  fi
}

# node_version PATH: prints x.y.z when the binary runs and is new enough.
node_version() {
  local raw major rest minor
  raw=$("$1" -v 2>/dev/null) || return 1
  raw="${raw#v}"
  major="${raw%%.*}"; rest="${raw#*.}"; minor="${rest%%.*}"
  case "$major$minor" in ""|*[!0-9]*) return 1 ;; esac
  if [ "$major" -gt "$MIN_MAJOR" ] || { [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -ge "$MIN_MINOR" ]; }; then
    printf '%s' "$raw"
    return 0
  fi
  printf 'old:%s' "$raw"
  return 1
}

# detect_target sets TARGET to <os>-<arch>.
detect_target() {
  if [ -n "${FIRAS_NODE_TARGET:-}" ]; then TARGET="$FIRAS_NODE_TARGET"; return 0; fi
  local os arch
  case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    *) fail 7 err_platform "$(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    armv7l)        arch=armv7l ;;
    *) fail 7 err_platform "$(uname -m)" ;;
  esac
  if [ "$os" = linux ] && have ldd && { ldd --version 2>&1 || true; } | grep -qi musl; then fail 7 err_platform "musl libc"; fi
  TARGET="$os-$arch"
}

install_runtime() {
  local index_url="${FIRAS_NODE_INDEX_URL:-$DEFAULT_NODE_INDEX}"
  local dist="${FIRAS_NODE_DIST_URL:-$DEFAULT_NODE_DIST}"
  dist="${dist%/}"
  local target os arch token version name tarball expected staging
  detect_target
  target="$TARGET"
  os="${target%%-*}"; arch="${target#*-}"
  if [ "$os" = darwin ]; then token="osx-$arch-tar"; else token="$os-$arch"; fi

  fetch "$index_url" "$TMP_DIR/index.json"
  version=$(tr '{' '\n' < "$TMP_DIR/index.json" | grep '"lts":"' | grep "\"$token\"" | sed -n 's/.*"version":"\(v[0-9][0-9.]*\)".*/\1/p' | head -n 1 || true)
  if [ -z "$version" ]; then fail 3 err_http "no Node.js LTS build for $target was listed"; fi
  name="node-$version-$os-$arch"
  tarball="$name.tar.gz"

  SAY_PREFIX="    " SAY_COLOR="" say node_get "$version"
  fetch "$dist/$version/$tarball" "$TMP_DIR/$tarball"
  SAY_PREFIX="    " SAY_COLOR="" say node_sum
  fetch "$dist/$version/SHASUMS256.txt" "$TMP_DIR/SHASUMS256.txt"
  expected=$(awk -v f="$tarball" '$2 == f { print $1; exit }' "$TMP_DIR/SHASUMS256.txt" || true)
  sha256_of "$TMP_DIR/$tarball"
  if [ -z "$expected" ] || [ "$expected" != "$SHA" ]; then fail 4 err_hash; fi

  staging="$INSTALL_DIR/runtime.new"
  STAGING_RUNTIME="$staging"
  rm -rf "$staging"; mkdir -p "$staging"
  tar -xzf "$TMP_DIR/$tarball" -C "$staging" --strip-components=1 "$name/bin/node" "$name/LICENSE" || fail 4 err_zip
  chmod 755 "$staging/bin/node" 2>/dev/null || true
  [ -f "$staging/bin/node" ] || fail 5 err_write "$INSTALL_DIR"
  node_version "$staging/bin/node" >/dev/null || fail 6 err_node_bad "the downloaded node did not start"
  swap_dir "$staging" "$INSTALL_DIR/runtime"
  SAY_PREFIX="    " SAY_COLOR="" say node_ready "$version"
}

# swap_dir NEW FINAL: rename, with a rollback if the second rename fails.
swap_dir() {
  local new="$1" final="$2" old="$2.old"
  rm -rf "$old"
  if [ -e "$final" ]; then mv "$final" "$old" || fail 5 err_busy "$INSTALL_DIR"; fi
  if ! mv "$new" "$final"; then
    [ -e "$old" ] && mv "$old" "$final"
    fail 5 err_busy "$INSTALL_DIR"
  fi
  rm -rf "$old"
}

write_shim() {
  local file="$1" tmp
  tmp="$file.tmp.$$"
  cat > "$tmp" <<'EOF'
#!/bin/sh
# Firas Code 2 launcher: prefers the private Node.js in ../runtime, else the Node.js on PATH.
self=$0
while [ -h "$self" ]; do
  link=$(readlink "$self")
  case $link in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
root=$(cd "$(dirname "$self")/.." && pwd -P)
if [ -x "$root/runtime/bin/node" ]; then exec "$root/runtime/bin/node" "$root/app/bin/firas.js" "$@"; fi
if command -v node >/dev/null 2>&1; then exec node "$root/app/bin/firas.js" "$@"; fi
echo "Node.js was not found. Run the Firas Code installer again." >&2
exit 127
EOF
  chmod 755 "$tmp"
  mv "$tmp" "$file"
}

# ------------------------------------------------------------------ PATH
rc_files() {
  local f seen=0 shell_name
  shell_name=$(basename "${SHELL:-}")
  RC_LIST=""
  for f in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    if [ -f "$f" ]; then RC_LIST="$RC_LIST $f"; seen=1; fi
  done
  case "$shell_name" in
    zsh)  case "$RC_LIST" in *"$HOME/.zshrc"*) ;; *) RC_LIST="$RC_LIST $HOME/.zshrc"; seen=1 ;; esac ;;
    bash) case "$RC_LIST" in *"$HOME/.bashrc"*) ;; *) RC_LIST="$RC_LIST $HOME/.bashrc"; seen=1 ;; esac ;;
  esac
  if [ "$seen" = 0 ]; then RC_LIST="$HOME/.profile"; fi
}

remove_block() {
  local rc="$1" tmp
  [ -f "$rc" ] || return 0
  grep -qF "$MARK_BEGIN" "$rc" || return 0
  tmp=$(mktemp "${TMPDIR:-/tmp}/firas-rc.XXXXXX")
  sed "/$MARK_BEGIN/,/$MARK_END/d" "$rc" > "$tmp"
  cat "$tmp" > "$rc"
  rm -f "$tmp"
}

shell_dir_literal() {
  case "$1" in
    "$HOME") printf '$HOME' ;;
    "$HOME"/*) printf '$HOME/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

add_path() {
  local rc dir_literal fish_conf touched=""
  dir_literal=$(shell_dir_literal "$BIN_DIR")
  rc_files
  for rc in $RC_LIST; do
    remove_block "$rc"
    if [ -s "$rc" ] && [ -n "$(tail -c 1 "$rc")" ]; then printf '\n' >> "$rc"; fi
    {
      printf '%s\n' "$MARK_BEGIN"
      printf 'case ":$PATH:" in *":%s:"*) ;; *) export PATH="%s:$PATH" ;; esac\n' "$dir_literal" "$dir_literal"
      printf '%s\n' "$MARK_END"
    } >> "$rc"
    touched="$touched ${rc#"$HOME"/}"
  done
  if [ -d "$HOME/.config/fish" ]; then
    fish_conf="$HOME/.config/fish/conf.d/firas-code.fish"
    mkdir -p "$(dirname "$fish_conf")"
    printf 'if not contains -- "%s" $PATH\n  set -gx PATH "%s" $PATH\nend\n' "$BIN_DIR" "$BIN_DIR" > "$fish_conf"
    touched="$touched .config/fish/conf.d/firas-code.fish"
  fi
  PATH_TOUCHED="${touched# }"
}

drop_path() {
  local rc
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do remove_block "$rc"; done
  rm -f "$HOME/.config/fish/conf.d/firas-code.fish"
}

# ------------------------------------------------------------------ uninstall
do_uninstall() {
  SAY_COLOR="$C_CYAN" SAY_PREFIX="" say un_title
  blank
  local found=0 name has_marker=0 looks_ours=0
  # Only the marker this installer writes proves that a whole folder is ours. The folder's name, or an app/bin/firas.js
  # left by an older install, is enough to remove the program's own sub-folders and nothing more: a folder that is
  # merely called .firas-code (or a stranger's folder that happens to hold a bin) is never deleted as a whole.
  if [ -f "$INSTALL_DIR/.firas-install" ] && [ ! -L "$INSTALL_DIR/.firas-install" ]; then has_marker=1; fi
  if [ "$has_marker" = 1 ] || [ "$(basename "$INSTALL_DIR")" = ".firas-code" ] || [ -f "$INSTALL_DIR/app/bin/firas.js" ]; then looks_ours=1; fi
  if [ "$has_marker" = 1 ]; then found=1; fi
  if [ "$looks_ours" = 1 ]; then
    for name in app app.new app.old runtime runtime.new runtime.old bin; do
      if [ -e "$INSTALL_DIR/$name" ]; then found=1; fi
    done
  fi
  if [ "$found" = 0 ]; then SAY_COLOR="$C_YELLOW" SAY_PREFIX="" say un_none "$INSTALL_DIR"; return 0; fi
  for name in app app.new app.old runtime runtime.new runtime.old bin .firas-install; do
    rm -rf "${INSTALL_DIR:?}/$name"
  done
  if [ "$NO_PATH_UPDATE" = 0 ]; then
    drop_path
    SAY_COLOR="" SAY_PREFIX="" say un_path "$HOME/.zshrc, .bashrc, .profile"
  fi
  if [ "$PURGE" = 1 ] && [ "$has_marker" = 1 ]; then
    rm -rf "${INSTALL_DIR:?}"
    SAY_COLOR="$C_GREEN" SAY_PREFIX="" say un_purged "$INSTALL_DIR"
    return 0
  fi
  rmdir "$INSTALL_DIR" 2>/dev/null || true
  SAY_COLOR="$C_GREEN" SAY_PREFIX="" say un_done "$INSTALL_DIR"
  if [ -d "$INSTALL_DIR" ]; then
    if [ "$PURGE" = 1 ]; then SAY_COLOR="$C_YELLOW" SAY_PREFIX="" say un_nopurge "$INSTALL_DIR"; else SAY_COLOR="" SAY_PREFIX="" say un_kept; fi
  fi
}

# ------------------------------------------------------------------ install
read_version() {
  local pkg="$INSTALL_DIR/app/package.json" v=""
  if [ -f "$pkg" ]; then v=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -n 1 || true); fi
  printf '%s' "${v:-2}"
}

do_install() {
  local source="$ARCHIVE" existed=0 launch_code="$CODE" system_node="" old_node="" version
  if [ -z "$source" ]; then
    case "$DEFAULT_ARCHIVE" in *__REPO*) fail 2 err_repo ;; esac
    source="$DEFAULT_ARCHIVE"
  fi
  if [ -n "$launch_code" ]; then
    case "$launch_code" in
      [Ff][Cc]2-*) case "${launch_code#*-}" in *[!0-9A-Za-z-]*|"") launch_code="" ;; esac ;;
      *) launch_code="" ;;
    esac
    if [ -z "$launch_code" ]; then SAY_COLOR="$C_YELLOW" SAY_PREFIX="" say warn_code; fi
  fi

  SAY_COLOR="$C_CYAN" SAY_PREFIX="" say title
  blank

  mkdir -p "$INSTALL_DIR" 2>/dev/null || fail 5 err_write "$INSTALL_DIR"
  [ -w "$INSTALL_DIR" ] || fail 5 err_write "$INSTALL_DIR"
  make_tmp
  if [ -f "$INSTALL_DIR/app/bin/firas.js" ]; then existed=1; fi

  # 1 - Node.js
  SAY_COLOR="" SAY_PREFIX="[1/4] " say step_node
  local ready=0 v candidate
  if [ -x "$INSTALL_DIR/runtime/bin/node" ]; then
    if v=$(node_version "$INSTALL_DIR/runtime/bin/node"); then
      SAY_COLOR="$C_GREEN" SAY_PREFIX="      " say node_ok "$v" "private copy"
      ready=1
    else
      rm -rf "$INSTALL_DIR/runtime"
    fi
  fi
  if [ "$ready" = 0 ]; then
    if have node; then
      candidate=$(command -v node)
      if v=$(node_version "$candidate"); then
        system_node="$v"
      else
        case "$v" in old:*) old_node="${v#old:}" ;; esac
      fi
    fi
    if [ -n "$system_node" ]; then
      SAY_COLOR="$C_GREEN" SAY_PREFIX="      " say node_ok "$system_node" "on PATH"
    else
      if [ -n "$old_node" ]; then SAY_COLOR="$C_YELLOW" SAY_PREFIX="      " say node_old "$old_node"; fi
      install_runtime
    fi
  fi

  # 2 - download
  blank
  SAY_COLOR="" SAY_PREFIX="[2/4] " say step_app
  fetch "$source" "$TMP_DIR/app.tar.gz"

  # 3 - unpack and swap
  blank
  SAY_COLOR="" SAY_PREFIX="[3/4] " say step_unpack
  local staging="$INSTALL_DIR/app.new"
  STAGING_APP="$staging"
  rm -rf "$staging"; mkdir -p "$staging"
  tar -xzf "$TMP_DIR/app.tar.gz" -C "$staging" --strip-components=1 || fail 4 err_zip
  [ -f "$staging/bin/firas.js" ] || fail 4 err_layout
  swap_dir "$staging" "$INSTALL_DIR/app"

  # 4 - launchers and PATH
  blank
  SAY_COLOR="" SAY_PREFIX="[4/4] " say step_shims
  mkdir -p "$BIN_DIR"
  local name
  for name in firas fc2 firas-code; do write_shim "$BIN_DIR/$name"; done
  version=$(read_version)
  printf '{"version":"%s"}\n' "$version" > "$INSTALL_DIR/.firas-install"

  local path_added=0
  if [ "$NO_PATH_UPDATE" = 1 ]; then
    SAY_COLOR="" SAY_PREFIX="      " say path_skipped
  else
    add_path
    SAY_COLOR="$C_GREEN" SAY_PREFIX="      " say path_added "$BIN_DIR" "$PATH_TOUCHED"
    path_added=1
  fi

  blank
  local will_launch=0 on_tty=0
  if [ "$NO_LAUNCH" = 0 ]; then
    if flag_on "${FIRAS_FORCE_LAUNCH:-}"; then
      will_launch=1
    elif [ -t 1 ] && { : < /dev/tty; } 2>/dev/null; then
      will_launch=1; on_tty=1
    fi
  fi

  if [ "$existed" = 1 ]; then SAY_COLOR="$C_GREEN" SAY_PREFIX="" say done_upd "$version"; else SAY_COLOR="$C_GREEN" SAY_PREFIX="" say done_new "$version"; fi
  # A code given with --code only travels with the first launch (the installer never writes it; the app saves it once the service accepts it); without a launch it has to be typed later.
  if [ -z "$launch_code" ] || [ "$will_launch" = 0 ]; then SAY_COLOR="" SAY_PREFIX="" say done_code; fi
  if [ "$path_added" = 1 ]; then SAY_COLOR="" SAY_PREFIX="" say path_hint; else SAY_COLOR="" SAY_PREFIX="" say done_run; fi

  if [ "$will_launch" = 1 ]; then
    blank; SAY_COLOR="$C_CYAN" SAY_PREFIX="" say launching; blank
    export PATH="$BIN_DIR:$PATH"
    # The code goes to the launched program through its environment, never on its command line (visible to every
    # program on the computer and kept in the shell history).
    if [ "$on_tty" = 1 ]; then
      # `curl | bash` leaves stdin on the pipe; the app needs the keyboard.
      if [ -n "$launch_code" ]; then FIRAS_CODE="$launch_code" "$BIN_DIR/firas" < /dev/tty || true; else "$BIN_DIR/firas" < /dev/tty || true; fi
    else
      if [ -n "$launch_code" ]; then FIRAS_CODE="$launch_code" "$BIN_DIR/firas" || true; else "$BIN_DIR/firas" || true; fi
    fi
  fi
}

if [ "$UNINSTALL" = 1 ]; then do_uninstall; else do_install; fi
