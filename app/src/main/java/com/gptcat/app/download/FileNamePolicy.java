package com.gptcat.app.download;

import java.net.URI;
import java.net.URISyntaxException;

/** Download filename sanitization kept free of Android dependencies for regression testing. */
public final class FileNamePolicy {
    private static final int MAX_LENGTH = 120;

    private FileNamePolicy() { }

    public static String safeName(String name, String url) {
        String value = name == null ? "" : name.trim();
        if (value.isEmpty()) value = lastPathSegment(url);
        if (value.isEmpty()) value = "gptcat-download";

        StringBuilder clean = new StringBuilder(Math.min(value.length(), MAX_LENGTH));
        for (int i = 0; i < value.length() && clean.length() < MAX_LENGTH; i++) {
            char ch = value.charAt(i);
            if (ch == '/' || ch == '\\' || ch == ':' || ch == '*' || ch == '?'
                    || ch == '\"' || ch == '<' || ch == '>' || ch == '|'
                    || Character.isISOControl(ch)) {
                clean.append('_');
            } else {
                clean.append(ch);
            }
        }

        value = clean.toString().trim();
        if (".".equals(value) || "..".equals(value)) return "gptcat-download";

        int leadingDots = 0;
        while (leadingDots < value.length() && value.charAt(leadingDots) == '.') leadingDots++;
        if (leadingDots > 0) value = repeat('_', leadingDots) + value.substring(leadingDots);
        while (value.endsWith(".") || value.endsWith(" ")) {
            value = value.substring(0, value.length() - 1);
        }

        return value.isEmpty() ? "gptcat-download" : value;
    }

    private static String lastPathSegment(String url) {
        if (url == null || url.isEmpty()) return "";
        try {
            URI uri = new URI(url);
            String path = uri.getPath();
            if (path == null || path.isEmpty() || path.endsWith("/")) return "";
            int slash = path.lastIndexOf('/');
            return slash >= 0 ? path.substring(slash + 1) : path;
        } catch (URISyntaxException | IllegalArgumentException e) {
            return "";
        }
    }

    private static String repeat(char ch, int count) {
        StringBuilder out = new StringBuilder(count);
        for (int i = 0; i < count; i++) out.append(ch);
        return out.toString();
    }
}
