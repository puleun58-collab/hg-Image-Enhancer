import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import process from "node:process";
import { chromium, devices, firefox } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const artifactsDir = path.join(root, "artifacts", "qa-matrix");
const previewPort = 4574;
const previewUrl = `http://127.0.0.1:${previewPort}`;
const shellCommand = process.env.ComSpec || "cmd.exe";
const viteCliPath = path.join(root, "node_modules", "vite", "bin", "vite.js");

const targets = [
  {
    id: "desktop-chromium",
    browserType: chromium,
    contextOptions: { viewport: { width: 1440, height: 1024 }, acceptDownloads: true },
  },
  {
    id: "desktop-firefox",
    browserType: firefox,
    contextOptions: { viewport: { width: 1440, height: 1024 }, acceptDownloads: true },
  },
];

const fixtureNames = {
  text: "text-heavy-12mp.jpg",
  haze: "haze-heavy-12mp.jpg",
  noisy: "noisy-low-light-12mp.jpg",
  oversize: "force-downscale-28mp.jpg",
};

await mkdir(artifactsDir, { recursive: true });
const server = startPreviewServer();

try {
  await waitForPreview(server, previewUrl);
  const report = {
    url: previewUrl,
    generatedAt: new Date().toISOString(),
    targets: [],
  };

  for (const target of targets) {
    report.targets.push(await runTarget(target));
  }

  report.responsive = await runResponsiveVisual();
  report.accessibility = await runAccessibilityChecks();
  report.darkMode = await runDarkModeVisual();
  report.mobileSupport = await runMobileSupportVisual();

  const outPath = path.join(artifactsDir, "qa-matrix.json");
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: outPath, targets: report.targets.map((target) => ({ id: target.id, status: target.status })) }, null, 2));
} finally {
  await stopPreviewServer(server);
}

function startPreviewServer() {
  return spawn(process.execPath, [viteCliPath, "preview", "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
}

async function stopPreviewServer(server) {
  if (server.exitCode !== null) {
    return;
  }

  if (process.platform === 'win32' && server.pid) {
    const killer = spawn(shellCommand, ['/d', '/s', '/c', `taskkill /PID ${server.pid} /T /F`], {
      cwd: root,
      stdio: 'ignore',
      shell: false,
    });
    await new Promise((resolve) => killer.on('exit', resolve));
    return;
  }

  server.kill('SIGTERM');
  await new Promise((resolve) => server.on('exit', resolve));
}

async function waitForPreview(server, url) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for preview server.")), 20000);
    const onData = (chunk) => {
      const text = chunk.toString();
      if (text.includes(url) || text.includes("Local:")) {
        clearTimeout(timeout);
        cleanup();
        resolve();
      }
    };
    const onExit = (code) => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error(`Preview server exited early with code ${code}.`));
    };
    const cleanup = () => {
      server.stdout.off("data", onData);
      server.stderr.off("data", onData);
      server.off("exit", onExit);
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    server.on("exit", onExit);
  });
}

