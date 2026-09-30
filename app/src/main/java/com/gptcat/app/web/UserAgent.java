package com.gptcat.app.web;

/**
 * 原生请求统一用 WebView 的 UA，而不是 Dalvik 的 {@code System.getProperty("http.agent")}。
 *
 * 站点的 Cookie（例如 Cloudflare 的 cf_clearance）常常绑定 UA，
 * UA 不一致会让下载/图片请求被判为换个客户端而拒绝。
 *
 * WebView 必须在 UI 线程初始化，所以 UA 由 BrowserController 在 UI 线程预热进缓存，
 * 后台线程只读缓存，绝不在后台触发 WebView 初始化。
 */
public final class UserAgent {
    private static volatile String cached = "";

    private UserAgent() { }

    /** 在 UI 线程用当前 WebView 的 UA 预置缓存。 */
    public static void warmUp(String value) {
        if (value != null && !value.trim().isEmpty()) cached = value;
    }

    /** 与 WebView 一致的 UA；未预热时退回系统默认值。 */
    public static String current() {
        String value = cached;
        if (value != null && !value.isEmpty()) return value;

        String fallback = System.getProperty("http.agent");
        return fallback == null ? "" : fallback;
    }
}
