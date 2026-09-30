package com.gptcat.app.download;

import java.net.URI;
import java.net.URISyntaxException;

/** 下载文件名清洗；不依赖 Android SDK，方便离屏回归测试。 */
public final class FileNamePolicy {
    /**
     * ext4/f2fs 单个文件名上限是 255 字节而不是 255 个字符：
     * 120 个汉字的 UTF-8 编码约 360 字节，直接交给 DownloadManager/MediaStore 会失败。
     * 预留 MediaStore ".trashed-时间戳-" 前缀与 DownloadManager "-N" 去重后缀的空间。
     */
    static final int MAX_UTF8_BYTES = 200;
    private static final int MAX_EXTENSION_CHARS = 16;
    private static final String FALLBACK = "gptcat-download";

    private FileNamePolicy() { }

    public static String safeName(String name, String url) {
        String value = name == null ? "" : name.trim();
        if (value.isEmpty()) value = lastPathSegment(url);
        if (value.isEmpty()) return FALLBACK;

        // 按码点处理，避免把 emoji 的代理对拆开。
        StringBuilder clean = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); ) {
            int cp = value.codePointAt(i);
            i += Character.charCount(cp);
            clean.appendCodePoint(forbidden(cp) ? '_' : cp);
        }

        value = clean.toString().trim();
        if (".".equals(value) || "..".equals(value)) return FALLBACK;

        int leadingDots = 0;
        while (leadingDots < value.length() && value.charAt(leadingDots) == '.') leadingDots++;
        if (leadingDots > 0) value = repeat('_', leadingDots) + value.substring(leadingDots);

        value = fitUtf8(value);
        while (value.endsWith(".") || value.endsWith(" ")) {
            value = value.substring(0, value.length() - 1);
        }

        return value.isEmpty() ? FALLBACK : value;
    }

    private static boolean forbidden(int cp) {
        switch (cp) {
            case '/': case '\\': case ':': case '*': case '?':
            case '"': case '<': case '>': case '|':
                return true;
            default:
                break;
        }
        if (Character.isISOControl(cp)) return true;
        // 孤立代理项写进文件系统会变乱码或直接失败。
        if (Character.getType(cp) == Character.SURROGATE) return true;
        // 双向控制符/零宽字符可以伪装扩展名，例如 "invoice\u202Egpj.apk" 在界面上显示成 "invoice‮gpj.apk"。
        return cp == 0x061C || cp == 0x200B || cp == 0x200E || cp == 0x200F
                || (cp >= 0x202A && cp <= 0x202E)
                || (cp >= 0x2066 && cp <= 0x2069)
                || cp == 0xFEFF;
    }

    /** 超长时优先保留扩展名，只截断主干部分。 */
    private static String fitUtf8(String value) {
        if (byteLength(value) <= MAX_UTF8_BYTES) return value;

        String extension = "";
        int dot = value.lastIndexOf('.');
        if (dot > 0) {
            String candidate = value.substring(dot);
            if (candidate.length() >= 2 && candidate.length() <= MAX_EXTENSION_CHARS
                    && candidate.indexOf(' ') < 0) {
                extension = candidate;
            }
        }

        String base = extension.isEmpty() ? value : value.substring(0, dot);
        String head = truncateUtf8(base, MAX_UTF8_BYTES - byteLength(extension)).trim();
        if (head.isEmpty()) head = FALLBACK;
        return head + extension;
    }

    private static String truncateUtf8(String value, int maxBytes) {
        int bytes = 0;
        int end = 0;
        while (end < value.length()) {
            int cp = value.codePointAt(end);
            int size = codePointBytes(cp);
            if (bytes + size > maxBytes) break;
            bytes += size;
            end += Character.charCount(cp);
        }
        return value.substring(0, end);
    }

    private static int byteLength(String value) {
        int total = 0;
        for (int i = 0; i < value.length(); ) {
            int cp = value.codePointAt(i);
            total += codePointBytes(cp);
            i += Character.charCount(cp);
        }
        return total;
    }

    private static int codePointBytes(int cp) {
        if (cp < 0x80) return 1;
        if (cp < 0x800) return 2;
        if (cp < 0x10000) return 3;
        return 4;
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