async function runTarget(target) {
  const browser = await target.browserType.launch({ headless: true });
  try {
    const context = await browser.newContext(target.contextOptions);
    const page = await context.newPage();
    await page.goto(previewUrl, { waitUntil: "networkidle" });

    const timingSeries = [];
    const parity = [];
    const downloads = [];
    let readyScreenshotPath = null;

    const oversizePrompt = await triggerOversizePrompt(page, path.join(root, "fixtures", fixtureNames.oversize));
    const oversizeDownscaled = await finishOversizeDownscale(page);

    for (const fixture of [fixtureNames.text, fixtureNames.haze, fixtureNames.noisy]) {
      const fixturePath = path.join(root, "fixtures", fixture);
      const previewRuns = [];
      const exportRuns = { png: [], jpg: [] };

      for (let iteration = 1; iteration <= 3; iteration += 1) {
        await page.goto(previewUrl, { waitUntil: "networkidle" });
        const result = await uploadAndWait(page, fixturePath);
        previewRuns.push({ iteration, ...result });

        const pngParity = iteration === 1 ? await collectParityMetrics(page) : null;
        const pngDownload = await captureDownload(page, target.id, fixture, "PNG", iteration);
        exportRuns.png.push(pngDownload);
        downloads.push({ fixture, ...pngDownload });

        const jpgDownload = await captureDownload(page, target.id, fixture, "JPG", iteration);
        exportRuns.jpg.push(jpgDownload);
        downloads.push({ fixture, ...jpgDownload });
        const jpgParity = iteration === 1 ? await collectParityMetrics(page) : null;

        if (iteration === 1 && pngParity && jpgParity) {
          parity.push({ fixture, png: pngParity, jpg: jpgParity });
        }

        if (fixture === fixtureNames.text && iteration === 1) {
          readyScreenshotPath = path.join(artifactsDir, `${target.id}-ready.png`);
          await page.screenshot({ path: readyScreenshotPath, fullPage: true });
        }
      }

      const previewValues = previewRuns
        .map((entry) => entry.processingMs)
        .filter((value) => Number.isFinite(value));
      const pngExportValues = exportRuns.png
        .map((entry) => entry.durationMs)
        .filter((value) => Number.isFinite(value));
      const jpgExportValues = exportRuns.jpg
        .map((entry) => entry.durationMs)
        .filter((value) => Number.isFinite(value));
      timingSeries.push({
        fixture,
        previewRuns,
        previewMedianMs: previewValues.length > 0 ? median(previewValues) : Number.NaN,
        exportRuns,
        exportMedianMs: {
          png: pngExportValues.length > 0 ? median(pngExportValues) : Number.NaN,
          jpg: jpgExportValues.length > 0 ? median(jpgExportValues) : Number.NaN,
        },
      });
    }

    const screenshotPath = path.join(artifactsDir, `${target.id}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const maxPreviewMedianMs = Math.max(...timingSeries.map((entry) => entry.previewMedianMs));
    const previewTimingPass = timingSeries.every((entry) => entry.previewMedianMs <= 10000);
    const exportTimingCaptured = timingSeries.every((entry) => (
      Number.isFinite(entry.exportMedianMs.png)
      && Number.isFinite(entry.exportMedianMs.jpg)
    ));
    const parityPass = parity.every((entry) => (
      entry.png.edgeDriftPercent <= 5
      && entry.png.meanChannelDelta <= 18
      && entry.jpg.edgeDriftPercent <= 5
      && entry.jpg.meanChannelDelta <= 18
    ));
    const status = previewTimingPass
      && exportTimingCaptured
      && parityPass
      && oversizeDownscaled.phase === "ready"
      ? "passed"
      : "failed";

    return {
      id: target.id,
      status,
      timings: timingSeries,
      maxPreviewMedianMs,
      parity,
      downloads,
      oversizePrompt,
      oversizeDownscaled,
      screenshotPath,
      readyScreenshotPath,
    };
  } finally {
    await browser.close();
  }
}

async function getUiState(page) {
  return page.evaluate(() => ({
    phaseText: document.querySelector('[data-phase]')?.textContent?.trim() ?? 'unknown',
    phaseValue: document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? null,
    sourceName: window.__imageEnhancerDebug?.sourceName ?? null,
    exportFormat: window.__imageEnhancerDebug?.exportFormat ?? null,
    previewObjectUrl: window.__imageEnhancerDebug?.previewObjectUrl ?? null,
    exportObjectUrl: window.__imageEnhancerDebug?.exportObjectUrl ?? null,
    status: document.querySelector('.live-status p')?.textContent?.trim() ?? '',
    renderMeta: document.querySelector('.render-meta')?.textContent?.trim() ?? '',
  }));
}

async function waitForReadyResult(page, expectedSourceName, previousPreviewUrl, timeout) {
  await page.waitForFunction(
    ({ sourceName, previewUrl }) => {
      const phase = document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? '';
      const renderMeta = document.querySelector('.render-meta')?.textContent?.trim() ?? '';
      const debug = window.__imageEnhancerDebug;
      return phase === 'ready'
        && debug?.sourceName === sourceName
        && Boolean(debug?.previewObjectUrl)
        && debug.previewObjectUrl !== previewUrl
        && /\d+\s*ms/.test(renderMeta);
    },
    { sourceName: expectedSourceName, previewUrl: previousPreviewUrl },
    { timeout },
  );
}

async function waitForExportResult(page, expectedFormat, previousExportUrl, timeout) {
  await page.waitForFunction(
    ({ format, exportUrl }) => {
      const phase = document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? '';
      const debug = window.__imageEnhancerDebug;
      return phase === 'ready'
        && debug?.exportFormat === format
        && Boolean(debug?.exportObjectUrl)
        && debug.exportObjectUrl !== exportUrl;
    },
    { format: expectedFormat, exportUrl: previousExportUrl },
    { timeout },
  );
}

async function uploadAndWait(page, fixturePath) {
  const previousState = await getUiState(page);
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  await waitForReadyResult(page, path.basename(fixturePath), previousState.previewObjectUrl, 45000);
  return page.evaluate(() => {
    const phase = document.querySelector('[data-phase]')?.getAttribute('data-phase')
      ?? document.querySelector('[data-phase]')?.textContent?.trim()
      ?? 'unknown';
    const status = document.querySelector('.live-status p')?.textContent?.trim() ?? '';
    const renderMeta = document.querySelector('.render-meta')?.textContent?.trim() ?? '';
    const match = renderMeta.match(/(\d+)\s*ms/);
    return {
      phase,
      status,
      renderMeta,
      processingMs: match ? Number(match[1]) : Number.NaN,
    };
  });
}

async function collectParityMetrics(page) {
  await page.waitForFunction(
    () => Boolean(window.__imageEnhancerDebug?.debugPreviewUrl && window.__imageEnhancerDebug?.exportObjectUrl),
    undefined,
    { timeout: 30000 },
  );

  return page.evaluate(async () => {
    const debug = window.__imageEnhancerDebug;
    if (!debug?.debugPreviewUrl || !debug?.exportObjectUrl) {
      throw new Error("Debug preview data is unavailable.");
    }

    const loadImage = async (url) => {
      const blob = await fetch(url).then((response) => response.blob());
      const bitmap = await createImageBitmap(blob);
      return { blob, bitmap };
    };

    const preview = await loadImage(debug.debugPreviewUrl);
    const exported = await loadImage(debug.exportObjectUrl);
    const width = preview.bitmap.width;
    const height = preview.bitmap.height;

    const cropInsetX = Math.max(1, Math.floor(width * 0.12));
    const cropInsetY = Math.max(1, Math.floor(height * 0.12));
    const cropStartX = cropInsetX;
    const cropStartY = cropInsetY;
    const cropEndX = Math.max(cropStartX + 2, width - cropInsetX);
    const cropEndY = Math.max(cropStartY + 2, height - cropInsetY);

    const makeCanvas = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    };

    const previewCanvas = makeCanvas();
    const exportCanvas = makeCanvas();
    const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
    const exportCtx = exportCanvas.getContext('2d', { willReadFrequently: true });
    if (!previewCtx || !exportCtx) {
      throw new Error('Canvas 2D unavailable during parity collection.');
    }

    previewCtx.imageSmoothingEnabled = true;
    previewCtx.imageSmoothingQuality = 'medium';
    exportCtx.imageSmoothingEnabled = true;
    exportCtx.imageSmoothingQuality = 'medium';
    previewCtx.drawImage(preview.bitmap, 0, 0, width, height);
    exportCtx.drawImage(exported.bitmap, 0, 0, width, height);

    const previewData = previewCtx.getImageData(0, 0, width, height).data;
    const exportData = exportCtx.getImageData(0, 0, width, height).data;

    let channelDelta = 0;
    let samples = 0;
    for (let y = cropStartY; y < cropEndY; y += 1) {
      for (let x = cropStartX; x < cropEndX; x += 1) {
        const index = (y * width + x) * 4;
        channelDelta += Math.abs(previewData[index] - exportData[index]);
        channelDelta += Math.abs(previewData[index + 1] - exportData[index + 1]);
        channelDelta += Math.abs(previewData[index + 2] - exportData[index + 2]);
        samples += 3;
      }
    }

    const lumaAt = (data, x, y) => {
      const index = (y * width + x) * 4;
      return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
    };

    const meanEdge = (data) => {
      let total = 0;
      let count = 0;
      for (let y = cropStartY; y < cropEndY; y += 1) {
        for (let x = cropStartX; x < cropEndX; x += 1) {
          const gx =
            -lumaAt(data, x - 1, y - 1) - 2 * lumaAt(data, x - 1, y) - lumaAt(data, x - 1, y + 1)
            + lumaAt(data, x + 1, y - 1) + 2 * lumaAt(data, x + 1, y) + lumaAt(data, x + 1, y + 1);
          const gy =
            -lumaAt(data, x - 1, y - 1) - 2 * lumaAt(data, x, y - 1) - lumaAt(data, x + 1, y - 1)
            + lumaAt(data, x - 1, y + 1) + 2 * lumaAt(data, x, y + 1) + lumaAt(data, x + 1, y + 1);
          total += Math.sqrt(gx * gx + gy * gy);
          count += 1;
        }
      }
      return total / Math.max(count, 1);
    };

    const previewEdge = meanEdge(previewData);
    const exportEdge = meanEdge(exportData);
    const edgeDriftPercent = Math.abs(previewEdge - exportEdge) / Math.max(previewEdge, 1) * 100;

    preview.bitmap.close();
    exported.bitmap.close();

    return {
      crop: {
        x: cropStartX,
        y: cropStartY,
        width: cropEndX - cropStartX,
        height: cropEndY - cropStartY,
      },
      meanChannelDelta: Number((channelDelta / samples).toFixed(2)),
      edgeDriftPercent: Number(edgeDriftPercent.toFixed(2)),
    };
  });
}

async function captureDownload(page, targetId, fixture, formatLabel, iteration) {
  const targetFormat = formatLabel === 'JPG' ? 'image/jpeg' : 'image/png';
  const previousState = await getUiState(page);

  await page.locator(`input[name="export-format"][value="${targetFormat}"]`).check();

  if (previousState.exportFormat !== targetFormat) {
    await waitForExportResult(page, targetFormat, previousState.exportObjectUrl, 45000);
  } else {
    await waitForPhase(page, 'ready', 30000);
  }

  const startedAt = Date.now();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action="export-image"]').click(),
  ]);
  const suggestedFilename = download.suggestedFilename();
  const extension = path.extname(suggestedFilename) || (formatLabel === 'JPG' ? '.jpg' : '.png');
  const fixtureStem = path.parse(fixture).name;
  const savedPath = path.join(artifactsDir, `${targetId}-${fixtureStem}-${formatLabel.toLowerCase()}-run${iteration}${extension}`);
  await download.saveAs(savedPath);

  return {
    format: formatLabel,
    iteration,
    durationMs: Date.now() - startedAt,
    suggestedFilename,
    savedPath,
  };
}

async function triggerOversizePrompt(page, fixturePath) {
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  try {
    await waitForPhase(page, 'awaiting-oversize-decision', 10000);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      phase: document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? 'unknown',
      error: document.querySelector('.error-panel')?.textContent?.trim() ?? '',
      prompt: document.querySelector('.prompt-panel')?.textContent?.trim() ?? '',
      sourceName: window.__imageEnhancerDebug?.sourceName ?? null,
    }));
    throw new Error(`Oversize prompt did not appear: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  return page.evaluate(() => ({
    phase: document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? 'unknown',
    message: document.querySelector('.prompt-panel p')?.textContent?.trim() ?? '',
    keepOriginalDisabled: document.querySelector('.prompt-panel .button-primary')?.hasAttribute('disabled') ?? true,
  }));
}

async function finishOversizeDownscale(page) {
  await page.locator('[data-action="downscale"]').click();
  await waitForPhase(page, 'ready', 45000);
  return page.evaluate(() => ({
    phase: document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? 'unknown',
    status: document.querySelector('.live-status p')?.textContent?.trim() ?? '',
    renderMeta: document.querySelector('.render-meta')?.textContent?.trim() ?? '',
  }));
}

async function waitForPhase(page, expected, timeout) {
  await page.waitForFunction(
    (phase) => {
      const badge = document.querySelector('[data-phase]');
      const raw = badge?.getAttribute('data-phase') ?? badge?.textContent ?? '';
      return raw.trim().toLowerCase() === phase;
    },
    expected.toLowerCase(),
    { timeout },
  );
}

async function runResponsiveVisual() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(previewUrl, { waitUntil: "networkidle" });
    await uploadAndWait(page, path.join(root, "fixtures", fixtureNames.text));

    const compareControl = page.locator('#compare-position');
    await compareControl.focus();
    await compareControl.press('ArrowRight');

    const screenshotPath = path.join(artifactsDir, 'responsive-390-ready.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    return await page.evaluate((savedPath) => ({
      status: document.documentElement.scrollWidth <= window.innerWidth ? 'passed' : 'failed',
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      comparePosition: document.querySelector('#compare-position')?.value ?? null,
      phase: document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? 'unknown',
      screenshotPath: savedPath,
    }), screenshotPath);
  } finally {
    await browser.close();
  }
}

