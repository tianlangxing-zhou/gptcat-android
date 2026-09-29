#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
CHECK_DIR="$ROOT/.checks"
mkdir -p "$CHECK_DIR"
if [[ -n "${JDK:-${JAVA_HOME:-}}" ]]; then
  JAVA_BIN="${JDK:-$JAVA_HOME}/bin/java"
  [[ -x "$JAVA_BIN" ]] || JAVA_BIN="$JAVA_BIN.exe"
else
  JAVA_BIN="$(command -v java)"
fi

echo '[1/5] Java 语法与独立逻辑测试（需要 JDK 17+，不依赖 Android SDK）'
"$JAVA_BIN" com.sun.tools.javac.Main -encoding UTF-8 -source 8 -target 8 -d "$CHECK_DIR" \
  tests/CoreTests.java tests/ParseSources.java \
  app/src/main/java/com/gptcat/app/web/UrlPolicy.java \
  app/src/main/java/com/gptcat/app/image/ImageSizing.java
"$JAVA_BIN" -cp "$CHECK_DIR" CoreTests
find app/src/main/java -name '*.java' -print0 > "$CHECK_DIR/sources.list"
sources=()
while IFS= read -r -d '' source; do sources+=("$source"); done < "$CHECK_DIR/sources.list"
"$JAVA_BIN" -cp "$CHECK_DIR" ParseSources "${sources[@]}"

echo '[2/5] JavaScript 模型回归测试（需要 Node.js 18+）'
node --check app/src/main/res/raw/inject.js
node --test tests/inject.test.js

echo '[3/5] XML 与资源引用检查（需要 Python 3）'
PYTHON_BIN="${PYTHON:-python3}"
"$PYTHON_BIN" tests/check_resources.py

echo '[4/5] Bash 语法与假工具链构建流程测试'
bash -n build_apk.sh
"$PYTHON_BIN" tests/build_smoke.py

echo '[5/5] 本地检查通过；Android 完整编译、WebView 和真机验证需另行运行'
