export type BrowserBucket =
  | "desktop-chromium"
  | "desktop-firefox"
  | "mobile-safari"
  | "mobile-chromium"
  | "unsupported";

export type AppPhase =
  | "idle"
  | "awaiting-oversize-decision"
  | "processing"
  | "ready"
  | "exporting"
  | "compatibility-blocked"
  | "error";

export interface CapabilityReport {
  bucket: BrowserBucket;
  supported: boolean;
  hasCanvas2D: boolean;
  hasWorker: boolean;
  hasCreateImageBitmap: boolean;
  hasOffscreenCanvas: boolean;
  hasWebGL2: boolean;
  reason?: string;
}

export interface ImageSource {
  file: File;
  name: string;
  mimeType: string;
  width: number;
  height: number;
  megapixels: number;
  estimatedRgbaBytes: number;
  objectUrl: string;
}

export interface RenderResult {
  width: number;
  height: number;
  blob: Blob;
  objectUrl: string;
}

export interface ProcessedImageSet {
  preview: RenderResult;
  export: RenderResult;
  strategy: "original" | "downscaled";
  width: number;
  height: number;
  previewScale: number;
  debugPreviewPng: Blob;
}

export interface ProcessRequest {
  source: ImageSource;
  strength: number;
  preferOriginalSize: boolean;
  outputMimeType: "image/png" | "image/jpeg";
  jpegQuality: number;
}

export interface ProcessResponse extends ProcessedImageSet {
  timingMs: number;
  usedWorker: boolean;
}

export interface ProcessError {
  message: string;
}

export interface OversizeDecision {
  allowOriginal: boolean;
  message: string;
}