async function runAccessibilityChecks() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    const page = await context.newPage();
    await page.goto(previewUrl, { waitUntil: "networkidle" });

    await page.keyboard.press('Tab');
    const skipLink = await page.evaluate(() => {
      const active = document.activeElement;
      const rect = active?.getBoundingClientRect();
      return {
        isActive: active?.classList.contains('skip-link') ?? false,
        isVisible: Boolean(rect && rect.width > 1 && rect.height > 1),
      };
    });

    await page.keyboard.press('Tab');
    const primaryAction = await page.evaluate(() => ({
      tagName: document.activeElement?.tagName ?? null,
      label: document.activeElement?.textContent?.trim() ?? null,
    }));

    const headings = await page.evaluate(() => {
      const levels = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
        .map((heading) => Number(heading.tagName.slice(1)));
      return {
        levels,
        hasSingleH1: levels.filter((level) => level === 1).length === 1,
        hasNoLevelJump: levels.every((level, index) => index === 0 || level <= levels[index - 1] + 1),
      };
    });

    const previousState = await getUiState(page);
    await page.locator('input[type="file"]').setInputFiles(path.join(root, "fixtures", fixtureNames.text));
    await waitForPhase(page, 'processing', 10000);
    const processingLock = await page.evaluate(() => ({
      exportDisabled: document.querySelector('[data-action="export-image"]')?.hasAttribute('disabled') ?? false,
      radiosDisabled: [...document.querySelectorAll('input[type="radio"]')]
        .every((input) => input instanceof HTMLInputElement && input.disabled),
      compareBusy: document.querySelector('.compare-frame')?.getAttribute('aria-busy') === 'true',
    }));
    await waitForReadyResult(page, fixtureNames.text, previousState.previewObjectUrl, 45000);

    const compareControl = page.locator('#compare-position');
    await compareControl.focus();
    const focusIndicator = await compareControl.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
      };
    });

    await page.goto(previewUrl, { waitUntil: "networkidle" });
    await page.locator('input[type="file"]').setInputFiles(path.join(root, "fixtures", fixtureNames.oversize));
    await waitForPhase(page, 'awaiting-oversize-decision', 10000);
    const promptFocus = await page.evaluate(() => ({
      activeId: document.activeElement?.id ?? null,
      role: document.querySelector('.prompt-panel')?.getAttribute('role') ?? null,
    }));

    const status = skipLink.isActive
      && skipLink.isVisible
      && primaryAction.tagName === 'BUTTON'
      && headings.hasSingleH1
      && headings.hasNoLevelJump
      && processingLock.exportDisabled
      && processingLock.radiosDisabled
      && processingLock.compareBusy
      && focusIndicator.outlineStyle !== 'none'
      && Number.parseFloat(focusIndicator.outlineWidth) >= 3
      && promptFocus.activeId === 'oversize-title'
      && promptFocus.role === 'alert'
      ? 'passed'
      : 'failed';

    return {
      status,
      skipLink,
      primaryAction,
      headings,
      processingLock,
      focusIndicator,
      promptFocus,
    };
  } finally {
    await browser.close();
  }
}

