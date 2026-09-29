import com.sun.source.util.JavacTask;
import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/** 仅解析语法；此检查不替代 Android SDK 编译。 */
public final class ParseSources {
    public static void main(String[] args) throws Exception {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        List<File> files = new ArrayList<>();
        for (String arg : args) files.add(new File(arg));
        try (StandardJavaFileManager manager = compiler.getStandardFileManager(diagnostics, null, null)) {
            JavacTask task = (JavacTask) compiler.getTask(null, manager, diagnostics,
                    Arrays.asList("-proc:none", "-source", "8", "-encoding", "UTF-8"), null,
                    manager.getJavaFileObjectsFromFiles(files));
            task.parse();
            for (Diagnostic<?> diagnostic : diagnostics.getDiagnostics()) {
                if (diagnostic.getKind() == Diagnostic.Kind.ERROR) {
                    throw new AssertionError(diagnostic.toString());
                }
            }
        }
        System.out.println("PASS: Java 8 syntax parsed for " + files.size() + " source files (not Android compilation)");
    }
}
