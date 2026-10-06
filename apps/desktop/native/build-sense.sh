#!/usr/bin/env bash
# Builds Polly Sense and wraps it in a signed app bundle:
#   apps/desktop/native/build/Polly Sense.app
# Signing with a stable identity keeps the user's Accessibility and Screen Recording
# grants across rebuilds; an ad-hoc signature would ask for them again every time.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package="$here/PollySense"
app="$here/build/Polly Sense.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-sense: Polly Sense is macOS only, skipping" >&2
  exit 0
fi

echo "build-sense: compiling"
swift build -c release --package-path "$package"
binary="$(swift build -c release --package-path "$package" --show-bin-path)/PollySense"

# Files are replaced in place rather than the bundle recreated, so Launch Services keeps its record.
mkdir -p "$app/Contents/MacOS"
cp "$binary" "$app/Contents/MacOS/PollySense"
cp "$package/Info.plist" "$app/Contents/Info.plist"

identity="$(security find-identity -v -p codesigning 2>/dev/null | awk '/"Apple Development/ { print $2; exit }')"
if [[ -z "$identity" ]]; then
  echo "build-sense: warning: no Apple Development identity found; signing ad hoc." >&2
  echo "build-sense: warning: macOS will ask for Accessibility and Screen Recording again after each rebuild." >&2
  identity="-"
fi

codesign --force --options runtime --timestamp=none --sign "$identity" "$app"
codesign --verify --strict "$app"
echo "build-sense: built $app"
