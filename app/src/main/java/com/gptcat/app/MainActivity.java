package com.gptcat.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.view.KeyEvent;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

import com.gptcat.app.ui.WindowInsetsHelper;
import com.gptcat.app.web.BrowserController;
import com.gptcat.app.web.FileChooserHandler;

/** Activity 只负责窗口和生命周期；网页导航、文件选择各自独立。 */
public class MainActivity extends Activity {
    private BrowserController browser;
    private FileChooserHandler fileChooser;

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
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (!fileChooser.onActivityResult(requestCode, resultCode, data)) {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        browser.saveState(outState);
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
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && browser.goBack()) return true;
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        fileChooser.cancel();
        browser.destroy();
        super.onDestroy();
    }
}
