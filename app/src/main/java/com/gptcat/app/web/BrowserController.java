package com.gptcat.app.web;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

import com.gptcat.app.ImageViewerActivity;
import com.gptcat.app.R;
import com.gptcat.app.download.DownloadCenter;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.UUID;

/**
 * 持有唯一有效 WebView，集中处理导航、网络恢复、输入法约束、脚本注入和释放。
 *
 * 性能原则：
 * 1) Activity 状态只保存当前可信 URL，不序列化完整浏览历史；
 * 2) 保留 WebView/Chromium 标准 HTTP 缓存，不强制 stale cache；
 * 3) DOM 增强脚本在首屏内容可见时尽早注入，而不是等待全部资源加载结束；
 * 4) 断网时直接给出本地提示，网络恢复后只自动重试一次待恢复页面。
 */
public final class BrowserController {
    private static final String STATE_URL = "gptcat.url";

    private final Activity activity;
    private final FrameLayout root;
    private final ProgressBar progress;
    private final FileChooserHandler fileChooser;
    private final String script;
    private final String bridgeToken = UUID.randomUUID().toString();
    private final ConnectivityManager connectivity;

    private WebView webView;
    private ImageBridge bridge;
    private ConnectivityManager.NetworkCallback networkCallback;

    private String lastUrl = UrlPolicy.HOME_URL;
    private boolean errorPage;
    private boolean waitingForNetwork;
    private boolean networkCallbackRegistered;
    private boolean destroyed;
    private boolean paused;

    public BrowserController(Activity activity, FrameLayout root, ProgressBar progress,
                             FileChooserHandler fileChooser) {
        this.activity = activity;
        this.root = root;
        this.progress = progress;
        this.fileChooser = fileChooser;
        this.connectivity =
                (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);

        script = readScript().replace("__GC_BRIDGE_TOKEN__", bridgeToken);
        attach((WebView) root.findViewById(R.id.webView));
        registerNetworkCallback();
    }

