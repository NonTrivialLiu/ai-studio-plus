#!/bin/sh
set -eu
cd "$(dirname "$0")"
node scripts/build.mjs
xcodebuild -project 'safari/AI Studio Bubbles/AI Studio Bubbles.xcodeproj' \
  -scheme 'AI Studio Bubbles' -configuration Debug \
  -derivedDataPath build CODE_SIGN_IDENTITY=- build
