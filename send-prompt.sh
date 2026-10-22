#!/usr/bin/env bash
# Type text into the focused field on the connected device.
#
# There is no way to set the device clipboard from hdc -- the shell has no
# pasteboard command and uitest does not expose one -- so this types the text
# instead, which reaches the app the same way a person would.
#
#   ./send-prompt.sh "draw a rotating gear"       text straight through
#   ./send-prompt.sh -f prompt.txt                from a file
#   pbpaste | ./send-prompt.sh -                  from a pipe
#   ./send-prompt.sh -t 640 1146 "some text"      tap that point first, then type
#
# Tap the field yourself (or pass -t) before running: uitest types wherever the
# focus already is.
set -uo pipefail
. "$(cd -- "$(dirname -- "$0")" && pwd)/tool-paths.sh"

PATH="$(vera_hdc_dir):$PATH"
export PATH

TAP_X=""; TAP_Y=""
if [ "${1:-}" = "-t" ]; then TAP_X="$2"; TAP_Y="$3"; shift 3; fi

if [ "${1:-}" = "-f" ]; then
  TEXT=$(cat "$2")
elif [ "${1:-}" = "-" ]; then
  TEXT=$(cat)
else
  TEXT="${1:-}"
fi

if [ -z "$TEXT" ]; then
  echo "usage: send-prompt.sh [-t X Y] \"text\" | -f FILE | -" >&2
  exit 2
fi

if [ -n "$TAP_X" ]; then
  hdc shell "uitest uiInput click $TAP_X $TAP_Y" >/dev/null 2>&1
  sleep 1
fi

# uitest types a single line; newlines would silently truncate the rest.
python3 - "$TEXT" <<'PY'
import shlex, subprocess, sys
text = sys.argv[1]
if '\n' in text:
    print('note: newlines collapsed to spaces -- uitest types one line', file=sys.stderr)
    text = ' '.join(line.strip() for line in text.splitlines() if line.strip())
cmd = 'uitest uiInput text ' + shlex.quote(text)
r = subprocess.run(['hdc', 'shell', cmd], capture_output=True, text=True)
out = (r.stdout + r.stderr).strip()
print(out if out else 'sent', f'({len(text)} chars)')
PY
