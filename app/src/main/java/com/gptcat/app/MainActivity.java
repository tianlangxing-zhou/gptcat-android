package com.gptcat.app;

import android.app.Activity;
import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

import com.gptcat.app.ui.WindowInsetsHelper;
import com.gptcat.app.update.UpdateChecker;
import com.gptcat.app.web.BrowserController;
import com.gptcat.app.web.FileChooserHandler;

/** Activity 只负责窗口和生命周期；网页导航、文件选择各自独立。 */
public class MainActivity extends Activity {
    private BrowserController browser;
    private FileChooserHandler fileChooser;
    private Object backCallback;

    /**
     * 固定浅色：这是个浅色壳，而 targetSdk ≥ 33 后 WebView 会把深/浅色偏好透给网页
     * （prefers-color-scheme）。系统开着深色模式时站点会整页转深色，
     * 与"不要深色模式"的要求冲突。这里把 Activity 的 uiMode 覆盖成 NIGHT_NO，
     * 让 WebView 始终上报 light。图片查看页不在此列，它本来就是深色底看图的。
     */
    @Override
    protected void attachBaseContext(Context newBase) {
        Configuration configuration = new Configuration(newBase.getResources().getConfiguration());
        configuration.uiMode = (configuration.uiMode & ~Configuration.UI_MODE_NIGHT_MASK)
                | Configuration.UI_MODE_NIGHT_NO;
        super.attachBaseContext(newBase.createConfigurationContext(configuration));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.WHITE));
        setContentView(R.layout.activity_main);

        FrameLayout root = findViewById(R.id.root);
        WindowInsetsHelper.apply(this, root, true);

        fileChooser = new FileChooserHandler(this);
        ProgressBar progress = findViewById(R.id.progressBar);
        browser = new BrowserController(this, root, progress, fileChooser);
        // 只在网页还能后退时才注册返回回调；根页面交给系统（保住会话 + 保留系统返回动画）。
        browser.setBackStateListener(available -> {
            if (available) {
                registerBackCallback();
            } else {
                unregisterBackCallback();
            }
        });
        browser.restoreOrLoad(savedInstanceState);

        // 后台线程轻量检查；最多每 12 小时一次，不阻塞首屏。
        UpdateChecker.check(this);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (fileChooser == null || !fileChooser.onActivityResult(requestCode, resultCode, data)) {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (browser != null) browser.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (browser != null) browser.onResume();
    }

    @Override
    protected void onPause() {
        if (browser != null) browser.onPause();
        super.onPause();
    }

    @Override
    public void onTrimMemory(int level) {
        if (browser != null) browser.onTrimMemory(level);
        super.onTrimMemory(level);
    }

    @Override
    public void onLowMemory() {
        if (browser != null) browser.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_COMPLETE);
        super.onLowMemory();
    }

    private void registerBackCallback() {
        if (Build.VERSION.SDK_INT < 33 || backCallback != null) return;
        backCallback = Api33Back.register(this, this::handleBack);
    }

    /**
     * 返回键兜底：网页能后退就后退，否则把任务移到后台而不是 finish()。
     * Android 12+ 在根 Activity 上按返回的默认行为就是退到后台；
     * finish() 会销毁 WebView 会话，回来时整页重载。
     */
    private void handleBack() {
        if (browser != null && browser.goBack()) return;
        if (!moveTaskToBack(true)) finish();
    }

    private void unregisterBackCallback() {
        if (Build.VERSION.SDK_INT < 33 || backCallback == null) return;
        Api33Back.unregister(this, backCallback);
        backCallback = null;
    }

    /** Keep API 33 types isolated so MainActivity can still be verified/loaded on API 24-32. */
    private static final class Api33Back {
        static Object register(Activity activity, Runnable action) {
            OnBackInvokedCallback callback = action::run;
            activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            return callback;
        }

        static void unregister(Activity activity, Object value) {
            activity.getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(
                    (OnBackInvokedCallback) value);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (Build.VERSION.SDK_INT < 33 && keyCode == KeyEvent.KEYCODE_BACK) {
            if (browser != null && browser.goBack()) return true;
            // API 24-32 与 Android 12+ 的"退到后台"语义对齐，同样不销毁 WebView 会话。
            if (moveTaskToBack(true)) return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        unregisterBackCallback();
        if (fileChooser != null) fileChooser.cancel();
        if (browser != null) browser.destroy();
        browser = null;
        fileChooser = null;
        super.onDestroy();
    }
}
