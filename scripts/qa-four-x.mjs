import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import process from "node:process";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(root, "artifacts", "qa-matrix");
const previewPort = 4575;
const previewUrl = `http://127.0.0.1:${previewPort}`;
const viteCliPath = path.join(root, "node_modules", "vite", "bin", "vite.js");
const server = spawn(
  process.execPath,
  [viteCliPath, "preview", "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], shell: false },
);

try {
  await waitForPreview(server);
  const report = await runSmokeTest();
  await mkdir(artifactsDir, { recursive: true });
  const reportPath = path.join(artifactsDir, "qa-four-x.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: reportPath, ...report }, null, 2));

  if (report.status !== "passed") {
    process.exitCode = 1;
  }
} finally {
  await stopPreviewServer(server);
}

async function runSmokeTest() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    const page = await context.newPage();
    const networkUrls = [];
    const failedRequests = [];
    page.on("request", (request) => networkUrls.push(request.url()));
    page.on("requestfailed", (request) => failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText ?? "unknown",
    }));

    await page.goto(previewUrl, { waitUntil: "networkidle" });
    const fixture = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 64, height: 64 } });
    await page.locator('input[type="file"]').setInputFiles({
      name: "four-x-smoke.png",
      mimeType: "image/png",
      buffer: fixture,
    });
    await waitForReadyResult(page, "four-x-smoke.png", null, 45000);

    const originalDimensions = await page.evaluate(() => window.__imageEnhancerDebug?.dimensions ?? null);
    await page.locator('input[name="output-mode"][value="4x"]').check();
    await page.waitForFunction(
      () => {
        const phase = document.querySelector("[data-phase]")?.getAttribute("data-phase");
        return phase === "error" || (phase === "ready" && window.__imageEnhancerDebug?.strategy === "4x:4x");
      },
      undefined,
      { timeout: 180000 },
    );

    const result = await page.evaluate(() => ({
      phase: document.querySelector("[data-phase]")?.getAttribute("data-phase") ?? null,
      strategy: window.__imageEnhancerDebug?.strategy ?? null,
      dimensions: window.__imageEnhancerDebug?.dimensions ?? null,
      error: document.querySelector(".error-panel")?.textContent?.trim() ?? "",
    }));
    const remoteRuntimeRequests = networkUrls.filter((url) => (
      /^https?:/i.test(url) && new URL(url).origin !== new URL(previewUrl).origin
    ));
    const modelRequests = networkUrls.filter((url) => url.includes("/models/"));
    const wasmRequests = networkUrls.filter((url) => /ort-wasm.*\.wasm(?:$|\?)/.test(url));
    const dimensionsPassed = Boolean(
      originalDimensions
      && result.dimensions
      && result.dimensions.width === originalDimensions.width * 4
      && result.dimensions.height === originalDimensions.height * 4,
    );
    const passed = result.phase === "ready"
      && result.strategy === "4x:4x"
      && dimensionsPassed
      && modelRequests.length > 0
      && wasmRequests.length > 0
      && remoteRuntimeRequests.length === 0
      && failedRequests.length === 0;

    return {
      status: passed ? "passed" : "failed",
      ...result,
      originalDimensions,
      dimensionsPassed,
      modelRequests,
      wasmRequests,
      remoteRuntimeRequests,
      failedRequests,
    };
  } finally {
    await browser.close();
  }
}

async function waitForReadyResult(page, sourceName, previousPreviewUrl, timeout) {
  await page.waitForFunction(
    ({ expectedName, previousUrl }) => {
      const phase = document.querySelector("[data-phase]")?.getAttribute("data-phase");
      const debug = window.__imageEnhancerDebug;
      return phase === "ready"
        && debug?.sourceName === expectedName
        && Boolean(debug?.previewObjectUrl)
        && debug.previewObjectUrl !== previousUrl;
    },
    { expectedName: sourceName, previousUrl: previousPreviewUrl },
    { timeout },
  );
}

async function waitForPreview(child) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for preview server.")), 20000);
    const onData = (chunk) => {
      if (!chunk.toString().includes("Local:")) return;
      clearTimeout(timeout);
      cleanup();
      resolve();
    };
    const onExit = (code) => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error(`Preview server exited early with code ${code}.`));
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

async function stopPreviewServer(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `taskkill /PID ${child.pid} /T /F`], {
      cwd: root,
      stdio: "ignore",
      shell: false,
    });
    await new Promise((resolve) => killer.on("exit", resolve));
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("exit", resolve));
}
