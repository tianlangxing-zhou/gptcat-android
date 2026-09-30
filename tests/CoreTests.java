import com.gptcat.app.download.FileNamePolicy;
import com.gptcat.app.image.ImageSizing;
import com.gptcat.app.web.UrlPolicy;

import java.nio.charset.StandardCharsets;

/** 不依赖 Android SDK 的边界回归测试。运行方法见 README.md。 */
public final class CoreTests {
    private static int checks;
    private static void check(boolean condition, String message) {
        checks++;
        if (!condition) throw new AssertionError(message);
    }

    private static int utf8(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
    }

    public static void main(String[] args) {
        String[] trusted = { "https://gptcat.cc/", "https://share.gptcat.cc/chat?a=1",
                "https://chat2.gptcat.cc/", "https://SHARE.GPTCAT.CC/path", "https://share.gptcat.cc/会话" };
        for (String url : trusted) check(UrlPolicy.isTrusted(url), "trusted: " + url);
        String[] untrusted = { null, "", "https://evilgptcat.cc/", "https://gptcat.cc.evil.com/",
                "http://share.gptcat.cc/", "javascript:alert(1)", "file:///sdcard/a.png",
                "https://gptcat.cc@evil.example/", "https://evil@share.gptcat.cc/",
                "data:image/png;base64,abc", "https://share.gptcat.cc\n.evil/", "//share.gptcat.cc/" };
        for (String url : untrusted) check(!UrlPolicy.isTrusted(url), "untrusted: " + url);
        check(UrlPolicy.isHttpsUrl("https://cdn.example.com/a.jpg?key=x"), "secure external image URL");
        check(!UrlPolicy.isHttpsUrl("http://cdn.example.com/a.jpg"), "native fetch rejects HTTP");
        check(UrlPolicy.isHttpUrl("http://cdn.example.com/a.jpg"), "external browser may parse HTTP");
        check(!UrlPolicy.isHttpUrl("content://test/a"), "reject content input");
        check(!UrlPolicy.isHttpUrl("https://cdn.example.com/" + new String(new char[8192])), "URL size bound");

        check("gptcat-download".equals(FileNamePolicy.safeName("..", "")), "dot-dot filename fallback");
        check("__secret.txt".equals(FileNamePolicy.safeName("..secret.txt", "")), "leading dots neutralized");
        check("a_b_c_.txt".equals(FileNamePolicy.safeName("a/b\\c?.txt", "")), "path separators sanitized");
        check("report.pdf".equals(FileNamePolicy.safeName("", "https://example.com/a/report.pdf?q=1")),
                "filename from URL path");
        check("invoice_gpj.apk".equals(FileNamePolicy.safeName("invoice\u202Egpj.apk", "")),
                "bidi override neutralized");
        check("a_.txt".equals(FileNamePolicy.safeName("a\uD83D.txt", "")), "lone surrogate replaced");

        StringBuilder cjk = new StringBuilder();
        for (int i = 0; i < 150; i++) cjk.append('\u6587');
        String cjkName = FileNamePolicy.safeName(cjk + ".pdf", "");
        check(cjkName.endsWith(".pdf"), "long CJK name keeps extension");
        check(utf8(cjkName) <= 200, "long CJK name within 200 UTF-8 bytes");

        StringBuilder emoji = new StringBuilder();
        for (int i = 0; i < 100; i++) emoji.append("\uD83D\uDE00");
        String emojiName = FileNamePolicy.safeName(emoji + ".png", "");
        check(emojiName.endsWith(".png"), "long emoji name keeps extension");
        check(utf8(emojiName) <= 200, "long emoji name within byte limit");
        check(new String(emojiName.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8)
                .equals(emojiName), "surrogate pairs not split");

        StringBuilder ascii = new StringBuilder();
        for (int i = 0; i < 300; i++) ascii.append('a');
        check(FileNamePolicy.safeName(ascii.toString(), "").length() == 200, "ASCII name truncated to 200");

        check(ImageSizing.sampleSize(100, 100, 1080, 1920) == 1, "small image unchanged");
        check(ImageSizing.sampleSize(8000, 8000, 1080, 1920) == 4, "64 MP image samples to 4 MP");
        int[] dimensions = { 1, 24, 200, 1000, 2048, 4096, 8000, 50000, Integer.MAX_VALUE };
        for (int width : dimensions) {
            for (int height : dimensions) {
                int sample = ImageSizing.sampleSize(width, height, 1080, 1920);
                long w = ((long) width + sample - 1) / sample;
                long h = ((long) height + sample - 1) / sample;
                check(sample > 0 && (sample & (sample - 1)) == 0, "power of two");
                check(w * h <= 4L * 1024 * 1024, "preview pixel limit");
                check(w <= 4096 && h <= 4096, "preview dimension limit");
            }
        }
        System.out.println("PASS: " + checks + " URL, filename and image sizing assertions");
    }
}
