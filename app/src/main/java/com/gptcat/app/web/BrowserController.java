package com.gptcat.app.web;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentCallbacks2;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
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

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.UUID;

/**
 * 持有唯一有效 WebView，集中处理导航、脚本注入、错误恢复和释放。
 *
 * 不再把完整 WebView 浏览历史序列化进 Activity 状态，只保存当前可信 URL。
 * 这样可减少大页面/长会话在进程状态保存时的 Bundle 体积与恢复压力。
 */
public final class BrowserController {
    private static final String STATE_URL = "gptcat.url";

    private final Activity activity;
    private final FrameLayout root;
    private final ProgressBar progress;
    private final FileChooserHandler fileChooser;
    private final String script;
    private final String bridgeToken = UUID.randomUUID().toString();

    private WebView webView;
    private ImageBridge bridge;
    private String lastUrl = UrlPolicy.HOME_URL;
    private boolean errorPage;
    private boolean destroyed;
    private boolean paused;

    public BrowserController(Activity activity, FrameLayout root, ProgressBar progress,
                             FileChooserHandler fileChooser) {
        this.activity = activity;
        this.root = root;
        this.progress = progress;
        this.fileChooser = fileChooser;
        script = readScript().replace("__GC_BRIDGE_TOKEN__", bridgeToken);
        attach((WebView) root.findViewById(R.id.webView));
    }

    private void attach(WebView view) {
        webView = view;
        bridge = new ImageBridge(activity, bridgeToken);
        view.addJavascriptInterface(bridge, "GptCatBridge");
        view.setBackgroundColor(android.graphics.Color.WHITE);

        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(false);

        // 保留标准 HTTP 缓存策略以避免每次都重新下载；内存紧张时只清理内存缓存。
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setAllowFileAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(view, true);

        view.setWebViewClient(new Client());
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int value) {
                if (view != webView || destroyed) return;
                progress.setProgress(value);
                progress.setVisibility(value >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                return fileChooser.show(cb, params);
            }
        });

        if (paused) view.onPause();

        // 长按图片兜底：绕过 JS 事件流，命中图片/图片链接直接进入全屏查看页。
        view.setOnLongClickListener(v -> {
            WebView.HitTestResult hit = view.getHitTestResult();
            if (hit == null) return false;
            int type = hit.getType();
            if (type == WebView.HitTestResult.IMAGE_TYPE
                    || type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) {
                String extra = hit.getExtra();
                if (extra != null && UrlPolicy.isHttpUrl(extra)) {
                    Intent viewer = new Intent(activity, ImageViewerActivity.class);
                    viewer.putExtra(ImageViewerActivity.EXTRA_URL, extra);
                    viewer.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    activity.startActivity(viewer);
                }
                return true;
            }
            return false;
        });
    }

    public void restoreOrLoad(Bundle state) {
        if (state != null) {
            String savedUrl = state.getString(STATE_URL);
            if (UrlPolicy.isTrusted(savedUrl)) lastUrl = savedUrl;
        }
        if (webView != null) webView.loadUrl(lastUrl);
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
            webView.goBack();
            return true;
        }
        return false;
    }

    public void onResume() {
        paused = false;
        if (webView != null) webView.onResume();
    }

    public void onPause() {
        paused = true;
        if (webView != null) webView.onPause();
    }

    /** 只清理 WebView 的内存资源缓存，不清 Cookie/DOM Storage，避免把登录状态一起清掉。 */
    public void onTrimMemory(int level) {
        WebView view = webView;
        if (view == null || destroyed) return;
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            view.clearCache(false);
        }
    }

    public void destroy() {
        destroyed = true;
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
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        attach(replacement);

        // 不无限重载崩溃页面；提示用户主动重试，重试仍指向原网址。
        errorPage = false;
        showError(replacement, "页面渲染已停止，请点击重试。", lastUrl);
    }

    private boolean navigate(String url) {
        if ("reload://retry".equals(url)) {
            errorPage = false;
            if (bridge != null) bridge.setEnabled(false);
            progress.setProgress(0);
            progress.setVisibility(View.VISIBLE);
            if (webView != null) webView.loadUrl(lastUrl);
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

    private void showError(WebView view, String message, String failingUrl) {
        if (destroyed || view != webView || errorPage) return;
        if (UrlPolicy.isTrusted(failingUrl)) lastUrl = failingUrl;

        errorPage = true;
        if (bridge != null) bridge.setEnabled(false);
        progress.setVisibility(View.GONE);

        String html = "<!doctype html><html><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{font-family:sans-serif;background:#fff;color:#222;padding:28px;"
                + "text-align:center}a{display:inline-block;padding:12px 22px;background:#1f6feb;"
                + "color:#fff;border-radius:10px;text-decoration:none}</style></head>"
                + "<body><h2>页面打不开</h2><p>" + TextUtils.htmlEncode(message)
                + "</p><p>请检查网络或代理设置，然后重试。</p>"
                + "<a href='reload://retry'>点击重试</a></body></html>";
        view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    private String readScript() {
        try (InputStream input = activity.getResources().openRawResource(R.raw.inject);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toString("UTF-8");
        } catch (IOException e) {
            return "";
        }
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

            boolean trusted = UrlPolicy.isTrusted(url);
            if (bridge != null) bridge.setEnabled(trusted);

            if (trusted) {
                lastUrl = url;
                errorPage = false;
                progress.setProgress(0);
                progress.setVisibility(View.VISIBLE);
            } else {
                errorPage = true;
                progress.setVisibility(View.GONE);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (view != webView || destroyed) return;

            progress.setVisibility(View.GONE);
            if (!errorPage
                    && UrlPolicy.isTrusted(url)
                    && UrlPolicy.isTrusted(view.getUrl())
                    && !script.isEmpty()) {
                if (bridge != null) bridge.setEnabled(true);
                view.evaluateJavascript(script, null);
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                showError(view,
                        "网络错误 (" + error.getErrorCode() + ")：" + error.getDescription(),
                        request.getUrl().toString());
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        WebResourceResponse response) {
            if (request.isForMainFrame()) {
                showError(view, "服务器返回 HTTP " + response.getStatusCode(),
                        request.getUrl().toString());
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            errorPage = false;
            recover(view);
            return true;
        }
    }
}
