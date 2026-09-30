package com.gptcat.app.ui;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.View;

import com.gptcat.app.R;

/** 深浅色：JS 侧负责网页配色，这里统一系统栏、窗口与 WebView 底色，避免切换时闪白。 */
public final class ThemeController {
    public static final String DARK = "dark";
    public static final String LIGHT = "light";
    public static final String AUTO = "auto";

    public static final int DARK_BACKGROUND = 0xFF10131A;

    private static final String PREFS = "gptcat-ui";
    private static final String KEY = "theme";

    private ThemeController() { }

    public static String mode(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String value = prefs.getString(KEY, AUTO);
        return value == null ? AUTO : value;
    }

    public static void setMode(Context context, String mode) {
        if (!DARK.equals(mode) && !LIGHT.equals(mode) && !AUTO.equals(mode)) mode = AUTO;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY, mode).apply();
    }

    public static boolean isDark(Context context) {
        String mode = mode(context);
        if (DARK.equals(mode)) return true;
        if (LIGHT.equals(mode)) return false;

        int night = context.getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK;
        return night == Configuration.UI_MODE_NIGHT_YES;
    }

    /** 同步系统栏、窗口与 WebView 底色；必须在主线程调用。 */
    public static void apply(Activity activity, boolean dark) {
        int background = dark ? DARK_BACKGROUND : Color.WHITE;

        View root = activity.findViewById(R.id.root);
        activity.getWindow().setBackgroundDrawable(new ColorDrawable(background));

        if (root != null) {
            root.setBackgroundColor(background);
            WindowInsetsHelper.apply(activity, root, !dark);
        }

        View web = activity.findViewById(R.id.webView);
        if (web != null) web.setBackgroundColor(background);
    }
}
