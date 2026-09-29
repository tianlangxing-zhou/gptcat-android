package com.gptcat.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.graphics.Insets;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public class MainActivity extends Activity {

    private static final String HOME_URL = "https://share.gptcat.cc/";
    private static final int FILE_CHOOSER_REQ = 100;

    private WebView webView;
    private ProgressBar progressBar;
    private ValueCallback<Uri[]> uploadCallback;
    private String injectJs;
    private volatile int lastBg = Integer.MIN_VALUE;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 状态栏区域颜色与图标深浅跟随系统夜间模式（页面内容由布局 fitsSystemWindows 避开状态栏）
        boolean nightMode = (getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        getWindow().setBackgroundDrawable(new ColorDrawable(nightMode ? 0xFF141414 : Color.WHITE));
        setContentView(R.layout.activity_main);

        progressBar = findViewById(R.id.progressBar);
        webView = findViewById(R.id.webView);
        injectJs = loadRawInject();
        // 网页主题桥：页面把背景色报上来，状态栏区域随之变色（API35 透明状态栏下窗口背景即状态栏底色）
        webView.addJavascriptInterface(new BgBridge(), "GptCatBridge");

        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                // 深色页面配浅色(白)状态栏图标；浅色页面配深色图标
                int appearance = nightMode ? 0 : WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;
                c.setSystemBarsAppearance(appearance, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
            }
        }

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 站点为 https，但个别资源可能是 http，保持兼容以免空白
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cm.setAcceptThirdPartyCookies(webView, true);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(view, url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(view, request.getUrl().toString());
            }

            private boolean handleUrl(WebView view, String url) {
                if (url == null) return false;
                if (url.startsWith("reload://")) { // 错误页里的“重试”
                    view.reload();
                    return true;
                }
                Uri uri = Uri.parse(url);
                String host = uri.getHost();
                // 同属 gptcat.cc 域（share / chat2 等子域及 302 跳转）均在 WebView 内打开
                if (host != null && host.endsWith(".gptcat.cc")) {
                    return false;
                }
                // 站外链接：交给系统浏览器
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
                progressBar.setProgress(0);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                // 注入移动端快捷入口（脚本内部自带去重与“找不到目标自动隐藏”逻辑）
                if (injectJs != null && !injectJs.isEmpty()) {
                    view.evaluateJavascript(injectJs, null);
                }
            }

            // 网络层错误（DNS/连接/超时等）：换成可读提示页
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                showError("网络错误 (" + errorCode + ")：" + description);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError("网络错误 (" + error.getErrorCode() + ")：" + error.getDescription());
                }
            }

            // HTTP 层错误（如 403/404/500）
            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) {
                    showError("服务器返回 HTTP " + response.getStatusCode());
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                if (newProgress >= 100) progressBar.setVisibility(View.GONE);
            }

            @Override
            public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> cb,
                                             FileChooserParams fp) {
                if (uploadCallback != null) uploadCallback.onReceiveValue(null);
                uploadCallback = cb;
                try {
                    startActivityForResult(fp.createIntent(), FILE_CHOOSER_REQ);
                } catch (Exception e) {
                    uploadCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(HOME_URL);
        }
    }

    // JS 桥：网页上报背景色 → 状态栏区域颜色与图标深浅跟随页面主题
    private class BgBridge {
        @JavascriptInterface
        public void reportBg(final String color) {
            final int c = parseColor(color);
            if (c == lastBg) return;
            lastBg = c;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    getWindow().setBackgroundDrawable(new ColorDrawable(c));
                    if (Build.VERSION.SDK_INT >= 30) {
                        WindowInsetsController ctr = getWindow().getInsetsController();
                        if (ctr != null) {
                            int lum = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000;
                            int appearance = lum > 140
                                    ? WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0;
                            ctr.setSystemBarsAppearance(appearance,
                                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
                        }
                    }
                }
            });
        }
    }

    // 支持 "#rrggbb" / "rgb(r,g,b)" / "rgba(r,g,b,a)"
    private static int parseColor(String s) {
        try {
            s = s.trim();
            if (s.startsWith("#")) return Color.parseColor(s);
            if (s.startsWith("rgb")) {
                String nums = s.substring(s.indexOf('(') + 1, s.indexOf(')'));
                String[] p = nums.split(",");
                int r = Integer.parseInt(p[0].trim());
                int g = Integer.parseInt(p[1].trim());
                int b = Integer.parseInt(p[2].trim());
                int a = 255;
                if (p.length > 3) a = (int) (Float.parseFloat(p[3].trim()) * 255);
                return Color.argb(a, r, g, b);
            }
        } catch (Exception ignored) { }
        return Color.WHITE;
    }

    private String loadRawInject() {
        InputStream is = null;
        try {
            is = getResources().openRawResource(R.raw.inject);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toString("UTF-8");
        } catch (Exception e) {
            return "";
        } finally {
            if (is != null) {
                try { is.close(); } catch (Exception ignored) { }
            }
        }
    }

    // 本地错误页：白底、可读原因、带重试按钮（点击 reload:// 触发 handleUrl 重新加载）
    private void showError(String msg) {
        String html = "<!DOCTYPE html><html><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{font-family:-apple-system,Segoe UI,sans-serif;background:#fff;color:#222;"
                + "padding:28px;text-align:center}h2{color:#c0392b}"
                + ".t{color:#888;font-size:13px;margin-top:10px}"
                + ".btn{display:inline-block;margin-top:18px;padding:11px 22px;background:#1f6feb;"
                + "color:#fff;border-radius:8px;text-decoration:none;font-size:15px}</style></head>"
                + "<body><h2>页面打不开</h2><p>" + msg + "</p>"
                + "<p class='t'>多为网络/代理问题：检查 WiFi，或手机代理(Clash)是否把该域名路由到了不可达节点。</p>"
                + "<a class='btn' href='reload://retry'>点击重试</a></body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQ) {
            if (uploadCallback == null) return;
            Uri[] results = null;
            if (data != null && resultCode == RESULT_OK) {
                ClipData clip = data.getClipData();
                if (clip != null) {
                    results = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        results[i] = clip.getItemAt(i).getUri();
                    }
                } else if (data.getDataString() != null) {
                    results = new Uri[]{Uri.parse(data.getDataString())};
                }
            }
            uploadCallback.onReceiveValue(results);
            uploadCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
