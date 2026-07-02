import type { CapabilityReport } from "../types";

const TRANSFORMERS_CDN_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";
const FOUR_X_MODEL_ID = "Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr";
const FOUR_X_MODEL_DTYPE = "q8";
const FOUR_X_SCALE = 4;
const FOUR_X_TILE_SIZE = 192;
const FOUR_X_TILE_OVERLAP = 12;

type DeviceName = "webgpu" | "wasm";

type RawImageLike = {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: number;
};

type ImageToImagePipeline = (image: unknown) => Promise<RawImageLike>;

type TransformersModule = {
  env: { allowRemoteModels: boolean; allowLocalModels: boolean; logLevel: number };
  LogLevel: { ERROR: number };
  pipeline: (task: string, model: string, options: { device: DeviceName; dtype: string }) => Promise<unknown>;
  RawImage: { fromCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): RawImageLike };
};

let transformersPromise: Promise<TransformersModule> | null = null;
let pipelinePromise: Promise<ImageToImagePipeline> | null = null;
let pipelineDevice: DeviceName | null = null;

export function getFourXSupport(capabilities: CapabilityReport) {
  if (capabilities.bucket !== "desktop-chromium") {
    return {
      supported: false,
      reason: "4x 업스케일은 현재 데스크톱 Chromium 계열에서만 지원합니다.",
    };
  }

  if (!capabilities.hasCanvas2D || !capabilities.hasWorker || !capabilities.hasOffscreenCanvas) {
    return {
      supported: false,
      reason: "4x 업스케일에는 Canvas 2D, Web Worker, OffscreenCanvas가 필요합니다.",
    };
  }

  return { supported: true, reason: null };
}

export async function runFourXSuperResolution(source: ImageData): Promise<ImageData> {
  try {
    const upscaler = await loadFourXPipeline();
    return await runTiledSuperResolutionWith(source, upscaler);
  } catch (error) {
    if (pipelineDevice === "webgpu") {
      resetPipeline();
      const fallbackUpscaler = await loadFourXPipeline(["wasm"]);
      return runTiledSuperResolutionWith(source, fallbackUpscaler);
    }

    throw error;
  }
}

export function getFourXPipelineDevice() {
  return pipelineDevice;
}

async function loadFourXPipeline(preferredDevices: DeviceName[] = ["webgpu", "wasm"]): Promise<ImageToImagePipeline> {
  if (pipelinePromise) {
    return pipelinePromise;
  }

  pipelinePromise = createFourXPipeline(preferredDevices);

  try {
    return await pipelinePromise;
  } catch (error) {
    resetPipeline();
    throw error;
  }
}

