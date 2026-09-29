# GPTCat Android 优化替换包

本包基于本次上传的 `gptcat_app.zip` 修改。GitHub 页面未能读取，因此没有把未核实的线上改动合并进来。
保留包名 `com.gptcat.app`、首页地址、minSdk 24、targetSdk 35、现有资源和原签名密钥；继续使用 Java + Android 系统 API，没有增加第三方依赖或改成 Gradle 工程。

## 直接替换

1. 解压后，把 `gptcat_app/` **里面的文件和目录**覆盖到你原工程的根目录，与原来的 `app/`、`build_apk.sh` 对齐。新增的 `image/`、`ui/`、`web/` Java 子目录也要一起复制。
2. 在原来的 Git Bash 环境执行 `bash build_apk.sh`。原有 D 盘 SDK/JDK 路径仍作为默认值；工程本身的位置会自动识别。
3. 构建成功后使用 `output/GPTCat-release.apk`。包内没有旧 APK、旧 class/dex 或构建缓存；覆盖操作可能保留你本机原有的旧 `output/`，请以本次构建成功后的产物为准。

上传包里的 `app/src/main/gptcat.keystore` 已逐字节保留，仍被 `.gitignore` 排除。缺失该文件时，构建会提示恢复原密钥，不再自动生成另一把密钥。

工具链位置不同时，先配置环境变量，例如：

```bash
export ANDROID_SDK_ROOT="/d/your/android-sdk"
export JAVA_HOME="/d/your/jdk-17"
bash build_apk.sh
```

也支持原来的 `SDK`、`JDK` 变量；`BUILD_TOOLS_VERSION` 默认 `36.0.0`，`COMPILE_SDK` 默认 `35`。签名可通过 `KEYSTORE`、`KEY_ALIAS`、`GPTCAT_STORE_PASSWORD`、`GPTCAT_KEY_PASSWORD` 覆盖。图标已在源码里，通常无需重新生成；修改图标生成器后可运行 `REGENERATE_ICONS=1 PYTHON=python3 bash build_apk.sh`。

## 主要改动

| 位置 | 调整和效果 |
| --- | --- |
| `MainActivity` | 只保留窗口和生命周期协调，网页、文件选择、图片桥各自独立。 |
| `web/BrowserController` | 集中管理网页导航、状态恢复和脚本注入；错误页重试原网址；渲染进程退出后销毁旧 WebView 并建立新实例，避免重用失效对象。 |
| `web/FileChooserHandler` | 文件选择完成、取消、启动失败和页面销毁时统一收尾，避免遗留上传回调。 |
| `web/ImageBridge` | HTTP 图片传网址；Blob/data 图片按 48 KiB 二进制块写私有缓存，Intent 仅传缓存文件名，避免大图触发 Binder 大小限制。桥接校验随机令牌，限制单图 32 MiB。 |
| `image/ImageLoader` | 替换 AsyncTask；下载、探测尺寸和预览解码放到后台。切换图片、退出时取消旧请求；预览限制在约 4 百万像素、单边不超过 4096 像素。跳转按目标 URL 重新获取 Cookie。 |
| `image/GallerySaver` | 后台复制原始文件，保留原分辨率和格式，避免主线程 PNG 压缩。Android 10+ 使用待完成相册条目；失败会清理半成品。 |
| `ImageViewerActivity` | 加载指示、重复保存抑制、旧请求结果丢弃、旋转时复用缓存；Android 7–9 补齐保存所需的运行时权限请求。 |
| `ui/WindowInsetsHelper` | Android 11+ 才访问新版 systemBars/IME API；Android 7–10 使用系统窗口适配，修复旧 API 路径中的兼容性问题。 |
| `res/raw/inject.js` | 移除每 1.5 秒轮询；页面变化时合并刷新，最多每秒一次。一次查询找全部快捷入口，排除自身 UI，隐藏页面暂停扫描。Blob 图片不再经 canvas 转成整张 PNG。 |
| `build_apk.sh` | 工程路径自动定位，支持带空格路径；工具链和签名预检在清理前执行。默认复用图标，按 Java 8 目标编译，签名验证成功后才替换正式 APK。 |

单张编码文件上限为 32 MiB；超过上限会显示失败提示。预览采样不影响保存原图。已经完成的缓存通常在退出查看页后清理，异常中断残留在后续创建图片缓存时按 24 小时期限清理。

## 验证结果与范围

本次已实际运行通过：

- 11 个 Android Java 源文件的 Java 8 语法解析。独立逻辑类由 JDK 17 编译并执行，266 项断言覆盖域名边界、非法网址和超大图片采样。
- 9 项 Node.js DOM/bridge **模型测试**，覆盖脚本重复注入、空闲时无轮询、快捷菜单自匹配、SPA 连续更新合并、页面隐藏/恢复、模型入口、图片传输字节一致性、传输失败和大小限制。
- 4 个 XML 文件解析，以及 Java/XML 本地资源引用检查。
- Bash 语法检查和**假工具链**流程测试，覆盖路径包含空格、新增子目录源码、签名验证失败保留旧 APK、预检失败保留构建目录。
- 原签名密钥、Manifest、首页布局和图标与上传版逐字节一致。

**尚未完成完整 Android SDK 编译、APK 签名安装和真机/WebView 验证。** 当前执行环境没有 Android SDK。语法解析、模型测试和假工具链测试不能替代这些验证；也没有实测帧率、耗电量或启动时间提升比例。

可在装有 JDK 17、Node.js 18+、Python 3 的机器上复跑本地检查：

```bash
bash tests/check.sh
```

构建后建议在 Android 7–9 和 Android 15 各检查一次：登录与站内跳转、文件单选/多选与取消、快捷菜单在聊天页/登录页切换、大图与 Blob 图片查看、保存原图、权限拒绝后重新授权、键盘弹出、横竖屏切换及断网重试。图片需登录时，还需使用实际站点账号验证 Cookie 和重定向行为。

## 实现参考

- [Android 官方：WebView 渲染进程终止后的恢复](https://developer.android.com/develop/ui/views/layout/webapps/handle-termination)
- [Android 官方：共享存储中的媒体文件](https://developer.android.com/training/data-storage/shared/media)

`CHANGELOG_文件清单.txt` 列出本包相对上传源码的新增和修改文件。没有需要手工删除的旧 Java 源文件。
