import { fileStem, finalizeOutputFile, workingOutputPath } from "./output-utils"
import { insertPDFPage } from "./pdf-compat"

export type ImageOutputFormat = "jpeg" | "png" | "webp"
export type CompressionPreset = "high" | "balanced" | "small"
export type TargetCompressionMode = "qualityOnly" | "auto"

export type ResizeOptions = {
  width: number
  height: number
  keepAspectRatio: boolean
  outputFormat?: Exclude<ImageOutputFormat, "webp">
  quality?: number
}

export type CompressionResult = {
  path: string
  quality: number
  size: number
  sourceSize: number
  sourceWidth: number
  sourceHeight: number
  outputWidth: number
  outputHeight: number
  scaleRounds: number
}

export type TargetCompressionResult = CompressionResult

export type TargetCompressionOptions = {
  mode?: TargetCompressionMode
  scaleFactor?: number
  maxScaleRounds?: number
  minimumLongEdge?: number
}

const PRESET_QUALITY: Record<CompressionPreset, number> = {
  high: 0.88,
  balanced: 0.72,
  small: 0.48,
}

function loadImage(path: string): UIImage {
  const image = UIImage.fromFile(path)
  if (!image) throw new Error("无法解码这张图片。文件可能损坏，或格式不受当前设备支持。")
  return image
}

function validDimension(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 30000) {
    throw new Error(`${label}必须是 1–30000 之间的数字。`)
  }
  return Math.round(value)
}

function validQuality(value: number): number {
  if (!Number.isFinite(value) || value < 0.05 || value > 1) {
    throw new Error("图片质量必须在 0.05–1 之间。")
  }
  return value
}

function extensionFor(format: Exclude<ImageOutputFormat, "webp">): string {
  return format === "jpeg" ? "jpg" : "png"
}

function isPNGPath(path: string): boolean {
  return path.toLowerCase().endsWith(".png")
}

async function hasPNGTransparency(path: string, image: UIImage): Promise<boolean> {
  let metadata: ImageMetadata | null = null
  try {
    metadata = await ImageIO.readMetadata(path)
  } catch {
    // Fall through to pixel inspection when the provider does not expose metadata.
  }
  if (metadata?.hasAlpha !== undefined) return metadata.hasAlpha
  const pixels = image.getPixelData()
  const bytes = pixels?.data.toUint8Array()
  if (!bytes) throw new Error("无法确认 PNG 透明通道；为避免丢失透明度，已停止 JPEG 压缩。")
  for (let index = 3; index < bytes.length; index += 4) {
    if (bytes[index] < 255) return true
  }
  return false
}

async function ensureJPEGCompressionAllowed(sourcePath: string, image: UIImage): Promise<void> {
  if (isPNGPath(sourcePath) && await hasPNGTransparency(sourcePath, image)) {
    throw new Error("PNG 含透明通道，压缩图片不会静默转换为 JPEG；请改用 PNG 缩放或明确选择图片格式转换。")
  }
}

async function writeDecodedImage(
  image: UIImage,
  path: string,
  format: Exclude<ImageOutputFormat, "webp">,
  quality: number,
): Promise<void> {
  await ImageIO.writeImage({ image, to: path, format, quality })
}

export async function convertImage(
  sourcePath: string,
  format: ImageOutputFormat,
  quality = 0.88,
): Promise<string> {
  if (format === "webp") {
    throw new Error("当前 Scripting 官方 ImageIO/UIImage API 不支持 WebP 编码，无法安全生成 WebP 文件。")
  }
  const image = loadImage(sourcePath)
  const stem = `${fileStem(sourcePath)}_converted`
  const extension = extensionFor(format)
  const workingPath = await workingOutputPath(stem, extension)
  await writeDecodedImage(image, workingPath, format, validQuality(quality))
  return finalizeOutputFile(workingPath, stem, extension)
}

export async function resizeImage(sourcePath: string, options: ResizeOptions): Promise<string> {
  const source = loadImage(sourcePath)
  const requestedWidth = validDimension(options.width, "宽度")
  const requestedHeight = validDimension(options.height, "高度")
  let width = requestedWidth
  let height = requestedHeight
  if (options.keepAspectRatio) {
    const ratio = Math.min(requestedWidth / source.width, requestedHeight / source.height)
    width = Math.max(1, Math.round(source.width * ratio))
    height = Math.max(1, Math.round(source.height * ratio))
  }
  const resized = source.renderedIn({ width, height })
  if (!resized) throw new Error("图片缩放失败，可能是目标尺寸过大。")
  const format = options.outputFormat ?? "jpeg"
  const stem = `${fileStem(sourcePath)}_${width}x${height}`
  const extension = extensionFor(format)
  const workingPath = await workingOutputPath(stem, extension)
  await writeDecodedImage(resized, workingPath, format, validQuality(options.quality ?? 0.88))
  return finalizeOutputFile(workingPath, stem, extension)
}

