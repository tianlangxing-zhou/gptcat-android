package com.gptcat.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Matrix;
import android.graphics.RectF;
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

/** 全屏图片查看页：下载、采样解码、保存都在后台；旧 Bitmap 会主动回收。 */
public class ImageViewerActivity extends Activity {
    public static final String EXTRA_URL = "image";
    public static final String EXTRA_CACHE = "image_cache";

    private static final int WRITE_PERMISSION_REQUEST = 101;
    private static final float MAX_ZOOM = 8f;

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
    private float zoom = 1f;
    private float lastX;
    private float lastY;
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

        String cache = state == null
                ? getIntent().getStringExtra(EXTRA_CACHE)
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
        zoom = 1f;
        imageView.setImageDrawable(null);

        if (previous != null) {
            recyclePreview(previous);
            if (!previous.file.getName().equals(cache)) deleteLater(previous.file);
        }

        updateSaveButton();
        loading.setVisibility(View.VISIBLE);

        DisplayMetrics display = getResources().getDisplayMetrics();
        int width = Math.min(2048, Math.max(1, display.widthPixels));
        int height = Math.min(2048, Math.max(1, display.heightPixels));

        ImageLoader next = new ImageLoader(getApplicationContext());
        request = next;
        loadTask = worker.submit(() -> {
            try {
                ImageLoader.Result result = next.load(url, cache, width, height);
                main.post(() -> {
                    if (destroyed || version != generation) {
                        recyclePreview(result);
                        // 新 Activity 可能复用外部传入的缓存；本次新下载则可立即清理。
                        if (!result.file.getName().equals(cache)) result.file.delete();
                        return;
                    }

                    current = result;
                    request = null;
                    loadTask = null;
                    imageView.setImageBitmap(result.preview);
                    fitImage();
                    loading.setVisibility(View.GONE);
                    updateSaveButton();
                });
            } catch (IOException e) {
                main.post(() -> {
                    if (!destroyed && version == generation) {
                        request = null;
                        loadTask = null;
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

        if (Build.VERSION.SDK_INT <= 28
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            permissionPending = true;
            updateSaveButton();
            requestPermissions(new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE },
                    WRITE_PERMISSION_REQUEST);
            return;
        }

        saveToGallery();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != WRITE_PERMISSION_REQUEST) return;

        permissionPending = false;
        updateSaveButton();
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            requestSave();
        } else {
            toast("未获得存储权限，无法保存到相册");
        }
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
        if (save == null) return;
        save.setEnabled(current != null && !saving && !permissionPending);
        save.setText(saving ? R.string.image_saving : R.string.image_save);
    }

    private void deleteLater(File file) {
        if (file == null) return;
        worker.execute(file::delete);
    }

    private static void recyclePreview(ImageLoader.Result result) {
        if (result != null && result.preview != null && !result.preview.isRecycled()) {
            result.preview.recycle();
        }
    }

    // 双指缩放（以 fitCenter 为 1x，最大 8x）+ 单指拖动，并把图片约束在可视区域附近。
    private void setupGestures() {
        scaleDetector = new ScaleGestureDetector(
                this,
                new ScaleGestureDetector.SimpleOnScaleGestureListener() {
                    @Override
                    public boolean onScale(ScaleGestureDetector detector) {
                        if (current == null) return false;

                        float nextZoom = Math.max(1f,
                                Math.min(MAX_ZOOM, zoom * detector.getScaleFactor()));
                        float factor = nextZoom / zoom;
                        if (Math.abs(factor - 1f) < 0.0001f) return true;

                        matrix.postScale(factor, factor,
                                detector.getFocusX(), detector.getFocusY());
                        zoom = nextZoom;
                        constrainMatrix();
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
                    if (!scaleDetector.isInProgress() && dragging && current != null) {
                        matrix.postTranslate(event.getX() - lastX, event.getY() - lastY);
                        constrainMatrix();
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

    /** 首次显示按 fitCenter 初始化矩阵。 */
    private void fitImage() {
        if (current == null) return;
        if (imageView.getWidth() == 0 || imageView.getHeight() == 0) {
            imageView.post(this::fitImage);
            return;
        }

        Bitmap bitmap = current.preview;
        float viewWidth = imageView.getWidth();
        float viewHeight = imageView.getHeight();
        float bitmapWidth = bitmap.getWidth();
        float bitmapHeight = bitmap.getHeight();

        float scale = Math.min(viewWidth / bitmapWidth, viewHeight / bitmapHeight);
        zoom = 1f;
        matrix.reset();
        matrix.postScale(scale, scale);
        matrix.postTranslate(
                (viewWidth - bitmapWidth * scale) / 2f,
                (viewHeight - bitmapHeight * scale) / 2f);

        imageView.setScaleType(ImageView.ScaleType.MATRIX);
        imageView.setImageMatrix(matrix);
    }

    private void constrainMatrix() {
        if (current == null || imageView.getWidth() <= 0 || imageView.getHeight() <= 0) return;

        RectF rect = new RectF(0, 0,
                current.preview.getWidth(), current.preview.getHeight());
        matrix.mapRect(rect);

        float viewWidth = imageView.getWidth();
        float viewHeight = imageView.getHeight();
        float dx = 0f;
        float dy = 0f;

        if (rect.width() <= viewWidth) {
            dx = viewWidth / 2f - rect.centerX();
        } else if (rect.left > 0f) {
            dx = -rect.left;
        } else if (rect.right < viewWidth) {
            dx = viewWidth - rect.right;
        }

        if (rect.height() <= viewHeight) {
            dy = viewHeight / 2f - rect.centerY();
        } else if (rect.top > 0f) {
            dy = -rect.top;
        } else if (rect.bottom < viewHeight) {
            dy = viewHeight - rect.bottom;
        }

        if (dx != 0f || dy != 0f) matrix.postTranslate(dx, dy);
        imageView.setImageMatrix(matrix);
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

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

        if (imageView != null) imageView.setImageDrawable(null);

        ImageLoader.Result image = current;
        current = null;
        if (image != null) {
            recyclePreview(image);
            if (!isChangingConfigurations()) deleteLater(image.file);
        }

        // 已提交的保存先完成再清理文件；不在关闭页面时中断用户的保存操作。
        worker.shutdown();
        super.onDestroy();
    }
}