    private void attach(WebView view) {
        webView = view;
        bridge = new ImageBridge(activity, bridgeToken);

        view.addJavascriptInterface(bridge, "GptCatBridge");
        view.setBackgroundColor(android.graphics.Color.WHITE);
        view.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        view.setFocusable(true);
        view.setFocusableInTouchMode(true);

        // 系统栏与窗口底色由 MainActivity 统一设置为浅色，这里只保证 WebView 自身白底。
        // 网页自身发起的下载（含 Content-Disposition 附件、blob:）在这里兜底，
        // 否则 WebView 会静默忽略，表现为「点了没反应」。
        view.setDownloadListener(this::onDownloadRequest);

        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUseWideViewPort(true);

        // 手机保持 overview 兼容旧页面；>=600dp 平板按真实可视宽度布局，避免整体缩小。
        boolean tablet =
                activity.getResources().getConfiguration().smallestScreenWidthDp >= 600;
        settings.setLoadWithOverviewMode(!tablet);
        settings.setTextZoom(100);

        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        // 使用 Chromium 正常的协商/缓存/连接复用，不强制使用可能过期的离线缓存。
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setLoadsImagesAutomatically(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);

        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(view, true);

        view.setWebViewClient(new Client());
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView current, int value) {
                if (current != webView || destroyed) return;

                progress.setProgress(value);
                // 100% 前保持细进度条，避免页面白屏时完全没有反馈。
                progress.setVisibility(value >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView current,
                                             android.webkit.ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                return fileChooser.show(callback, params);
            }
        });

        if (paused) view.onPause();

        // 长按图片兜底：不依赖页面 JS 事件流。
        view.setOnLongClickListener(v -> {
            WebView.HitTestResult hit = view.getHitTestResult();
            if (hit == null) return false;

            int type = hit.getType();
            if (type == WebView.HitTestResult.IMAGE_TYPE
                    || type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) {
                String extra = hit.getExtra();
                if (extra != null && UrlPolicy.isHttpsUrl(extra)) {
                    Intent viewer = new Intent(activity, ImageViewerActivity.class);
                    viewer.putExtra(ImageViewerActivity.EXTRA_URL, extra);
                    viewer.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    activity.startActivity(viewer);
                    return true;
                }
                return false;
            }
            return false;
        });
    }

    public void restoreOrLoad(Bundle state) {
        if (state != null) {
            String savedUrl = state.getString(STATE_URL);
            if (UrlPolicy.isTrusted(savedUrl)) lastUrl = savedUrl;
        }
        loadCurrent();
    }

    public void saveState(Bundle state) {
        if (state == null) return;

        if (webView != null && !destroyed) {
            String current = webView.getUrl();
            if (UrlPolicy.isTrusted(current)) lastUrl = current;
        }
        state.putString(STATE_URL, lastUrl);
    }

    public boolean goBack() {
        if (webView != null && webView.canGoBack()) {
            suppressAutomaticKeyboard(webView);
            webView.goBack();
            return true;
        }
        return false;
    }

    /**
     * 网页发起的下载兜底：
     * http(s) 直接进系统下载；blob:/data: 交回页面取内容后分块落盘。
     * 两种情况都会回调 JS 显示提示，避免「点了没反应」。
     */
    private void onDownloadRequest(String url, String userAgent, String contentDisposition,
                                   String mimeType, long contentLength) {
        if (url == null || destroyed) return;

        if (url.startsWith("blob:") || url.startsWith("data:")) {
            callJs("window.__gcBlobDownload&&window.__gcBlobDownload("
                    + quote(url) + "," + quote(mimeType == null ? "" : mimeType) + ")");
            return;
        }

        if (!UrlPolicy.isHttpUrl(url)) return;

        String name = DownloadCenter.nameFromDisposition(contentDisposition, url);
        String id = DownloadCenter.enqueue(activity, url, name, mimeType);

        if (id.isEmpty()) {
            callJs("window.__gcDownloadFailed&&window.__gcDownloadFailed(" + quote(name) + ")");
            return;
        }

        callJs("window.__gcOnNativeDownload&&window.__gcOnNativeDownload("
                + quote(id) + "," + quote(name) + ")");
    }

    private void callJs(String script) {
        WebView view = webView;
        if (view == null || destroyed) return;

        try {
            view.evaluateJavascript("(function(){" + script + ";})();", null);
        } catch (RuntimeException ignored) { }
    }

    private static String quote(String value) {
        try {
            return org.json.JSONObject.quote(value == null ? "" : value);
        } catch (RuntimeException e) {
            return "\"\"";
        }
    }

    public void onResume() {
        paused = false;
        if (webView != null) {
            webView.onResume();
            // 从后台/图片查看页返回时不恢复一个旧的自动弹出键盘。
            suppressAutomaticKeyboard(webView);
        }
    }

    public void onPause() {
        paused = true;
        if (webView != null) webView.onPause();
    }

    /** 只清 WebView 内存资源缓存，不清 Cookie / DOM Storage / 磁盘 HTTP 缓存。 */
    public void onTrimMemory(int level) {
        WebView view = webView;
        if (view == null || destroyed) return;

        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            view.clearCache(false);
        }
    }

    public void destroy() {
        destroyed = true;
        unregisterNetworkCallback();

        if (bridge != null) bridge.close();
        bridge = null;

        if (webView != null) release(webView);
        webView = null;
    }

    private void release(WebView view) {
        try {
            view.stopLoading();
        } catch (RuntimeException ignored) { }

        view.setOnLongClickListener(null);
        view.setDownloadListener(null);

        if (view.getParent() instanceof ViewGroup) {
            ((ViewGroup) view.getParent()).removeView(view);
        }

        try {
            view.removeJavascriptInterface("GptCatBridge");
        } catch (RuntimeException ignored) { }

        view.setWebChromeClient(null);
        view.setWebViewClient(null);
        view.removeAllViews();

        try {
            view.destroy();
        } catch (RuntimeException ignored) { }
    }

    private void recover(WebView failed) {
        if (failed != webView || destroyed) return;

        if (bridge != null) bridge.close();
        fileChooser.cancel();
        release(failed);

        WebView replacement = new WebView(activity);
        replacement.setId(R.id.webView);
        root.addView(replacement, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        attach(replacement);

        errorPage = false;
        waitingForNetwork = false;
        showError(replacement, "页面渲染已停止，请点击重试。", lastUrl);
    }

    private boolean navigate(String url) {
        if ("reload://retry".equals(url)) {
            errorPage = false;
            waitingForNetwork = false;

            if (bridge != null) bridge.setEnabled(false);

            progress.setProgress(0);
            progress.setVisibility(View.VISIBLE);
            loadCurrent();
            return true;
        }

        if (UrlPolicy.isTrusted(url)) return false;

        if (url != null) {
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();

            if (UrlPolicy.isHttpUrl(url)
                    || "mailto".equalsIgnoreCase(scheme)
                    || "tel".equalsIgnoreCase(scheme)) {
                try {
                    activity.startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException | SecurityException ignored) { }
            }
        }
        return true;
    }

    private void loadCurrent() {
        WebView view = webView;
        if (view == null || destroyed) return;

        suppressAutomaticKeyboard(view);

        if (!hasActiveNetwork()) {
            waitingForNetwork = true;
            errorPage = false;
            showError(view, "当前没有可用网络。网络恢复后会自动重试一次。", lastUrl);
            return;
        }

        waitingForNetwork = false;
        errorPage = false;
        progress.setProgress(0);
        progress.setVisibility(View.VISIBLE);
        view.loadUrl(lastUrl);
    }

    private boolean hasActiveNetwork() {
        if (connectivity == null) return true;

        try {
            Network network = connectivity.getActiveNetwork();
            if (network == null) return false;

            NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(network);
            return capabilities != null
                    && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (SecurityException e) {
            // ACCESS_NETWORK_STATE 理论上已声明；若设备策略阻止读取，交回 WebView 自己判断。
            return true;
        }
    }

    private void registerNetworkCallback() {
        if (connectivity == null || networkCallbackRegistered) return;

        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                activity.runOnUiThread(() -> {
                    if (destroyed || !waitingForNetwork || webView == null) return;

                    // 只响应“之前明确处于断网错误页”的恢复，不对普通 HTTP 错误循环刷新。
                    waitingForNetwork = false;
                    errorPage = false;

                    if (bridge != null) bridge.setEnabled(false);

                    progress.setProgress(0);
                    progress.setVisibility(View.VISIBLE);
                    suppressAutomaticKeyboard(webView);
                    webView.loadUrl(lastUrl);
                });
            }
        };

        try {
            connectivity.registerDefaultNetworkCallback(networkCallback);
            networkCallbackRegistered = true;
        } catch (RuntimeException ignored) {
            networkCallback = null;
        }
    }

    private void unregisterNetworkCallback() {
        if (!networkCallbackRegistered || connectivity == null || networkCallback == null) return;

        try {
            connectivity.unregisterNetworkCallback(networkCallback);
        } catch (RuntimeException ignored) { }

        networkCallbackRegistered = false;
        networkCallback = null;
    }

    /**
     * 原生层兜底：页面切换、返回历史、Activity 恢复时隐藏 IME；
     * 同时 blur 当前网页输入元素。真正的用户点击由 inject.js 放行。
     */
    private void suppressAutomaticKeyboard(WebView view) {
        if (view == null || destroyed) return;

        try {
            view.evaluateJavascript(
                    "(function(){var e=document.activeElement;"
                            + "if(e&&(e.matches('input,textarea,[contenteditable=\"true\"],[role=\"textbox\"]')))"
                            + "{try{e.blur();}catch(_){}}"
                            + "if(window.__gcSuppressKeyboard){window.__gcSuppressKeyboard();}})();",
                    null);
        } catch (RuntimeException ignored) { }

        InputMethodManager imm =
                (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null && view.getWindowToken() != null) {
            imm.hideSoftInputFromWindow(view.getWindowToken(), 0);
        }
    }

    private void showError(WebView view, String message, String failingUrl) {
        if (destroyed || view != webView || errorPage) return;
        if (UrlPolicy.isTrusted(failingUrl)) lastUrl = failingUrl;

        errorPage = true;

        if (bridge != null) bridge.setEnabled(false);
        progress.setVisibility(View.GONE);

        String html = "<!doctype html><html><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>"
                + "<style>html,body{margin:0;background:#fff;color:#222;font-family:sans-serif}"
                + "body{min-height:100vh;display:flex;align-items:center;justify-content:center;"
                + "box-sizing:border-box;padding:clamp(24px,6vw,56px)}"
                + ".box{width:min(520px,100%);text-align:center}"
                + "a{display:inline-block;padding:12px 22px;background:#1f6feb;color:#fff;"
                + "border-radius:12px;text-decoration:none}</style></head>"
                + "<body><div class='box'><h2>页面打不开</h2><p>"
                + TextUtils.htmlEncode(message)
                + "</p><p>请检查网络或代理设置，然后重试。</p>"
                + "<a href='reload://retry'>点击重试</a></div></body></html>";

        view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    private String readScript() {
        try (InputStream input = activity.getResources().openRawResource(R.raw.inject);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;

            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            return output.toString("UTF-8");
        } catch (IOException e) {
            return "";
        }
    }

    private void inject(WebView view, String url) {
        if (destroyed
                || view != webView
                || errorPage
                || script.isEmpty()
                || !UrlPolicy.isTrusted(url)
                || !UrlPolicy.isTrusted(view.getUrl())) {
            return;
        }

        if (bridge != null) bridge.setEnabled(true);
        view.evaluateJavascript(script, null);
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return navigate(url);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // iframe 的站外地址不应强制拉起系统浏览器。
            return request.isForMainFrame() && navigate(request.getUrl().toString());
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (view != webView || destroyed) return;

            suppressAutomaticKeyboard(view);

            boolean trusted = UrlPolicy.isTrusted(url);
            if (bridge != null) bridge.setEnabled(trusted);

            if (trusted) {
                lastUrl = url;
                errorPage = false;
                waitingForNetwork = false;
                progress.setProgress(0);
                progress.setVisibility(View.VISIBLE);
            } else {
                errorPage = true;
                progress.setVisibility(View.GONE);
            }
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            if (view != webView || destroyed) return;

            // 用户已经看到新文档时立即增强页面，比等全部图片/资源加载完成更快。
            inject(view, url);
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            if (view != webView || destroyed) return;

            if (UrlPolicy.isTrusted(url)) {
                lastUrl = url;

                // 历史会话/SPA 路由切换时网页常会自动 focus composer，这里统一压掉。
                if (!isReload) suppressAutomaticKeyboard(view);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (view != webView || destroyed) return;

            progress.setVisibility(View.GONE);
            inject(view, url); // onPageCommitVisible 未触发时的兼容兜底。
        }

        @Override
        public void onReceivedError(WebView view,
                                    WebResourceRequest request,
                                    WebResourceError error) {
            if (!request.isForMainFrame()) return;

            waitingForNetwork = !hasActiveNetwork();

            String message = waitingForNetwork
                    ? "网络连接已断开。恢复网络后会自动重试一次。"
                    : "网络错误 (" + error.getErrorCode() + ")：" + error.getDescription();

            showError(view, message, request.getUrl().toString());
        }

        @Override
        public void onReceivedHttpError(WebView view,
                                        WebResourceRequest request,
                                        WebResourceResponse response) {
            if (!request.isForMainFrame()) return;

            waitingForNetwork = false;
            showError(view,
                    "服务器返回 HTTP " + response.getStatusCode(),
                    request.getUrl().toString());
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            errorPage = false;
            waitingForNetwork = false;
            recover(view);
            return true;
        }
    }
}