export async function compressImage(
  sourcePath: string,
  preset: CompressionPreset,
): Promise<CompressionResult> {
  const image = loadImage(sourcePath)
  await ensureJPEGCompressionAllowed(sourcePath, image)
  const sourceSize = (await FileManager.stat(sourcePath)).size
  const presetQuality = PRESET_QUALITY[preset]
  let encoded = jpegSize(image, presetQuality)
  let finalQuality = presetQuality
  if (encoded.size >= sourceSize) {
    const fallback = searchJPEGQuality(image, sourceSize - 1, presetQuality)
    if (!fallback) {
      const minimum = jpegSize(image, 0.05)
      throw new Error(`当前设置未能减小文件大小：原文件 ${sourceSize} B，最低 quality 输出仍为 ${minimum.size} B。`)
    }
    encoded = fallback
    finalQuality = fallback.quality
  }
  const stem = `${fileStem(sourcePath)}_compressed`
  const workingPath = await workingOutputPath(stem, "jpg")
  await FileManager.writeAsData(workingPath, encoded.data)
  const outputPath = await finalizeOutputFile(workingPath, stem, "jpg")
  const outputSize = (await FileManager.stat(outputPath)).size
  if (outputSize >= sourceSize) {
    await FileManager.remove(outputPath)
    throw new Error(`当前设置未能减小文件大小：原文件 ${sourceSize} B，输出 ${outputSize} B。`)
  }
  return {
    path: outputPath,
    quality: finalQuality,
    size: outputSize,
    sourceSize,
    sourceWidth: image.width,
    sourceHeight: image.height,
    outputWidth: image.width,
    outputHeight: image.height,
    scaleRounds: 0,
  }
}

type JPEGResult = { data: Data; size: number }
type QualitySearchResult = JPEGResult & { quality: number }

function jpegSize(image: UIImage, quality: number): JPEGResult {
  const data = image.toJPEGData(quality)
  if (!data) throw new Error("JPEG 编码失败。")
  const bytes = data.toUint8Array()
  if (!bytes) throw new Error("无法读取 JPEG 编码结果。")
  return { data, size: bytes.length }
}

function searchJPEGQuality(image: UIImage, maximumBytes: number, maximumQuality = 1): QualitySearchResult | null {
  const minimumQuality = 0.05
  const minimum = jpegSize(image, minimumQuality)
  if (minimum.size > maximumBytes) return null

  const maximum = jpegSize(image, maximumQuality)
  if (maximum.size <= maximumBytes) return { ...maximum, quality: maximumQuality }

  let low = minimumQuality
  let high = maximumQuality
  let best = minimum
  let bestQuality = minimumQuality
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const quality = (low + high) / 2
    const candidate = jpegSize(image, quality)
    if (candidate.size <= maximumBytes) {
      best = candidate
      bestQuality = quality
      low = quality
    } else {
      high = quality
    }
  }
  return { ...best, quality: bestQuality }
}

