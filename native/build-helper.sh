#!/bin/bash
set -euo pipefail

native_dir="$(cd "$(dirname "$0")" && pwd)"
output_dir="${BREAK_DELEGATE_NATIVE_OUTPUT:-$native_dir/generated}"
mkdir -p "$output_dir"
version="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version.split(/[-+]/)[0]' "$native_dir/../package.json")"

# Verify the exact bundle being packed, including both signed slices and the release version.
verify_bundle() {
    local candidate="$1" plist architectures
    plist="$candidate/Contents/Info.plist"
    [[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw "$plist")" == "io.laststance.openclaw-break-delegate" ]]
    [[ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw "$plist")" == "$version" ]]
    /usr/bin/codesign --verify --strict --all-architectures "$candidate"
    architectures=" $(xcrun lipo "$candidate/Contents/MacOS/BreakDelegate" -archs) "
    [[ "$architectures" == *" arm64 "* && "$architectures" == *" x86_64 "* ]]
}

# Packing an already notarized release must preserve its original signed bytes and ticket.
if [[ "${BREAK_DELEGATE_REUSE_STAPLED:-0}" == 1 ]]; then
    app="$output_dir/BreakDelegate.app"
    verify_bundle "$app"
    xcrun stapler validate "$app"
    /usr/sbin/spctl --assess --type execute "$app"
    printf '%s\n' "$app"
    exit 0
fi

build_dir="$(mktemp -d "$output_dir/.build.XXXXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
app="$build_dir/BreakDelegate.app"
binary="$app/Contents/MacOS/BreakDelegate"
mkdir -p "$app/Contents/MacOS"
cp "$native_dir/macos/Info.plist" "$app/Contents/Info.plist"

/usr/bin/plutil -replace CFBundleShortVersionString -string "$version" "$app/Contents/Info.plist"
/usr/bin/plutil -replace CFBundleVersion -string "$version" "$app/Contents/Info.plist"

sdk="$(xcrun --sdk macosx --show-sdk-path)"
for cpu in arm64 x86_64; do
    xcrun swiftc -O -swift-version 5 -target "$cpu-apple-macos13.0" -sdk "$sdk" \
        "$native_dir/macos/Surface.swift" "$native_dir/macos/ReviewWindow.swift" "$native_dir/macos/BreakApp.swift" \
        "$native_dir/macos/ProcessClassifier.swift" "$native_dir/macos/main.swift" \
        -o "$build_dir/$cpu"
done
xcrun lipo -create "$build_dir/arm64" "$build_dir/x86_64" -output "$binary"

# Every build is signed. Developer ID release builds also use Apple's secure timestamp.
identity="${BREAK_DELEGATE_SIGN_IDENTITY:--}"
if [[ "$identity" == "-" ]]; then
    /usr/bin/codesign --force --sign - --options runtime --timestamp=none "$app"
else
    /usr/bin/codesign --force --sign "$identity" --options runtime --timestamp "$app"
fi
verify_bundle "$app"

# Keep the previously built app until its replacement is verified.
if [[ -e "$output_dir/BreakDelegate.app" ]]; then
    mv "$output_dir/BreakDelegate.app" "$build_dir/previous.app"
fi
if ! mv "$app" "$output_dir/BreakDelegate.app"; then
    if [[ -d "$build_dir/previous.app" ]]; then mv "$build_dir/previous.app" "$output_dir/BreakDelegate.app"; fi
    exit 1
fi
printf '%s\n' "$output_dir/BreakDelegate.app"
