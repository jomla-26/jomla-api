#!/usr/bin/env bash
# usage: build.sh <app> <url> <name> <appId>
set -euo pipefail
APP="$1"; URL="$2"; NAME="$3"; ID="$4"
ROOT="$(pwd)"; W="$ROOT/android/work/$APP"
rm -rf "$W"; mkdir -p "$W/www"; cd "$W"
echo '<!doctype html><meta charset=utf-8><title>جملة</title><body style="background:#181d2a;color:#fff;font-family:sans-serif;text-align:center;padding-top:40vh">جارٍ التحميل…</body>' > www/index.html
npm init -y >/dev/null
npm i @capacitor/core@6 @capacitor/cli@6 @capacitor/android@6 >/dev/null
cat > capacitor.config.json <<J
{ "appId": "$ID", "appName": "$NAME", "webDir": "www",
  "server": { "url": "$URL", "cleartext": false, "allowNavigation": ["*.jomla-ly.com","jomla-ly.com","*.supabase.co","*.openstreetmap.org","*.up.railway.app"] },
  "android": { "allowMixedContent": false } }
J
npx cap add android >/dev/null
M=android/app/src/main/AndroidManifest.xml
sed -i 's#<application#<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n    <application#' "$M"
curl -fsSL "$URL/icon-192.png" -o icon.png || true
if [ -s icon.png ]; then
  rm -rf android/app/src/main/res/mipmap-anydpi-v26
  for d in android/app/src/main/res/mipmap-*; do for f in ic_launcher ic_launcher_round ic_launcher_foreground; do cp icon.png "$d/$f.png"; done; done
fi
npx cap sync android >/dev/null
( cd android && ./gradlew assembleDebug --no-daemon -q )
mkdir -p "$ROOT/android/out"
cp android/app/build/outputs/apk/debug/app-debug.apk "$ROOT/android/out/jomla-$APP.apk"
ls -la "$ROOT/android/out"
