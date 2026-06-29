import type {
  ImageSource,
  OversizeDecision,
  ProcessedImageSet,
  RenderResult,
} from "../types";

export const ORIGINAL_SIZE_GUARDRAIL_MEGAPIXELS = 24;
export const ORIGINAL_SIZE_GUARDRAIL_RGBA_BYTES = 128 * 1024 * 1024;
export const OVERSIZE_MEGAPIXEL_THRESHOLD = 16;
export const OVERSIZE_PIXEL_THRESHOLD = OVERSIZE_MEGAPIXEL_THRESHOLD * 1_000_000;
export const PREVIEW_MAX_EDGE = 1600;

export interface OutputSizing {
  strategy: "original" | "downscaled";
  width: number;
  height: number;
  scale: number;
}

export interface PreviewSizing {
  width: number;
  height: number;
  scale: number;
}

export function clampDimension(value: number): number {
  return Math.max(1, Math.round(value));
}

export function clampStrength(strength: number): number {
  if (!Number.isFinite(strength)) {
    return 0;
  }

  return Math.min(1, Math.max(0, strength));
}

export function computeMegapixels(width: number, height: number): number {
  return (width * height) / 1_000_000;
}

export function estimateRgbaBytes(width: number, height: number): number {
  return width * height * 4;
}

export function isOversize(width: number, height: number): boolean {
  return width * height > OVERSIZE_PIXEL_THRESHOLD;
}

export function getOversizeDecision(
  source: Pick<ImageSource, "width" | "height" | "megapixels" | "estimatedRgbaBytes">,
): OversizeDecision {
  const allowOriginal =
    source.megapixels <= ORIGINAL_SIZE_GUARDRAIL_MEGAPIXELS
    && source.estimatedRgbaBytes <= ORIGINAL_SIZE_GUARDRAIL_RGBA_BYTES;

  if (!isOversize(source.width, source.height)) {
    return {
      allowOriginal: true,
      message: "원본 해상도가 V1의 16MP 제한 이내입니다.",
    };
  }

  if (allowOriginal) {
    return {
      allowOriginal: true,
      message:
        `원본 해상도는 ${source.megapixels.toFixed(1)}MP입니다. 현재 기기에서는 원본 크기를 유지할 수도 있고, 더 빠르고 안정적인 처리를 위해 16.0MP V1 기준으로 축소할 수도 있습니다.`,
    };
  }

  return {
    allowOriginal: false,
    message:
      `원본 해상도는 ${source.megapixels.toFixed(1)}MP이며 현재 메모리 가드레일을 초과합니다. 계속하려면 축소 처리가 필요합니다.`,
  };
}

export function createObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function revokeObjectUrl(url: string | undefined): void {
  if (url) {
    URL.revokeObjectURL(url);
  }
}

export function revokeRenderResult(result: RenderResult | undefined): void {
  if (result) {
    revokeObjectUrl(result.objectUrl);
  }
}

export function revokeProcessedImageSet(result: ProcessedImageSet | undefined): void {
  if (!result) {
    return;
  }

  revokeRenderResult(result.preview);
  revokeRenderResult(result.export);
}

export function chooseOutputSizing(
  width: number,
  height: number,
  preferOriginalSize: boolean,
): OutputSizing {
  if (preferOriginalSize || !isOversize(width, height)) {
    return {
      strategy: "original",
      width,
      height,
      scale: 1,
    };
  }

  const scale = Math.sqrt(OVERSIZE_PIXEL_THRESHOLD / (width * height));
  const scaledWidth = clampDimension(width * scale);
  const scaledHeight = clampDimension(height * scale);

  return {
    strategy: "downscaled",
    width: scaledWidth,
    height: scaledHeight,
    scale: scaledWidth / width,
  };
}

export function choosePreviewSizing(
  width: number,
  height: number,
  maxEdge = PREVIEW_MAX_EDGE,
): PreviewSizing {
  const longestEdge = Math.max(width, height);

  if (longestEdge <= maxEdge) {
    return {
      width,
      height,
      scale: 1,
    };
  }

  const scale = maxEdge / longestEdge;

  return {
    width: clampDimension(width * scale),
    height: clampDimension(height * scale),
    scale,
  };
}

export async function decodeImageDimensions(file: File): Promise<{ width: number; height: number; objectUrl: string }> {
  const objectUrl = createObjectUrl(file);

  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();
      return { width, height, objectUrl };
    }

    const image = await loadImageElement(objectUrl);
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      objectUrl,
    };
  } catch (error) {
    revokeObjectUrl(objectUrl);
    throw error;
  }
}

export async function inspectImageFile(file: File): Promise<ImageSource> {
  const { width, height, objectUrl } = await decodeImageDimensions(file);
  const mimeType = file.type || "image/png";

  return {
    file,
    name: file.name,
    mimeType,
    width,
    height,
    megapixels: computeMegapixels(width, height),
    estimatedRgbaBytes: estimateRgbaBytes(width, height),
    objectUrl,
  };
}

export async function loadBitmapFromSource(
  source: Pick<ImageSource, "file" | "objectUrl">,
): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(source.file);
  }

  return loadImageElement(source.objectUrl);
}

function loadImageElement(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 디코드하지 못했습니다."));
    image.src = objectUrl;
  });
}
