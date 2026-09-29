package com.gptcat.app.ui;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Insets;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

/** API 24–29 使用系统 adjustResize；只有 API 30+ 才访问 Type/IME API。 */
public final class WindowInsetsHelper {
    private WindowInsetsHelper() { }

    public static void apply(Activity activity, View root, boolean light) {
        activity.getWindow().setStatusBarColor(light ? Color.WHITE : Color.BLACK);
        activity.getWindow().setNavigationBarColor(light && Build.VERSION.SDK_INT >= 26
                ? Color.WHITE : Color.BLACK);
        if (Build.VERSION.SDK_INT >= 30) {
            activity.getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = activity.getWindow().getInsetsController();
            if (controller != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(light ? mask : 0, mask);
            }
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout());
                int bottom = Math.max(bars.bottom, insets.getInsets(WindowInsets.Type.ime()).bottom);
                if (view.getPaddingLeft() != bars.left || view.getPaddingTop() != bars.top
                        || view.getPaddingRight() != bars.right || view.getPaddingBottom() != bottom) {
                    view.setPadding(bars.left, bars.top, bars.right, bottom);
                }
                return insets;
            });
            root.requestApplyInsets();
        } else {
            int flags = activity.getWindow().getDecorView().getSystemUiVisibility();
            flags = light ? flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                    : flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26) {
                flags = light ? flags | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                        : flags & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            activity.getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }
}
