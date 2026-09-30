package com.gptcat.app.web;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

public final class UrlPolicy {
    public static final String HOME_URL = "https://share.gptcat.cc/";
    private static final int MAX_URL_LENGTH = 8192;

    private UrlPolicy() { }

    public static boolean isTrusted(String value) {
        URI uri = parse(value);
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        return host.equals("gptcat.cc") || host.endsWith(".gptcat.cc");
    }

    public static boolean isHttpsUrl(String value) {
        URI uri = parse(value);
        return uri != null && "https".equalsIgnoreCase(uri.getScheme());
    }

    public static boolean isHttpUrl(String value) {
        URI uri = parse(value);
        return uri != null && ("https".equalsIgnoreCase(uri.getScheme())
                || "http".equalsIgnoreCase(uri.getScheme()));
    }

    private static URI parse(String value) {
        if (value == null || value.length() > MAX_URL_LENGTH) return null;
        try {
            URI uri = new URI(value);
            return uri.getHost() != null && uri.getRawUserInfo() == null ? uri : null;
        } catch (URISyntaxException e) {
            return null;
        }
    }
}
