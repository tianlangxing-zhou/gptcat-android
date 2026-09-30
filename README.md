# GPTCat Android 1.0.11 修订包

WebView 壳应用「佐助」，包名 `com.gptcat.app`（**不要改**：改了无法覆盖安装，登录态会丢）。

## 1.0.11 已落地

- **修复站点「设置」弹窗里「常规 / 数据管理」标签切不回去**：标签栏左端有一个装饰用的渐变遮罩层（`position:sticky` + `z-index:1`，只有 `mask-image`，class 带 `md:hidden`），它默认 `pointer-events:auto`，正好压住第一枚标签「常规」，把点击整块吃掉 —— 表现是「数据管理 能点、返回 常规 点不动」。注入样式让标签栏里的非 `[role="tab"]` 子元素一律点击穿透。

## 1.0.10 已落地

- **浅色主题回归修复**：此前 manifest 用 `Theme.Material.NoActionBar`（深色）。targetSdk ≥ 33 后 WebView 会把主题的深浅偏好透给网页，站点按 `prefers-color-scheme: dark` 整页转深色，启动时还会先闪一下深色窗口。改为浅色主题，并在 `attachBaseContext` 里把 uiMode 固定为 `UI_MODE_NIGHT_NO`。图片查看页保持深色底（看照片更合适，且没有网页）。
- **安全区不再双重留白**：系统栏留白已由 root padding 让出，`WindowInsetsHelper` 却把 insets 继续传下去，WebView 又把同一段留白映射到 CSS `env(safe-area-inset-*)`，页面再垫一次。现在返回 `WindowInsets.CONSUMED`。
- **返回键语义修正**：只有网页能后退时才抢占返回键；根页面交给系统（退到后台），不再 `finish()` 销毁 WebView 会话。API 24–32 与 Android 12+ 的"退到后台"对齐。
- **分屏/折叠屏不再重建 Activity**：`configChanges` 补齐 `smallestScreenSize|screenLayout`，尺寸变化只走回调，正在输入的内容不丢。
- **下载文件名按 UTF-8 字节截断**：上限 200 字节（ext4/f2fs 255 字节硬限制），保留扩展名，按码点切分避免切开 emoji 代理对，过滤 `U+202E` 等双向控制符（否则 `invoice\u202Egpj.apk` 能伪装扩展名）与孤立代理项。
- **相册保存失败不再卡死**：`GallerySaver` 把 MediaStore 抛出的 `RuntimeException` 统一转成 `IOException`，调用方只 catch `IOException` 也能正常收尾。
- **下载完成接收器瘦身**：用户在系统通知里取消/删除任务同样会发 `DOWNLOAD_COMPLETE`，原实现会误报"下载失败"。现在只做 prefs 记账清理，不发通知（也避免与系统完成通知重复）。顺带修掉历史遗留的 prefs 名不一致（`gptcat_downloads` vs `gptcat-downloads`）——接收器此前从未真正生效。
- **UA 与 Cookie 对齐**：下载/图片请求改用 WebView 的真实 UA（不再是 Dalvik 的 `System.getProperty("http.agent")`），避免站点 Cookie（如 `cf_clearance`）因 UA 不一致而拒绝；Cookie 只附加给站点自家主机，避免重定向把凭据带到外域。
- **签名口令不再内置默认值**：老默认口令已随源码公开，等于没有保护。现在必须由 `GPTCAT_STORE_PASSWORD` 提供，缺失时在编译前就明确报错。
- **AI 生成图片一次点击即可预览**：站点把生成图放在带 Tailwind 任意值类名 `keyboard-open:pb-[calc(var(--composer-height,100px))]` 的容器里，类名含 `composer` 子串，被 `[class*="composer"]` 误判成输入区而吞掉点击。现在类名启发式必须同时满足"容器内确实存在可编辑元素"。

## 1.0.9 已落地

- target/compile SDK 升到 Android 16 / API 36（versionCode 9）。
- Android 13+ predictive back；Android 7–12 保留旧返回键兼容。
- WebView 禁止 mixed content，开启 Safe Browsing，禁止 JS 自动开新窗口。
- 原生图片与文件桥接只允许 HTTPS；关闭 Auto Backup。
- 下载文件名与 MIME 清洗，修复路径语义和异常 MIME 边界。
- 修复 Blob 下载任务字节数、下载删除语义、旧系统 file:// 回退和发布失败残留。
- Blob/data 桥内存上限收紧到 128 MiB。
- 下载通知 ID 去碰撞；更新链接只接受本仓库官方 HTTPS release 页面。

## 安全不变量（`tests/check_resources.py` 会断言，别破坏）

- `allowBackup=false`、`usesCleartextTraffic=false`、targetSdk 36。
- 图片/下载/原生桥**只接受 HTTPS**。
- WebView mixed content = `NEVER_ALLOW` + Safe Browsing + 禁 JS 开新窗口。
- 桥内存上限 128 MiB（JS `MAX_FILE_BYTES` 与 `DownloadCenter.MAX_TEMP_BYTES` 必须同步）。
- 下载行的「删除文件」会**真删磁盘文件**，并带二次确认。

## 回归

修改树已通过项目回归套件：Java **279 个断言**、JS **20 个测试**、XML/资源/Manifest 不变量检查与 build smoke。

```bash
bash tests/check.sh
```

## 本地构建

本机使用离线工具链（JDK 17 + Android SDK Platform 36 + Build Tools 36.0.0），APK 输出到 `output/GPTCat-release.apk`：

```bash
export JAVA_HOME=/path/to/jdk-17
export ANDROID_SDK_ROOT=/path/to/android-sdk          # 需含 platforms/android-36
export GPTCAT_STORE_PASSWORD='你的签名口令'            # 必填，无默认值
export GPTCAT_KEY_PASSWORD='你的签名口令'
bash build_apk.sh
```

## 后续建议

1. 引入 AndroidX WebKit 后，用 origin 限制更强的 `WebMessageListener` 替换传统 JS interface。
2. 大 Blob 下载改为真正的流式方案，进一步降低 WebView 内存峰值。
3. 增加 Android instrumentation/真机 WebView 回归及 API 36 predictive-back 动画验证。
4. 统一 DownloadManager 与本地 Blob 下载的持久化数据模型。
5. 增加不记录聊天正文/Cookie 的崩溃、ANR 与下载失败可观测性。
