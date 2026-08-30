export type TargetSizeUnit = "KB" | "MB"
export type BatchImageOperation =
  | "convert-jpeg"
  | "convert-png"
  | "compress-preset"
  | "compress-target"
  | "resize-long-edge"
  | "remove-metadata"

export type FileKitPreferences = {
  jpegQuality: number
  targetSize: string
  targetSizeUnit: TargetSizeUnit
  targetCompressionMode: "qualityOnly" | "auto"
  autoCompressionAllowsResize: boolean
  keepAspectRatio: boolean
  lastBatchImageOperation: BatchImageOperation
  resizeLongEdge: string
}

const STORAGE_KEY = "filekit.preferences.v2.5"
const DEFAULT_PREFERENCES: FileKitPreferences = {
  jpegQuality: 0.88,
  targetSize: "500 KB",
  targetSizeUnit: "KB",
  targetCompressionMode: "qualityOnly",
  autoCompressionAllowsResize: false,
  keepAspectRatio: true,
  lastBatchImageOperation: "convert-jpeg",
  resizeLongEdge: "1920",
}

function qualityOrDefault(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.05 && value <= 1
    ? value
    : DEFAULT_PREFERENCES.jpegQuality
}

export function loadPreferences(): FileKitPreferences {
  const stored = Storage.get<unknown>(STORAGE_KEY)
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return { ...DEFAULT_PREFERENCES }
  }
  const targetSize = Reflect.get(stored, "targetSize")
  const keepAspectRatio = Reflect.get(stored, "keepAspectRatio")
  const targetSizeUnit = Reflect.get(stored, "targetSizeUnit")
  const targetCompressionMode = Reflect.get(stored, "targetCompressionMode")
  const autoCompressionAllowsResize = Reflect.get(stored, "autoCompressionAllowsResize")
  const lastBatchImageOperation = Reflect.get(stored, "lastBatchImageOperation")
  const resizeLongEdge = Reflect.get(stored, "resizeLongEdge")
  return {
    jpegQuality: qualityOrDefault(Reflect.get(stored, "jpegQuality")),
    targetSize: typeof targetSize === "string" && targetSize.trim() ? targetSize : DEFAULT_PREFERENCES.targetSize,
    targetSizeUnit: targetSizeUnit === "MB" ? "MB" : "KB",
    targetCompressionMode: targetCompressionMode === "auto" ? "auto" : "qualityOnly",
    autoCompressionAllowsResize: typeof autoCompressionAllowsResize === "boolean"
      ? autoCompressionAllowsResize
      : targetCompressionMode === "auto",
    keepAspectRatio: typeof keepAspectRatio === "boolean"
      ? keepAspectRatio
      : DEFAULT_PREFERENCES.keepAspectRatio,
    lastBatchImageOperation: isBatchImageOperation(lastBatchImageOperation)
      ? lastBatchImageOperation
      : DEFAULT_PREFERENCES.lastBatchImageOperation,
    resizeLongEdge: typeof resizeLongEdge === "string" && resizeLongEdge.trim()
      ? resizeLongEdge
      : DEFAULT_PREFERENCES.resizeLongEdge,
  }
}

function isBatchImageOperation(value: unknown): value is BatchImageOperation {
  return value === "convert-jpeg" || value === "convert-png" || value === "compress-preset"
    || value === "compress-target" || value === "resize-long-edge" || value === "remove-metadata"
}

export function savePreferences(update: Partial<FileKitPreferences>): void {
  const preferences = { ...loadPreferences(), ...update }
  Storage.set(STORAGE_KEY, preferences)
}