async function runDarkModeVisual() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1024 },
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    await page.goto(previewUrl, { waitUntil: "networkidle" });
    const screenshotPath = path.join(artifactsDir, 'desktop-dark-idle.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    return await page.evaluate((savedPath) => {
      const rootStyle = getComputedStyle(document.documentElement);
      const panelStyle = getComputedStyle(document.querySelector('.panel'));
      const responsive = document.documentElement.scrollWidth <= window.innerWidth;
      return {
        status: rootStyle.colorScheme.includes('dark') && responsive ? 'passed' : 'failed',
        colorScheme: rootStyle.colorScheme,
        pageBackground: rootStyle.backgroundColor,
        surfaceBackground: panelStyle.backgroundColor,
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        screenshotPath: savedPath,
      };
    }, screenshotPath);
  } finally {
    await browser.close();
  }
}

async function runMobileSupportVisual() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await context.newPage();
    await page.goto(previewUrl, { waitUntil: "networkidle" });
    const screenshotPath = path.join(artifactsDir, 'mobile-chromium-blocked.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    return await page.evaluate((savedPath) => {
      const phase = document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? null;
      const bucket = document.querySelector('.capability-pill strong')?.textContent?.trim() ?? null;
      const responsive = document.documentElement.scrollWidth <= window.innerWidth;
      return {
        status: phase === 'compatibility-blocked' && responsive ? 'passed' : 'failed',
        phase,
        bucket,
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        screenshotPath: savedPath,
      };
    }, screenshotPath);
  } finally {
    await browser.close();
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
