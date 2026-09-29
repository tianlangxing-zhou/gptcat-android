#!/usr/bin/env bash
set -e

# ===== 工具链（本地 D 盘，已实测存在）=====
SDK=/d/3DGS/.android-sdk
JDK=/d/3DGS/.toolchain/jdk/jdk-17.0.20.1+1
BT=$SDK/build-tools/36.0.0
PLATFORM=$SDK/platforms/android-35/android.jar
PYTHON="C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe"

# ===== 工程路径 =====
ROOT=/d/photo_apk/gptcat_app
SRC=$ROOT/app/src/main
BUILD=$ROOT/build
OUT=$ROOT/output
KEYSTORE=$SRC/gptcat.keystore

mkdir -p "$BUILD" "$OUT"

echo "[1/8] 生成 launcher 图标"
"$PYTHON" "$ROOT/gen_icons.py"

echo "[2/8] aapt2 编译资源"
mkdir -p "$BUILD/compiled"
"$BT/aapt2" compile -o "$BUILD/compiled" --dir "$SRC/res"

echo "[3/8] aapt2 链接 (生成 R.java + 未签名 APK)"
"$BT/aapt2" link -I "$PLATFORM" \
  --manifest "$SRC/AndroidManifest.xml" \
  --java "$BUILD/gen" \
  -o "$BUILD/app-unsigned.apk" \
  "$BUILD/compiled"/*.flat

echo "[4/8] javac 编译 Java"
"$JDK/bin/javac" -encoding UTF-8 -cp "$PLATFORM" -d "$BUILD/classes" \
  "$BUILD/gen/com/gptcat/app/R.java" \
  "$SRC/java/com/gptcat/app/MainActivity.java"

echo "[5/8] d8 转 dex"
mkdir -p "$BUILD/dex"
"$JDK/bin/java" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --lib "$PLATFORM" \
  --output "$BUILD/dex" \
  --min-api 24 \
  $(find "$BUILD/classes" -name '*.class')

echo "[6/8] 注入 classes.dex 进 APK"
"$JDK/bin/jar" uf "$BUILD/app-unsigned.apk" -C "$BUILD/dex" classes.dex

echo "[7/8] zipalign 对齐"
"$BT/zipalign" -p 4 "$BUILD/app-unsigned.apk" "$BUILD/app-aligned.apk"

echo "[8/8] apksigner 签名"
if [ ! -f "$KEYSTORE" ]; then
  "$JDK/bin/keytool" -genkeypair -v \
    -keystore "$KEYSTORE" -alias gptcat \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass gptcat123 -keypass gptcat123 \
    -dname "CN=GPTCat, OU=Personal, O=Personal, L=Unknown, ST=Unknown, C=CN"
fi
"$JDK/bin/java" -cp "$BT/lib/apksigner.jar" com.android.apksigner.ApkSignerTool sign \
  --ks "$KEYSTORE" --ks-key-alias gptcat \
  --ks-pass pass:gptcat123 --key-pass pass:gptcat123 \
  --out "$OUT/GPTCat-release.apk" \
  "$BUILD/app-aligned.apk"

echo "=== 产物 ==="
ls -l "$OUT/GPTCat-release.apk"
echo "size(bytes): $(stat -c%s "$OUT/GPTCat-release.apk")"
md5sum "$OUT/GPTCat-release.apk"
sha256sum "$OUT/GPTCat-release.apk"
echo "=== 签名证书 SHA-256 ==="
"$JDK/bin/keytool" -list -printcert -jarfile "$OUT/GPTCat-release.apk" 2>/dev/null | grep -i "SHA-256" || true
echo "=== 签名方案校验 ==="
"$JDK/bin/java" -cp "$BT/lib/apksigner.jar" com.android.apksigner.ApkSignerTool verify --print-certs "$OUT/GPTCat-release.apk" 2>&1 | head -20
