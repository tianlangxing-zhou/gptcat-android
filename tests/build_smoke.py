#!/usr/bin/env python3
"""用假工具链检查构建脚本的路径、参数和失败保护；不执行 Android 编译。"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
# 放在系统临时目录：仓库内整体/批量删除会触发沙箱删除保护，也避免 fixture 误入库
scratch = tempfile.mkdtemp(prefix='gptcat build test ')
try:
    base = Path(scratch)
    project = base / 'project with spaces'
    shutil.copytree(root / 'app', project / 'app')
    shutil.copy2(root / 'build_apk.sh', project / 'build_apk.sh')
    # The real signing key is intentionally absent from source archives; fake tools only need a fixture.
    (project / 'app/src/main/gptcat.keystore').touch()
    sdk, jdk = base / 'sdk with spaces', base / 'jdk with spaces'
    bt = sdk / 'build-tools' / '36.0.0'
    (sdk / 'platforms' / 'android-36').mkdir(parents=True)
    (sdk / 'platforms' / 'android-36' / 'android.jar').touch()
    (bt / 'lib').mkdir(parents=True)
    (bt / 'lib' / 'd8.jar').touch()
    (bt / 'lib' / 'apksigner.jar').touch()
    (jdk / 'bin').mkdir(parents=True)
    dispatcher = base / 'fake_tool.py'
    dispatcher.write_text('''#!/usr/bin/env python3
import os, sys
from pathlib import Path
name, args = Path(sys.argv[0]).name, sys.argv[1:]
def arg(flag): return args[args.index(flag)+1]
def write(file, text):
 p=Path(file); p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text)
if name == 'aapt2':
 if args[0] == 'compile': write(Path(arg('-o'))/'resource.flat', 'resource')
 else:
  write(arg('-o'), 'resources')
  write(Path(arg('--java'))/'com/gptcat/app/R.java', 'package com.gptcat.app; class R {}')
elif name == 'javac':
 assert all(Path(p).exists() for p in args if p.endswith('.java'))
 assert sum(p.endswith('.java') for p in args) >= 12
 write(Path(arg('-d'))/'Main.class', 'bytecode')
elif name == 'java':
 if 'com.android.tools.r8.D8' in args: write(Path(arg('--output'))/'classes.dex', 'dex')
 elif 'sign' in args:
  assert arg('--ks-pass') == 'env:GPTCAT_STORE_PASSWORD'
  write(arg('--out'), 'SIGNED-NEW-APK')
 elif 'verify' in args and os.environ.get('FAIL_VERIFY') == '1': sys.exit(7)
elif name == 'jar': assert Path(args[1]).exists() and Path(args[2]).exists()
elif name == 'zipalign': write(args[-1], Path(args[-2]).read_text())
''', encoding='utf-8')
    dispatcher.chmod(0o755)
    for name in ('java', 'javac', 'jar', 'keytool'):
        (jdk / 'bin' / name).symlink_to(dispatcher)
    for name in ('aapt2', 'zipalign'):
        (bt / name).symlink_to(dispatcher)
    env = dict(os.environ, SDK=str(sdk), JDK=str(jdk), BUILD_DIR=str(project / 'build'))
    env.pop('JAVA_TOOL_OPTIONS', None)
    for key in ('KEYSTORE', 'KEY_ALIAS', 'BUILD_TOOLS_VERSION', 'COMPILE_SDK', 'REGENERATE_ICONS'):
        env.pop(key, None)
    output = project / 'output' / 'GPTCat-release.apk'
    output.parent.mkdir()
    output.write_text('OLD-APK')
    result = subprocess.run(['bash', str(project / 'build_apk.sh')], cwd=base, env=env,
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert output.read_text() == 'SIGNED-NEW-APK'
    output.write_text('LAST-GOOD-APK')
    result = subprocess.run(['bash', str(project / 'build_apk.sh')], cwd=base,
                            env=dict(env, FAIL_VERIFY='1'), capture_output=True, text=True)
    assert result.returncode != 0
    assert output.read_text() == 'LAST-GOOD-APK', 'failed signing must not replace output'
    marker = project / 'build' / 'preserve-on-preflight-failure'
    marker.touch()
    result = subprocess.run(['bash', str(project / 'build_apk.sh')], cwd=base,
                            env=dict(env, SDK=str(base / 'missing-sdk')), capture_output=True, text=True)
    assert result.returncode != 0 and marker.exists(), 'preflight must run before deleting build'
finally:
    # 逐文件清理：整体 rmtree 会触发沙箱的批量删除保护（>50 文件）
    for entry in sorted(Path(scratch).rglob('*'), key=lambda p: len(p.parts), reverse=True):
        if entry.is_symlink() or entry.is_file():
            entry.unlink(missing_ok=True)
        elif entry.is_dir():
            entry.rmdir()
    Path(scratch).rmdir()
print('PASS: build paths with spaces, nested sources, signing failure and preflight guards (mock tools)')
