# GPTCat Android 1.0.9 修订包

本包基于上传的 `gptcat-android-1.0.8.zip` 审查和修改，保留 Java + Android 系统 API 的轻量结构。

## 已落地
- target/compile SDK 升到 Android 16 / API 36，版本号 1.0.9（versionCode 9）。
- Android 13+ predictive back；Android 7–12 保留旧返回键兼容。
- WebView 禁止 mixed content，开启 Safe Browsing，禁止 JS 自动开新窗口。
- 原生图片与文件桥接只允许 HTTPS；关闭 Auto Backup。
- 下载文件名与 MIME 清洗，修复路径语义和异常 MIME 边界。
- 修复 Blob 下载任务字节数、下载删除语义、旧系统 file:// 回退和发布失败残留。
- Blob/data 桥内存上限收紧到 128 MiB。
- 下载通知 ID 去碰撞；更新链接只接受本仓库官方 HTTPS release 页面。
- 修复测试脚本 locale/源码包无真实签名密钥时的 smoke-test 问题。
- 旧 1.0.8 APK 已从源码包移除，避免误认成修订后二进制。

## 回归
修改树已通过项目回归套件：Java 271 个断言、JS 17 个测试、XML/资源/Manifest 检查与 build smoke。

当前执行环境没有完整 Android SDK 与你的正式签名私钥，因此没有伪造“已签名 1.0.9 APK”的结论。

## 本地运行
```bash
bash tests/check.sh
```

构建 APK 需要 Android SDK Platform 36、Build Tools 36.0.0、JDK 17+ 和原签名密钥：
```bash
export ANDROID_SDK_ROOT=/path/to/android-sdk
export JAVA_HOME=/path/to/jdk-17
export GPTCAT_STORE_PASSWORD='你的密码'
export GPTCAT_KEY_PASSWORD='你的密码'
bash build_apk.sh
```

## 后续建议
1. 引入 AndroidX WebKit 后，用 origin 限制更强的 WebMessageListener 替换传统 JS interface。
2. 大 Blob 下载改为真正的流式方案，进一步降低 WebView 内存峰值。
3. 增加 Android instrumentation/真机 WebView 回归及 API 36 predictive-back 动画验证。
4. 统一 DownloadManager 与本地 Blob 下载的持久化数据模型。
5. 增加不记录聊天正文/Cookie 的崩溃、ANR 与下载失败可观测性。
