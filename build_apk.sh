#!/usr/bin/env bash
set -euo pipefail

# 可直接放回原工程。所有路径相对脚本解析；仍兼容原来的 D 盘工具链。
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/app/src/main"
BUILD="$ROOT/build"
OUT="$ROOT/output"
SDK="${SDK:-${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/d/3DGS/.android-sdk}}}"
JDK="${JDK:-${JAVA_HOME:-/d/3DGS/.toolchain/jdk/jdk-17.0.20.1+1}}"
BUILD_TOOLS_VERSION="${BUILD_TOOLS_VERSION:-36.0.0}"
COMPILE_SDK="${COMPILE_SDK:-35}"
BT="$SDK/build-tools/$BUILD_TOOLS_VERSION"
PLATFORM="$SDK/platforms/android-$COMPILE_SDK/android.jar"
KEYSTORE="${KEYSTORE:-$SRC/gptcat.keystore}"
KEY_ALIAS="${KEY_ALIAS:-gptcat}"
# 默认兼容现有私钥；可由环境变量覆盖，签名密码不出现在进程命令参数中。
export GPTCAT_STORE_PASSWORD="${GPTCAT_STORE_PASSWORD:-gptcat123}"
export GPTCAT_KEY_PASSWORD="${GPTCAT_KEY_PASSWORD:-$GPTCAT_STORE_PASSWORD}"

fail() { echo "错误：$*" >&2; exit 1; }
resolve_tool() {
  local candidate="$1"
  if [[ -x "$candidate" ]]; then echo "$candidate";
  elif [[ -x "$candidate.exe" ]]; then echo "$candidate.exe";
  else fail "缺少工具 $candidate；请设置 SDK / JDK 或 ANDROID_SDK_ROOT / JAVA_HOME"; fi
}
JAVA_BIN="$(resolve_tool "$JDK/bin/java")"
JAVAC_BIN="$(resolve_tool "$JDK/bin/javac")"
JAR_BIN="$(resolve_tool "$JDK/bin/jar")"
AAPT2="$(resolve_tool "$BT/aapt2")"
ZIPALIGN="$(resolve_tool "$BT/zipalign")"
[[ -f "$PLATFORM" ]] || fail "缺少 $PLATFORM"
[[ -f "$BT/lib/d8.jar" && -f "$BT/lib/apksigner.jar" ]] || fail "Android build-tools 不完整：$BT"
[[ -f "$KEYSTORE" ]] || fail "找不到原签名密钥 $KEYSTORE；请恢复原文件，避免换签名后无法覆盖安装"

# 签名可用性先检查，避免编译完成才发现密码/别名错误。
KEYTOOL_BIN="$(resolve_tool "$JDK/bin/keytool")"
"$KEYTOOL_BIN" -list -keystore "$KEYSTORE" -alias "$KEY_ALIAS" \
  -storepass:env GPTCAT_STORE_PASSWORD >/dev/null

# 图标已在源码中，只有主动修改图标时才重生成。
if [[ "${REGENERATE_ICONS:-0}" == "1" ]]; then
  PYTHON_BIN="${PYTHON:-python3}"
  "$PYTHON_BIN" "$ROOT/gen_icons.py"
fi

[[ "$BUILD" == "$ROOT/build" && "$ROOT" != / ]] || fail "构建目录无效"
rm -rf -- "$BUILD"
mkdir -p "$BUILD/compiled" "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$OUT"

echo "[1/7] 编译资源"
"$AAPT2" compile -o "$BUILD/compiled" --dir "$SRC/res"
echo "[2/7] 链接资源"
"$AAPT2" link -I "$PLATFORM" --manifest "$SRC/AndroidManifest.xml" \
  --java "$BUILD/gen" -o "$BUILD/app-unsigned.apk" "$BUILD/compiled"/*.flat

echo "[3/7] 编译 Java"
sources=()
find "$SRC/java" "$BUILD/gen" -name '*.java' -print0 > "$BUILD/java-sources.list"
while IFS= read -r -d '' path; do sources+=("$path"); done < "$BUILD/java-sources.list"
"$JAVAC_BIN" -encoding UTF-8 -source 8 -target 8 -classpath "$PLATFORM" \
  -d "$BUILD/classes" "${sources[@]}"

echo "[4/7] 生成 DEX"
classes=()
find "$BUILD/classes" -name '*.class' -print0 > "$BUILD/java-classes.list"
while IFS= read -r -d '' path; do classes+=("$path"); done < "$BUILD/java-classes.list"
"$JAVA_BIN" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 --lib "$PLATFORM" \
  --output "$BUILD/dex" --min-api 24 "${classes[@]}"

echo "[5/7] 打包 DEX"
# 在 dex 目录调用 jar，将所有 classes*.dex 加入 APK，兼容后续代码增长。
(cd "$BUILD/dex" && "$JAR_BIN" uf "$BUILD/app-unsigned.apk" classes*.dex)
echo "[6/7] 对齐 APK"
"$ZIPALIGN" -p 4 "$BUILD/app-unsigned.apk" "$BUILD/app-aligned.apk"
echo "[7/7] 签名并验证"
"$JAVA_BIN" -cp "$BT/lib/apksigner.jar" com.android.apksigner.ApkSignerTool sign \
  --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass env:GPTCAT_STORE_PASSWORD --key-pass env:GPTCAT_KEY_PASSWORD \
  --out "$BUILD/GPTCat-release.apk" "$BUILD/app-aligned.apk"
"$JAVA_BIN" -cp "$BT/lib/apksigner.jar" com.android.apksigner.ApkSignerTool verify \
  --verbose --print-certs "$BUILD/GPTCat-release.apk"
# 仅在签名校验通过后替换 output 的正式产物。
mv -f -- "$BUILD/GPTCat-release.apk" "$OUT/GPTCat-release.apk"
if [[ -f "$BUILD/GPTCat-release.apk.idsig" ]]; then
  mv -f -- "$BUILD/GPTCat-release.apk.idsig" "$OUT/GPTCat-release.apk.idsig"
else
  rm -f -- "$OUT/GPTCat-release.apk.idsig"
fi
echo "构建完成：$OUT/GPTCat-release.apk"
