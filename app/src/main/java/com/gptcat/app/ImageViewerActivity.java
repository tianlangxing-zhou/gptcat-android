package com.gptcat.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Matrix;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.Toast;

import com.gptcat.app.image.GallerySaver;
import com.gptcat.app.image.ImageLoader;
import com.gptcat.app.ui.WindowInsetsHelper;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** 全屏图片查看页：主线程只更新界面，下载、采样解码和保存均走串行工作队列。 */
public class ImageViewerActivity extends Activity {
    public static final String EXTRA_URL = "image";
    public static final String EXTRA_CACHE = "image_cache";
    private static final int WRITE_PERMISSION_REQUEST = 101;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private ImageView imageView;
    private Button save;
    private ProgressBar loading;
    private ImageLoader.Result current;
    private ImageLoader request;
    private Future<?> loadTask;
    private int generation;
    private boolean destroyed;
    private boolean saving;
    private boolean permissionPending;
    private final Matrix matrix = new Matrix();
    private ScaleGestureDetector scaleDetector;
    private float lastX, lastY;
    private boolean dragging;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_image_viewer);
        WindowInsetsHelper.apply(this, findViewById(R.id.imageRoot), false);
        imageView = findViewById(R.id.iv);
        save = findViewById(R.id.btnSave);
        loading = findViewById(R.id.imageLoading);
        findViewById(R.id.btnClose).setOnClickListener(v -> finish());
        save.setOnClickListener(v -> requestSave());
        setupGestures();
        String cache = state == null ? getIntent().getStringExtra(EXTRA_CACHE)
                : state.getString(EXTRA_CACHE, getIntent().getStringExtra(EXTRA_CACHE));
        load(getIntent().getStringExtra(EXTRA_URL), cache);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        load(intent.getStringExtra(EXTRA_URL), intent.getStringExtra(EXTRA_CACHE));
    }

    private void load(String url, String cache) {
        cancelLoad();
        final int version = ++generation;
        ImageLoader.Result previous = current;
        current = null;
        matrix.reset();
        imageView.setImageDrawable(null);
        if (previous != null && !previous.file.getName().equals(cache)) deleteLater(previous.file);
        updateSaveButton();
        loading.setVisibility(View.VISIBLE);
        DisplayMetrics display = getResources().getDisplayMetrics();
        int width = Math.min(2048, display.widthPixels);
        int height = Math.min(2048, display.heightPixels);
        ImageLoader next = new ImageLoader(getApplicationContext());
        request = next;
        loadTask = worker.submit(() -> {
            try {
                ImageLoader.Result result = next.load(url, cache, width, height);
                main.post(() -> {
                    if (destroyed || version != generation) {
                        result.preview.recycle();
                        // 新 Activity 可能复用外部传入的缓存；本次新下载则可立即清理。
                        if (!result.file.getName().equals(cache)) result.file.delete();
                        return;
                    }
                    current = result;
                    imageView.setImageBitmap(result.preview);
                    fitImage();
                    loading.setVisibility(View.GONE);
                    updateSaveButton();
                });
            } catch (IOException e) {
                main.post(() -> {
                    if (!destroyed && version == generation) {
                        loading.setVisibility(View.GONE);
                        toast("图片加载失败：" + e.getMessage());
                    }
                });
            }
        });
    }

    private void cancelLoad() {
        if (request != null) request.cancel();
        if (loadTask != null) loadTask.cancel(true);
        request = null;
        loadTask = null;
    }

    private void requestSave() {
        if (current == null || saving || permissionPending) return;
        if (Build.VERSION.SDK_INT <= 28 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            permissionPending = true;
            requestPermissions(new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE }, WRITE_PERMISSION_REQUEST);
            return;
        }
        saveToGallery();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != WRITE_PERMISSION_REQUEST) return;
        permissionPending = false;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) requestSave();
        else toast("未获得存储权限，无法保存到相册");
    }

    private void saveToGallery() {
        if (current == null || saving) return;
        final ImageLoader.Result image = current;
        final android.content.Context context = getApplicationContext();
        saving = true;
        updateSaveButton();
        worker.execute(() -> {
            String message;
            try {
                GallerySaver.save(context, image);
                message = "已保存原图到 Pictures/GPTCat";
            } catch (IOException | RuntimeException e) {
                message = "保存失败：" + e.getMessage();
            }
            final String result = message;
            main.post(() -> {
                if (destroyed) return;
                saving = false;
                updateSaveButton();
                toast(result);
            });
        });
    }

    private void updateSaveButton() {
        save.setEnabled(current != null && !saving);
        save.setText(saving ? R.string.image_saving : R.string.image_save);
    }

    private void deleteLater(File file) { worker.execute(() -> file.delete()); }

    // 双指缩放(0.5x~10x，以双指中心为轴) + 单指拖动
    private void setupGestures() {
        scaleDetector = new ScaleGestureDetector(this, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override
            public boolean onScale(ScaleGestureDetector detector) {
                float[] values = new float[9];
                matrix.getValues(values);
                float current = values[Matrix.MSCALE_X];
                float next = Math.max(0.5f, Math.min(10f, current * detector.getScaleFactor()));
                matrix.postScale(next / current, next / current,
                        detector.getFocusX(), detector.getFocusY());
                imageView.setImageMatrix(matrix);
                return true;
            }
        });
        imageView.setOnTouchListener((v, event) -> {
            scaleDetector.onTouchEvent(event);
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    lastX = event.getX();
                    lastY = event.getY();
                    dragging = true;
                    break;
                case MotionEvent.ACTION_MOVE:
                    if (!scaleDetector.isInProgress() && dragging) {
                        matrix.postTranslate(event.getX() - lastX, event.getY() - lastY);
                        imageView.setImageMatrix(matrix);
                    }
                    lastX = event.getX();
                    lastY = event.getY();
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    dragging = false;
                    break;
                default:
                    break;
            }
            return true;
        });
    }

    // 首次显示按 fitCenter 初始化矩阵，之后的缩放/拖动基于此
    private void fitImage() {
        if (current == null) return;
        if (imageView.getWidth() == 0) {
            imageView.post(this::fitImage);
            return;
        }
        Bitmap bm = current.preview;
        float vw = imageView.getWidth(), vh = imageView.getHeight();
        float bw = bm.getWidth(), bh = bm.getHeight();
        float scale = Math.min(vw / bw, vh / bh);
        matrix.reset();
        matrix.postScale(scale, scale);
        matrix.postTranslate((vw - bw * scale) / 2f, (vh - bh * scale) / 2f);
        imageView.setScaleType(ImageView.ScaleType.MATRIX);
        imageView.setImageMatrix(matrix);
    }

    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_SHORT).show(); }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        if (current != null) state.putString(EXTRA_CACHE, current.file.getName());
        super.onSaveInstanceState(state);
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        generation++;
        cancelLoad();
        imageView.setImageDrawable(null);
        if (current != null && !isChangingConfigurations()) deleteLater(current.file);
        current = null;
        // 已提交的保存先完成再清理文件；不在关闭页面时中断用户的保存操作。
        worker.shutdown();
        super.onDestroy();
    }
}
