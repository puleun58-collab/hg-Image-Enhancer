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

export type OutputMode = "original" | "2x" | "4x";

export interface CapabilityReport {
  bucket: BrowserBucket;
  supported: boolean;
  hasCanvas2D: boolean;
  hasWorker: boolean;
  hasCreateImageBitmap: boolean;
  hasOffscreenCanvas: boolean;
  hasWebGL2: boolean;
  hasWebGPU: boolean;
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
  strategy: "original" | "original-clamped" | "2x" | "2x-clamped" | "4x" | "4x-clamped";
  width: number;
  height: number;
  previewScale: number;
  debugPreviewPng: Blob;
}

export interface ProcessRequest {
  source: ImageSource;
  strength: number;
  outputMode: OutputMode;
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
  message: string;
}