export async function compressImageToSize(
  sourcePath: string,
  maximumBytes: number,
  options: TargetCompressionOptions = {},
): Promise<TargetCompressionResult> {
  if (!Number.isFinite(maximumBytes) || maximumBytes < 1024) {
    throw new Error("目标大小不能小于 1 KB。")
  }
  const mode = options.mode ?? "qualityOnly"
  const scaleFactor = options.scaleFactor ?? 0.85
  const maxScaleRounds = options.maxScaleRounds ?? 8
  const minimumLongEdge = options.minimumLongEdge ?? 320
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0 || scaleFactor >= 1) throw new Error("自动缩放比例必须在 0–1 之间。")
  if (!Number.isInteger(maxScaleRounds) || maxScaleRounds < 0 || maxScaleRounds > 20) {
    throw new Error("最大缩放轮数必须是 0–20 之间的整数。")
  }
  if (!Number.isInteger(minimumLongEdge) || minimumLongEdge < 64) {
    throw new Error("最低长边分辨率不能小于 64 px。")
  }

  const source = loadImage(sourcePath)
  await ensureJPEGCompressionAllowed(sourcePath, source)
  const sourceStat = await FileManager.stat(sourcePath)
  const effectiveMaximumBytes = Math.min(maximumBytes, sourceStat.size - 1)
  if (effectiveMaximumBytes < 1024) {
    throw new Error(`当前设置未能减小文件大小：原文件仅 ${sourceStat.size} B，无法生成小于原文件的 JPEG。`)
  }
  let candidateImage = source
  let scaleRounds = 0
  let result = searchJPEGQuality(candidateImage, effectiveMaximumBytes)

  if (!result && mode === "qualityOnly") {
    const minimum = jpegSize(source, 0.05)
    throw new Error(
      `仅调整 JPEG quality 无法达到目标：最低质量仍为 ${Math.ceil(minimum.size / 1024)} KB，目标为 ${Math.floor(maximumBytes / 1024)} KB，且输出必须小于原文件。请选择“自动”模式以继续降低分辨率。`,
    )
  }

  while (!result && mode === "auto" && scaleRounds < maxScaleRounds) {
    const currentLongEdge = Math.max(candidateImage.width, candidateImage.height)
    if (currentLongEdge <= minimumLongEdge) break
    const nextLongEdge = Math.max(minimumLongEdge, Math.round(currentLongEdge * scaleFactor))
    const scale = nextLongEdge / currentLongEdge
    const width = Math.max(1, Math.round(candidateImage.width * scale))
    const height = Math.max(1, Math.round(candidateImage.height * scale))
    if (width === candidateImage.width && height === candidateImage.height) break
    const resized = candidateImage.renderedIn({ width, height })
    if (!resized) throw new Error(`自动压缩在第 ${scaleRounds + 1} 轮缩放时失败。`)
    candidateImage = resized
    scaleRounds += 1
    result = searchJPEGQuality(candidateImage, effectiveMaximumBytes)
  }

  if (!result) {
    const minimum = jpegSize(candidateImage, 0.05)
    throw new Error(
      `自动压缩仍无法达到目标：已缩放 ${scaleRounds} 轮至 ${candidateImage.width}×${candidateImage.height}，最低 quality 结果为 ${Math.ceil(minimum.size / 1024)} KB，目标为 ${Math.floor(maximumBytes / 1024)} KB，且输出必须小于原文件。已达到最大缩放轮数或最低分辨率限制。`,
    )
  }

  const stem = `${fileStem(sourcePath)}_under_${Math.floor(maximumBytes / 1024)}KB`
  const workingPath = await workingOutputPath(stem, "jpg")
  await FileManager.writeAsData(workingPath, result.data)
  const outputPath = await finalizeOutputFile(workingPath, stem, "jpg")
  const outputSize = (await FileManager.stat(outputPath)).size
  if (outputSize >= sourceStat.size) {
    await FileManager.remove(outputPath)
    throw new Error(`当前设置未能减小文件大小：原文件 ${sourceStat.size} B，输出 ${outputSize} B。`)
  }
  return {
    path: outputPath,
    quality: result.quality,
    size: outputSize,
    sourceSize: sourceStat.size,
    sourceWidth: source.width,
    sourceHeight: source.height,
    outputWidth: candidateImage.width,
    outputHeight: candidateImage.height,
    scaleRounds,
  }
}

export async function removeImageMetadata(sourcePath: string): Promise<string> {
  const image = loadImage(sourcePath)
  const extension = sourcePath.toLowerCase().split(".").at(-1) ?? ""
  const format: Exclude<ImageOutputFormat, "webp"> = extension === "png" ? "png" : "jpeg"
  const stem = `${fileStem(sourcePath)}_no_metadata`
  const outputExtension = extensionFor(format)
  const workingPath = await workingOutputPath(stem, outputExtension)
  await writeDecodedImage(image, workingPath, format, 0.92)
  return finalizeOutputFile(workingPath, stem, outputExtension)
}

export async function imagesToPDF(imagePaths: string[]): Promise<string> {
  if (!imagePaths.length) throw new Error("请至少选择一张图片。")
  let document: PDFDocument | null = null
  let insertedPages = 0

  for (const imagePath of imagePaths) {
    const image = loadImage(imagePath)
    const page = PDFPage.fromImage(image)
    if (!page) throw new Error(`无法为 ${fileStem(imagePath)} 创建 PDF 页面。`)
    if (!document) {
      const data = await page.data
      if (!data) throw new Error("无法创建初始 PDF 数据。")
      document = PDFDocument.fromData(data)
      if (!document) throw new Error("无法创建 PDF 文档。")
      insertedPages = 1
    } else {
      insertPDFPage(document, page, insertedPages)
      insertedPages += 1
    }
  }

  if (!document) throw new Error("没有可写入 PDF 的图片。")
  const stem = imagePaths.length === 1 ? `${fileStem(imagePaths[0])}_image` : `images_${imagePaths.length}`
  const workingPath = await workingOutputPath(stem, "pdf")
  const success = await document.write(workingPath)
  if (!success) throw new Error("PDF 写入失败。")
  return finalizeOutputFile(workingPath, stem, "pdf")
}