async function createFourXPipeline(preferredDevices: DeviceName[]): Promise<ImageToImagePipeline> {
  const transformers = await loadTransformers();
  const { env, pipeline, LogLevel } = transformers;

  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.logLevel = LogLevel.ERROR;

  let lastError: unknown;

  for (const device of preferredDevices) {
    try {
      const loaded = (await pipeline("image-to-image", FOUR_X_MODEL_ID, {
        device,
        dtype: FOUR_X_MODEL_DTYPE,
      })) as unknown as ImageToImagePipeline;
      pipelineDevice = device;
      return loaded;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `4x 업스케일 모델을 불러오지 못했습니다: ${lastError.message}`
      : "4x 업스케일 모델을 불러오지 못했습니다.",
  );
}

function resetPipeline() {
  pipelinePromise = null;
  pipelineDevice = null;
}

function loadTransformers() {
  if (!transformersPromise) {
    transformersPromise = import(/* @vite-ignore */ TRANSFORMERS_CDN_URL) as Promise<TransformersModule>;
  }

  return transformersPromise;
}

async function imageDataToRawImage(imageData: ImageData) {
  const transformers = await loadTransformers();
  const { RawImage } = transformers;
  const canvas = createCanvas(imageData.width, imageData.height);
  const context = canvas.getContext("2d", { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;

  if (!context) {
    throw new Error("4x 업스케일에 필요한 Canvas 2D를 사용할 수 없습니다.");
  }

  context.putImageData(imageData, 0, 0);
  return RawImage.fromCanvas(canvas as HTMLCanvasElement & OffscreenCanvas);
}

function rawImageToImageData(image: RawImageLike): ImageData {
  const output = new Uint8ClampedArray(image.width * image.height * 4);

  if (image.channels === 4) {
    output.set(image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data));
    return new ImageData(output, image.width, image.height);
  }

  if (image.channels !== 3) {
    throw new Error(`4x 업스케일 결과 채널 수를 처리할 수 없습니다: ${image.channels}`);
  }

  for (let sourceIndex = 0, targetIndex = 0; sourceIndex < image.data.length; sourceIndex += 3, targetIndex += 4) {
    output[targetIndex] = image.data[sourceIndex];
    output[targetIndex + 1] = image.data[sourceIndex + 1];
    output[targetIndex + 2] = image.data[sourceIndex + 2];
    output[targetIndex + 3] = 255;
  }

  return new ImageData(output, image.width, image.height);
}

async function runTiledSuperResolutionWith(
  source: ImageData,
  upscaler: ImageToImagePipeline,
): Promise<ImageData> {
  const outputWidth = source.width * FOUR_X_SCALE;
  const outputHeight = source.height * FOUR_X_SCALE;
  const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);

  for (let coreY = 0; coreY < source.height; coreY += FOUR_X_TILE_SIZE) {
    const coreHeight = Math.min(FOUR_X_TILE_SIZE, source.height - coreY);
    const tileY = Math.max(0, coreY - FOUR_X_TILE_OVERLAP);
    const tileBottom = Math.min(source.height, coreY + coreHeight + FOUR_X_TILE_OVERLAP);
    const trimTop = coreY - tileY;

    for (let coreX = 0; coreX < source.width; coreX += FOUR_X_TILE_SIZE) {
      const coreWidth = Math.min(FOUR_X_TILE_SIZE, source.width - coreX);
      const tileX = Math.max(0, coreX - FOUR_X_TILE_OVERLAP);
      const tileRight = Math.min(source.width, coreX + coreWidth + FOUR_X_TILE_OVERLAP);
      const trimLeft = coreX - tileX;

      const tile = extractTile(source, tileX, tileY, tileRight - tileX, tileBottom - tileY);
      const upscaledTile = rawImageToImageData(await upscaler(await imageDataToRawImage(tile)));

      copyTileRegion(
        upscaledTile,
        output,
        outputWidth,
        coreX * FOUR_X_SCALE,
        coreY * FOUR_X_SCALE,
        trimLeft * FOUR_X_SCALE,
        trimTop * FOUR_X_SCALE,
        coreWidth * FOUR_X_SCALE,
        coreHeight * FOUR_X_SCALE,
      );
    }
  }

  return new ImageData(output, outputWidth, outputHeight);
}

function extractTile(source: ImageData, x: number, y: number, width: number, height: number): ImageData {
  const tile = new Uint8ClampedArray(width * height * 4);

  for (let row = 0; row < height; row += 1) {
    const sourceOffset = ((y + row) * source.width + x) * 4;
    const targetOffset = row * width * 4;
    tile.set(source.data.subarray(sourceOffset, sourceOffset + width * 4), targetOffset);
  }

  return new ImageData(tile, width, height);
}

function copyTileRegion(
  source: ImageData,
  destination: Uint8ClampedArray,
  destinationWidth: number,
  destX: number,
  destY: number,
  sourceX: number,
  sourceY: number,
  width: number,
  height: number,
) {
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = ((sourceY + row) * source.width + sourceX) * 4;
    const destinationOffset = ((destY + row) * destinationWidth + destX) * 4;
    destination.set(source.data.subarray(sourceOffset, sourceOffset + width * 4), destinationOffset);
  }
}

function createCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  throw new Error("4x 업스케일에 필요한 Canvas 2D를 사용할 수 없습니다.");
}
