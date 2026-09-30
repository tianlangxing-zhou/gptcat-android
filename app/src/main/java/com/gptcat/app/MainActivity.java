package com.gptcat.app;

import android.app.Activity;
import android.content.ComponentCallbacks2;
import android.content.Intent;
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
        browser.restoreOrLoad(savedInstanceState);
        registerBackCallback();

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

        backCallback = Api33Back.register(this, () -> {
            if (browser == null || !browser.goBack()) finish();
        });
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
        if (Build.VERSION.SDK_INT < 33
                && keyCode == KeyEvent.KEYCODE_BACK
                && browser != null
                && browser.goBack()) {
            return true;
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
