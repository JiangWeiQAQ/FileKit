import {
  Button,
  DisclosureGroup,
  HStack,
  Image,
  List,
  Menu,
  Navigation,
  NavigationStack,
  ProgressView,
  Section,
  Spacer,
  Text,
  Toggle,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import { runSerialImageBatch } from "./batch-utils"
import type { BatchFailure } from "./batch-utils"
import { fileIcon, formatFileSize, inspectFiles, moreOperationsFor, primaryOperationsFor } from "./file-types"
import {
  compressImage,
  compressImageToSize,
  convertImage,
  imagesToPDF,
  removeImageMetadata,
  resizeImage,
} from "./image-tools"
import type { CompressionPreset, CompressionResult, ImageOutputFormat, TargetCompressionMode } from "./image-tools"
import {
  deleteOutputFiles,
  formatByteSize,
  outputDirectory,
  saveOutputFiles,
  shareOutputFiles,
} from "./output-utils"
import { loadPreferences, savePreferences } from "./preferences"
import { removeStagedInputs, stageInputFiles } from "./input-utils"
import {
  deletePDFPages,
  exportPDFPagesToImages,
  estimatedDeletePageCount,
  estimatedExtractPageCount,
  extractPDFPages,
  mergePDFs,
  parsePageRange,
  parsePDFSplitRanges,
  pdfPageCount,
  reorderPDFPages,
  rotatePDFPages,
  splitPDFPages,
} from "./pdf-tools"
import { runPythonBridge } from "./python-bridge"
import type { FileInfo, FileOperation, JSONObject } from "./types"

type FileKitViewProps = {
  initialPaths?: string[]
  source: "main" | "shareSheet"
}

type ProgressState = {
  completed: number
  total: number
  message: string
}

type ResizeFormat = "jpeg" | "png"

const INITIAL_PREFERENCES = loadPreferences()
const MAX_VISIBLE_INPUTS = 5

const BATCH_OPERATION_IDS = new Set([
  "image-convert",
  "image-compress",
  "image-resize",
  "image-remove-metadata",
  "images-to-pdf",
  "pdf-merge",
])

function isBatchOperation(operation: FileOperation): boolean {
  return BATCH_OPERATION_IDS.has(operation.id)
}

function operationFor(kind: FileInfo["kind"], id: string): FileOperation | null {
  return [...primaryOperationsFor(kind), ...moreOperationsFor(kind)].find(operation => operation.id === id) ?? null
}

function fileKindLabel(kind: FileInfo["kind"]): string {
  switch (kind) {
    case "image": return "图片"
    case "pdf": return "PDF"
    case "docx": return "DOCX"
    case "xlsx": return "XLSX"
    case "pptx": return "PPTX"
    case "txt": return "文本"
    case "csv": return "CSV"
    case "json": return "JSON"
    case "html": return "HTML"
    case "markdown": return "Markdown"
    case "unknown": return "其他文件"
  }
}

function scopedOperationTitle(operation: FileOperation, count: number): string {
  return count > 1 && isBatchOperation(operation) ? `${operation.title}（${count} 个）` : operation.title
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split("\n").find(line => line.trim())?.trim() ?? ""
  if (!firstLine || /^(TypeError|ReferenceError|Traceback)/.test(firstLine)) return "处理时发生意外错误，请确认文件完整且格式受支持。"
  return firstLine
}

function parsePositiveNumber(input: string, label: string): number {
  const value = Number(input.trim())
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label}必须是大于 0 的数字。`)
  return value
}

function parseTargetBytes(input: string): number {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, "")
  const match = /^(\d+(?:\.\d+)?)(kb|mb)?$/.exec(normalized)
  if (!match) throw new Error("请输入有效大小，例如 500 KB 或 1.5 MB。")
  const value = Number(match[1])
  const unit = match[2] ?? "kb"
  const bytes = value * (unit === "mb" ? 1024 * 1024 : 1024)
  if (!Number.isFinite(bytes) || bytes < 1024) throw new Error("目标大小不能小于 1 KB。")
  return Math.floor(bytes)
}

function compressionResultSummary(result: CompressionResult): string {
  const reduction = Math.round((1 - result.size / result.sourceSize) * 100)
  return `${formatByteSize(result.sourceSize)} → ${formatByteSize(result.size)} · 减少 ${reduction}%`
}

function compressionResolutionSummary(result: CompressionResult): string | null {
  const source = `${result.sourceWidth}×${result.sourceHeight}`
  const output = `${result.outputWidth}×${result.outputHeight}`
  return source === output ? null : `${source} → ${output}`
}

function compressionResultDetails(result: CompressionResult): string {
  const lines = [
    `JPEG quality：${Math.round(result.quality * 100)}%`,
    `文件大小：${formatByteSize(result.sourceSize)} → ${formatByteSize(result.size)}`,
  ]
  const resolution = compressionResolutionSummary(result)
  if (resolution) lines.push(`分辨率：${resolution}`)
  return lines.join("\n")
}

function resultFormatLabel(file: FileInfo): string {
  return file.kind === "image" ? file.format.replace(/^图片 · /, "") : file.format
}

export function FileKitView({ initialPaths = [], source }: FileKitViewProps) {
  const dismiss = Navigation.useDismiss()
  const runningRef = useRef(false)
  const stagedInputDirectoryRef = useRef<string | null>(null)
  const originalImageOrderRef = useRef<string[]>([])
  const [files, setFiles] = useState<FileInfo[]>([])
  const [outputs, setOutputs] = useState<FileInfo[]>([])
  const [compressionResults, setCompressionResults] = useState<CompressionResult[]>([])
  const [busy, setBusy] = useState(false)
  const [advancedExpanded, setAdvancedExpanded] = useState(false)
  const [orderExpanded, setOrderExpanded] = useState(false)
  const [showAllInputs, setShowAllInputs] = useState(false)
  const [keepAspectRatio, setKeepAspectRatio] = useState(INITIAL_PREFERENCES.keepAspectRatio)
  const [resizeFormat, setResizeFormat] = useState<ResizeFormat>("jpeg")
  const [jpegQuality, setJPEGQuality] = useState(INITIAL_PREFERENCES.jpegQuality)
  const [targetSize, setTargetSize] = useState(INITIAL_PREFERENCES.targetSize)
  const [progress, setProgress] = useState<ProgressState>({ completed: 0, total: 0, message: "" })
  const [status, setStatus] = useState(
    source === "shareSheet" ? "正在读取分享的文件…" : "请选择要处理的文件",
  )

  const loadPaths = async (paths: string[]): Promise<boolean> => {
    if (runningRef.current) return false
    const uniquePaths = [...new Set(paths)]
    if (!uniquePaths.length) {
      setFiles([])
      setStatus("未选择文件")
      return false
    }
    runningRef.current = true
    setBusy(true)
    setStatus(`正在准备 ${uniquePaths.length} 个文件…`)
    let stagedDirectory: string | null = null
    try {
      const staged = await stageInputFiles(uniquePaths)
      stagedDirectory = staged.directory
      const inspected = await inspectFiles(staged.paths)
      await removeStagedInputs(stagedInputDirectoryRef.current)
      stagedInputDirectoryRef.current = staged.directory
      stagedDirectory = null
      setFiles(inspected)
      originalImageOrderRef.current = inspected.filter(file => file.kind === "image").map(file => file.path)
      setOutputs([])
      setCompressionResults([])
      setStatus(`已载入 ${inspected.length} 个文件`)
      return true
    } catch (error) {
      setStatus("读取文件失败")
      await Dialog.alert({ title: "无法读取文件", message: errorMessage(error) })
      return false
    } finally {
      await removeStagedInputs(stagedDirectory)
      DocumentPicker.stopAcessingSecurityScopedResources()
      runningRef.current = false
      setBusy(false)
    }
  }

  useEffect(() => {
    if (initialPaths.length) void loadPaths(initialPaths)
  }, [])

  const pickFiles = async () => {
    if (runningRef.current) return
    try {
      const paths = await DocumentPicker.pickFiles({
        types: ["public.data", "public.content", "public.image"],
        allowsMultipleSelection: true,
        shouldShowFileExtensions: true,
      })
      if (!paths.length) {
        setStatus(files.length ? `已保留 ${files.length} 个文件` : "未选择文件")
        return
      }
      await loadPaths(paths)
    } catch (error) {
      DocumentPicker.stopAcessingSecurityScopedResources()
      setStatus("选择文件失败")
      await Dialog.alert({ title: "无法选择文件", message: errorMessage(error) })
    }
  }

  const pickPhotos = async () => {
    if (runningRef.current) return
    const paths: string[] = []
    try {
      const results = await Photos.pick({ filter: PHPickerFilter.images(), limit: 50 })
      for (const result of results) {
        const path = await result.imagePath()
        if (path) paths.push(path)
      }
      if (!paths.length) {
        setStatus(files.length ? `已保留 ${files.length} 个文件` : "未选择照片")
        return
      }
      await loadPaths(paths)
    } catch (error) {
      setStatus("选择照片失败")
      await Dialog.alert({ title: "无法选择照片", message: errorMessage(error) })
    } finally {
      for (const path of paths) {
        if (await FileManager.exists(path)) await FileManager.remove(path)
      }
    }
  }
  const handlePickFiles = () => {
    void pickFiles()
  }

  const handlePickPhotos = () => {
    void pickPhotos()
  }

  const finishOutputs = async (paths: string[], inputCount: number, detail?: string) => {
    const inspected = await inspectFiles(paths)
    setOutputs(inspected)
    setStatus(`处理完成：输入 ${inputCount} 个，输出 ${paths.length} 个`)
    const fileSummary = inspected.length <= 3
      ? inspected.map(file => `${file.name}（${formatByteSize(file.size)}）`).join("\n")
      : `${inspected.length} 个输出，共 ${formatByteSize(inspected.reduce((sum, file) => sum + file.size, 0))}`
    await Dialog.alert({
      title: "处理完成",
      message: `输入 ${inputCount} 个，输出 ${paths.length} 个\n\n${fileSummary}${detail ? `\n\n${detail}` : ""}`,
      buttonLabel: "好",
    })
  }

  const runTask = async (
    title: string,
    inputCount: number,
    task: (update: (completed: number, message: string) => void) => Promise<string[] | { paths: string[]; detail?: string }>,
  ) => {
    if (runningRef.current) return
    runningRef.current = true
    setBusy(true)
    setCompressionResults([])
    setProgress({ completed: 0, total: inputCount, message: title })
    setStatus(`${title}：0 / ${inputCount}`)
    const update = (completed: number, message: string) => {
      setProgress({ completed, total: inputCount, message })
      setStatus(`${title}：${completed} / ${inputCount}`)
    }
    try {
      const result = await task(update)
      const paths = Array.isArray(result) ? result : result.paths
      const detail = Array.isArray(result) ? undefined : result.detail
      await finishOutputs(paths, inputCount, detail)
    } catch (error) {
      const message = errorMessage(error)
      setStatus(`${title}失败`)
      await Dialog.alert({ title: `${title}失败`, message })
    } finally {
      runningRef.current = false
      setBusy(false)
    }
  }

  const selectedImages = () => files.filter(file => file.kind === "image")
  const selectedPDFs = () => files.filter(file => file.kind === "pdf")

  const batchDetail = (total: number, failures: BatchFailure[]) => {
    const successCount = total - failures.length
    const summary = `${total} 个文件：${successCount} 个成功，${failures.length} 个失败`
    return failures.length ? `${summary}\n\n失败详情：\n${failures.map(failure => `${failure.name}：${failure.message}`).join("\n")}` : summary
  }

  const allFailedMessage = (failures: BatchFailure[]) => `没有图片处理成功：${failures.map(failure => `${failure.name}（${failure.message}）`).join("；")}`

  const reorderImages = (transform: (images: FileInfo[]) => FileInfo[]) => {
    setFiles(current => {
      const reordered = transform(current.filter(file => file.kind === "image"))
      let imageIndex = 0
      return current.map(file => file.kind === "image" ? reordered[imageIndex++] : file)
    })
  }

  const moveImage = (path: string, target: "up" | "down" | "top" | "bottom") => {
    reorderImages(images => {
      const index = images.findIndex(image => image.path === path)
      if (index < 0) return images
      const next = [...images]
      const [item] = next.splice(index, 1)
      const destination = target === "up" ? Math.max(0, index - 1)
        : target === "down" ? Math.min(next.length, index + 1)
          : target === "top" ? 0 : next.length
      next.splice(destination, 0, item)
      return next
    })
  }

  const sortImages = (direction: "ascending" | "descending" | "reverse" | "original") => {
    reorderImages(images => {
      if (direction === "reverse") return [...images].reverse()
      if (direction === "original") {
        const position = new Map(originalImageOrderRef.current.map((path, index) => [path, index]))
        return [...images].sort((left, right) => (position.get(left.path) ?? 0) - (position.get(right.path) ?? 0))
      }
      return [...images].sort((left, right) => direction === "ascending"
        ? left.name.localeCompare(right.name, "zh-Hans-CN")
        : right.name.localeCompare(left.name, "zh-Hans-CN"))
    })
  }

  const dataObject = (data: unknown): JSONObject => (
    typeof data === "object" && data !== null && !Array.isArray(data) ? data as JSONObject : {}
  )

  const previewBridgeText = async (data: unknown, title: string) => {
    const text = dataObject(data).text
    if (typeof text !== "string") return
    const limit = 12_000
    await Dialog.alert({ title, message: text.length > limit ? `${text.slice(0, limit)}\n\n（预览仅显示前 ${limit} 个字符；完整内容已保存为 TXT。）` : text })
  }

  const runPythonTask = async (title: string, file: FileInfo, action: string, options: JSONObject = {}, previewText = false) => {
    await runTask(title, 1, async update => {
      const result = await runPythonBridge(action, [file.path], { ...options, outputDirectory: await outputDirectory() })
      if (!result.success) throw new Error(result.message)
      update(1, result.message)
      if (previewText) await previewBridgeText(result.data, `${title}预览`)
      return { paths: result.files, detail: result.message }
    })
  }

  const runBridgeInfo = async (title: string, file: FileInfo, action: string) => {
    const result = await runPythonBridge(action, [file.path], { outputDirectory: await outputDirectory() })
    if (!result.success) throw new Error(result.message)
    await Dialog.alert({ title, message: `${result.message}\n\n${JSON.stringify(result.data, null, 2)}` })
  }

  const runTextReplace = async (file: FileInfo, prefix: "docx" | "pptx") => {
    const find = await Dialog.prompt({ title: "查找文字", placeholder: "输入要查找的文字" })
    if (find == null) return
    const checked = await runPythonBridge(`${prefix}-count-matches`, [file.path], { find, outputDirectory: await outputDirectory() })
    if (!checked.success) throw new Error(checked.message)
    const count = dataObject(checked.data).matchCount
    if (typeof count !== "number" || count === 0) {
      await Dialog.alert({ title: "查找结果", message: "未找到匹配文字。" })
      return
    }
    const replace = await Dialog.prompt({ title: "替换为", message: `找到 ${count} 处匹配。原文件不会被修改。`, placeholder: "输入替换文字" })
    if (replace == null) return
    if (!await Dialog.confirm(`将替换 ${count} 处文字并生成新文件。原文件不会被修改，是否继续？`)) return
    await runPythonTask("查找并替换文字", file, `${prefix}-replace-text`, { find, replace })
  }

  const runXlsxExport = async (file: FileInfo) => {
    const info = await runPythonBridge("xlsx-info", [file.path], { outputDirectory: await outputDirectory() })
    if (!info.success) throw new Error(info.message)
    const sheets = dataObject(info.data).sheets
    if (!Array.isArray(sheets) || !sheets.length) throw new Error("工作簿中没有可导出的 Sheet。")
    const choices = sheets.map(sheet => ({ label: typeof dataObject(sheet).name === "string" ? dataObject(sheet).name as string : "未命名 Sheet" }))
    choices.push({ label: "导出全部 Sheet" })
    const choice = await Dialog.actionSheet({ title: "选择要导出的 Sheet", actions: choices })
    if (choice == null) return
    const allSheets = choice === sheets.length
    const selected = allSheets ? "" : dataObject(sheets[choice]).name
    if (!allSheets && typeof selected !== "string") throw new Error("Sheet 名称无效。")
    await runPythonTask("导出 CSV", file, "xlsx-export-csv", { allSheets, sheetName: selected })
  }

  const chooseImageFormat = async (inputCount: number): Promise<ImageOutputFormat | null> => {
    const choice = await Dialog.actionSheet({
      title: "输出格式",
      message: `将处理 ${inputCount} 张图片。WebP 会先检查当前官方 API 支持情况。`,
      actions: [{ label: "JPEG" }, { label: "PNG" }, { label: "WebP" }],
    })
    return choice === 0 ? "jpeg" : choice === 1 ? "png" : choice === 2 ? "webp" : null
  }

  const runImageConvert = async (requestedFormat?: Exclude<ImageOutputFormat, "webp">) => {
    const images = selectedImages()
    const format = requestedFormat ?? await chooseImageFormat(images.length)
    if (!format) return
    savePreferences({ lastBatchImageOperation: format === "jpeg" ? "convert-jpeg" : "convert-png" })
    await runTask(`转换为 ${format.toUpperCase()}`, images.length, async update => {
      const result = await runSerialImageBatch(images, image => convertImage(image.path, format, jpegQuality), update, errorMessage)
      if (!result.successes.length) throw new Error(allFailedMessage(result.failures))
      return { paths: result.successes, detail: batchDetail(images.length, result.failures) }
    })
  }

  const chooseTargetSize = async (): Promise<{ input: string; mode: TargetCompressionMode } | null> => {
    const preferredMode: TargetCompressionMode = loadPreferences().targetCompressionMode
    const choice = await Dialog.actionSheet({
      title: "压缩到指定大小",
      message: "选择常用目标后仍可修改。自动模式会在必要时降低分辨率。",
      actions: [{ label: "500 KB" }, { label: "1 MB" }, { label: "2 MB" }, { label: "5 MB" }, { label: "自定义" }],
    })
    if (choice == null) return null
    const preset = ["500 KB", "1 MB", "2 MB", "5 MB"][choice]
    const input = await Dialog.prompt({
      title: preferredMode === "auto" ? "自动压缩到指定大小" : "仅调整质量压缩到指定大小",
      message: "可修改目标大小。原图不会被修改。",
      defaultValue: preset ?? targetSize,
      placeholder: "500 KB",
    })
    return input == null ? null : { input, mode: preferredMode }
  }

  const runTargetCompression = async (images: FileInfo[]) => {
    const selection = await chooseTargetSize()
    if (!selection) return
    const maximumBytes = parseTargetBytes(selection.input)
    const unit = selection.input.toUpperCase().includes("MB") ? "MB" : "KB"
    setTargetSize(selection.input)
    savePreferences({
      targetSize: selection.input,
      targetSizeUnit: unit,
      targetCompressionMode: selection.mode,
      autoCompressionAllowsResize: selection.mode === "auto",
      lastBatchImageOperation: "compress-target",
    })
    await runTask("压缩到指定大小", images.length, async update => {
      const result = await runSerialImageBatch(images, image => compressImageToSize(image.path, maximumBytes, { mode: selection.mode }), update, errorMessage)
      if (!result.successes.length) throw new Error(allFailedMessage(result.failures))
      setCompressionResults(result.successes)
      return {
        paths: result.successes.map(item => item.path),
        detail: `${batchDetail(images.length, result.failures)}\n\n${result.successes.map((item, index) => `${index + 1}. ${formatByteSize(item.sourceSize)} → ${formatByteSize(item.size)}，减少 ${Math.round((1 - item.size / item.sourceSize) * 100)}% · ${item.sourceWidth}×${item.sourceHeight} → ${item.outputWidth}×${item.outputHeight} · quality ${Math.round(item.quality * 100)}%`).join("\n")}`,
      }
    })
  }

  const runImageCompress = async () => {
    const images = selectedImages()
    const choice = await Dialog.actionSheet({
      title: "图片压缩",
      message: `将处理 ${images.length} 张图片，输出统一为 JPEG；透明通道和动画帧不会保留。`,
      actions: [
        { label: "高质量" },
        { label: "平衡" },
        { label: "小文件" },
        { label: "压缩到指定大小" },
        { label: "切换指定大小模式" },
      ],
    })
    if (choice == null) return
    if (choice === 3) {
      await runTargetCompression(images)
      return
    }
    if (choice === 4) {
      const mode = loadPreferences().targetCompressionMode === "auto" ? "qualityOnly" : "auto"
      savePreferences({ targetCompressionMode: mode, autoCompressionAllowsResize: mode === "auto" })
      await Dialog.alert({ title: "已更新压缩模式", message: mode === "auto" ? "指定大小压缩将自动降低分辨率。" : "指定大小压缩只调整 JPEG 质量。" })
      return
    }
    setCompressionResults([])
    const preset: CompressionPreset = choice === 0 ? "high" : choice === 1 ? "balanced" : "small"
    savePreferences({ lastBatchImageOperation: "compress-preset" })
    await runTask("压缩图片", images.length, async update => {
      const result = await runSerialImageBatch(images, image => compressImage(image.path, preset), update, errorMessage)
      if (!result.successes.length) throw new Error(allFailedMessage(result.failures))
      setCompressionResults(result.successes)
      return {
        paths: result.successes.map(item => item.path),
        detail: `${batchDetail(images.length, result.failures)}\n\n${result.successes.map((item, index) => `${index + 1}. ${formatByteSize(item.sourceSize)} → ${formatByteSize(item.size)} · ${item.sourceWidth}×${item.sourceHeight} → ${item.outputWidth}×${item.outputHeight} · quality ${Math.round(item.quality * 100)}%`).join("\n")}`,
      }
    })
  }

  const runImageResize = async () => {
    const images = selectedImages()
    const mode = await Dialog.actionSheet({
      title: "调整图片尺寸",
      message: `将处理 ${images.length} 张图片。`,
      actions: [{ label: "限制最长边" }, { label: "指定宽高边界" }],
    })
    if (mode == null) return
    try {
      if (mode === 0) {
        const input = await Dialog.prompt({ title: "最长边", message: "所有图片最长边将不超过此像素值，并保持宽高比。", defaultValue: loadPreferences().resizeLongEdge, keyboardType: "numberPad" })
        if (input == null) return
        const edge = parsePositiveNumber(input, "最长边")
        savePreferences({ resizeLongEdge: input, lastBatchImageOperation: "resize-long-edge" })
        await runTask("按最长边缩放", images.length, async update => {
          const result = await runSerialImageBatch(images, image => resizeImage(image.path, { width: edge, height: edge, keepAspectRatio: true, outputFormat: resizeFormat, quality: jpegQuality }), update, errorMessage)
          if (!result.successes.length) throw new Error(allFailedMessage(result.failures))
          return { paths: result.successes, detail: batchDetail(images.length, result.failures) }
        })
        return
      }
      const widthInput = await Dialog.prompt({
        title: "目标宽度",
        message: keepAspectRatio ? "会在宽度和高度边界内保持宽高比。" : "会使用准确宽度和高度。",
        defaultValue: "1920",
        keyboardType: "numberPad",
      })
      if (widthInput == null) return
      const heightInput = await Dialog.prompt({ title: "目标高度", defaultValue: "1920", keyboardType: "numberPad" })
      if (heightInput == null) return
      const width = parsePositiveNumber(widthInput, "宽度")
      const height = parsePositiveNumber(heightInput, "高度")
      await runTask("调整图片尺寸", images.length, async update => {
        const result = await runSerialImageBatch(images, image => resizeImage(image.path, { width, height, keepAspectRatio, outputFormat: resizeFormat, quality: jpegQuality }), update, errorMessage)
        if (!result.successes.length) throw new Error(allFailedMessage(result.failures))
        return { paths: result.successes, detail: batchDetail(images.length, result.failures) }
      })
    } catch (error) {
      await Dialog.alert({ title: "尺寸无效", message: errorMessage(error) })
    }
  }

  const runRemoveMetadata = async () => {
    const images = selectedImages()
    if (!await Dialog.confirm(`将清理 ${images.length} 张图片的 metadata，并生成新文件。是否继续？`)) return
    savePreferences({ lastBatchImageOperation: "remove-metadata" })
    await runTask("删除图片 metadata", images.length, async update => {
      const result = await runSerialImageBatch(images, image => removeImageMetadata(image.path), update, errorMessage)
      if (!result.successes.length) throw new Error(allFailedMessage(result.failures))
      return { paths: result.successes, detail: batchDetail(images.length, result.failures) }
    })
  }

  const runImagesToPDF = async () => {
    const images = selectedImages()
    if (!await Dialog.confirm(`将按当前顺序生成 ${images.length} 页 PDF。原图片不会被修改，是否继续？`)) return
    await runTask("图片生成 PDF", images.length, async update => {
      const path = await imagesToPDF(images.map(image => image.path))
      update(images.length, "PDF 已生成")
      return [path]
    })
  }

  const runPDFMerge = async () => {
    const pdfs = selectedPDFs()
    if (!await Dialog.confirm(`将合并 ${pdfs.length} 个 PDF，原文件不会被覆盖。是否继续？`)) return
    await runTask("合并 PDF", pdfs.length, async update => {
      const path = await mergePDFs(pdfs.map(pdf => pdf.path))
      update(pdfs.length, "PDF 已合并")
      return [path]
    })
  }

  const requestPageRange = async (title: string): Promise<string | null> => Dialog.prompt({
    title,
    message: "使用 1-3, 8, 10-15 格式。重复、越界和非法输入会被拒绝。",
    placeholder: "1-3, 8",
    keyboardType: "numbersAndPunctuation",
  })

  const runPDFExtract = async (file: FileInfo) => {
    const input = await requestPageRange("提取页面")
    if (input == null) return
    try {
      const estimated = estimatedExtractPageCount(file.path, input)
      const confirmed = await Dialog.confirm(`提取后预计生成 ${estimated} 页 PDF。是否继续？`)
      if (!confirmed) return
    } catch (error) {
      await Dialog.alert({ title: "页码范围无效", message: errorMessage(error) })
      return
    }
    await runTask("提取 PDF 页面", 1, async update => {
      const path = await extractPDFPages(file.path, input)
      update(1, "页面已提取")
      return [path]
    })
  }

  const runPDFDelete = async (file: FileInfo) => {
    const input = await requestPageRange("删除页面")
    if (input == null) return
    try {
      const estimated = estimatedDeletePageCount(file.path, input)
      const confirmed = await Dialog.confirm(`删除后预计保留 ${estimated} 页。原 PDF 不会被覆盖，是否继续？`)
      if (!confirmed) return
    } catch (error) {
      await Dialog.alert({ title: "页码范围无效", message: errorMessage(error) })
      return
    }
    await runTask("删除 PDF 页面", 1, async update => {
      const path = await deletePDFPages(file.path, input)
      update(1, "页面已删除")
      return [path]
    })
  }

  const runPDFSplit = async (file: FileInfo) => {
    const pageCount = pdfPageCount(file.path)
    const choice = await Dialog.actionSheet({
      title: "拆分 PDF",
      message: `此 PDF 共 ${pageCount} 页。原文件不会被修改，输出会保存为多个新 PDF。`,
      actions: [{ label: "每页一个 PDF" }, { label: "按范围拆分" }],
    })
    if (choice == null) return

    const mode: "each" | "ranges" = choice === 0 ? "each" : "ranges"
    let input: string | undefined
    if (mode === "ranges") {
      const rangeInput = await Dialog.prompt({
        title: "拆分范围",
        message: "每个范围生成一个 PDF，必须覆盖全部页面且不能重复。例如：1-3、4-6、7-10。",
        placeholder: "1-3、4-6、7-10",
        keyboardType: "numbersAndPunctuation",
      })
      if (rangeInput == null) return
      input = rangeInput
      try {
        const ranges = parsePDFSplitRanges(input, pageCount)
        const groups = ranges.map(range => `${range.label}（${range.indexes.length} 页）`).join("、")
        if (!await Dialog.confirm(`原页数：${pageCount}\n输出分组：${groups}\n\n原 PDF 不会被修改，是否继续？`)) return
      } catch (error) {
        await Dialog.alert({ title: "拆分范围无效", message: errorMessage(error) })
        return
      }
    } else if (!await Dialog.confirm(`将 ${pageCount} 页拆分为 ${pageCount} 个 PDF。\n\n原 PDF 不会被修改，是否继续？`)) {
      return
    }

    await runTask("拆分 PDF", 1, async update => {
      const paths = await splitPDFPages(file.path, mode, input)
      update(1, `已生成 ${paths.length} 个 PDF`)
      return { paths, detail: `共生成 ${paths.length} 个 PDF。` }
    })
  }

  const runPDFReorder = async (file: FileInfo) => {
    const pageCount = pdfPageCount(file.path)
    const input = await Dialog.prompt({
      title: "重排 PDF 页面",
      message: `此 PDF 共 ${pageCount} 页。请输入包含每一页且不重复的顺序，例如 1,3,2,5,4 或 3,1-2,4-6。`,
      placeholder: Array.from({ length: pageCount }, (_, index) => String(index + 1)).join(","),
      keyboardType: "numbersAndPunctuation",
    })
    if (input == null) return
    try {
      const order = parsePageRange(input, pageCount, { preserveOrder: true })
      if (order.indexes.length !== pageCount) throw new Error(`重排必须包含全部 ${pageCount} 页；当前只包含 ${order.indexes.length} 页。需要部分页面请使用“提取指定页面”。`)
      const label = order.indexes.map(index => index + 1).join(",")
      if (!await Dialog.confirm(`原页数：${pageCount}\n新页面顺序：${label}\n\n原 PDF 不会被修改，是否继续？`)) return
      await runTask("重排 PDF 页面", 1, async update => {
        const path = await reorderPDFPages(file.path, input)
        update(1, "页面已重排")
        return [path]
      })
    } catch (error) {
      await Dialog.alert({ title: "页面顺序无效", message: errorMessage(error) })
    }
  }

  const runOperation = async (file: FileInfo, operation: FileOperation) => {
    if (busy) return
    switch (operation.id) {
      case "image-convert": await runImageConvert(); return
      case "image-compress": await runImageCompress(); return
      case "image-resize": await runImageResize(); return
      case "image-remove-metadata": await runRemoveMetadata(); return
      case "images-to-pdf": await runImagesToPDF(); return
      case "pdf-merge": await runPDFMerge(); return
      case "pdf-extract": await runPDFExtract(file); return
      case "pdf-delete": await runPDFDelete(file); return
      case "pdf-reorder": await runPDFReorder(file); return
      case "pdf-split": await runPDFSplit(file); return
      case "pdf-rotate": await rotatePDFPages(); return
      case "pdf-to-images": await exportPDFPagesToImages(); return
      case "docx-info": await runBridgeInfo("DOCX 信息", file, "docx-info"); return
      case "docx-text": await runPythonTask("提取 DOCX 文字", file, "docx-extract-text", {}, true); return
      case "docx-images": await runPythonTask("提取 DOCX 图片", file, "docx-extract-images"); return
      case "docx-replace": await runTextReplace(file, "docx"); return
      case "xlsx-info": await runBridgeInfo("工作簿信息", file, "xlsx-info"); return
      case "xlsx-to-csv": await runXlsxExport(file); return
      case "xlsx-clean":
        if (await Dialog.confirm("将删除完全空白的行和列，并生成新的 XLSX。原文件不会被修改，是否继续？")) await runPythonTask("清理空白行和列", file, "xlsx-clean-blank")
        return
      case "pptx-info": await runBridgeInfo("PPTX 信息", file, "pptx-info"); return
      case "pptx-text": await runPythonTask("提取 PPTX 文字", file, "pptx-extract-text", {}, true); return
      case "pptx-images": await runPythonTask("提取 PPTX 图片", file, "pptx-extract-images"); return
      case "pptx-replace": await runTextReplace(file, "pptx"); return
      case "json-format": await runPythonTask("格式化 JSON", file, "json-format", {}, true); return
      case "json-minify": await runPythonTask("压缩 JSON", file, "json-minify", {}, true); return
      case "json-validate": await runBridgeInfo("JSON 校验", file, "json-validate"); return
      case "json-to-csv": await runPythonTask("JSON 转 CSV", file, "json-to-csv"); return
      case "csv-to-json": await runPythonTask("CSV 转 JSON", file, "csv-to-json", {}, true); return
      case "html-text": await runPythonTask("提取 HTML 纯文本", file, "html-to-text", {}, true); return
      case "text-base64-encode": await runPythonTask("Base64 编码", file, "text-base64-encode", {}, true); return
      case "text-base64-decode": await runPythonTask("Base64 解码", file, "text-base64-decode", {}, true); return
      case "text-url-encode": await runPythonTask("URL 编码", file, "text-url-encode", {}, true); return
      case "text-url-decode": await runPythonTask("URL 解码", file, "text-url-decode", {}, true); return
      case "text-deduplicate-lines": await runPythonTask("文本行去重", file, "text-deduplicate-lines", {}, true); return
      default:
        await Dialog.alert({
          title: operation.title,
          message: "此操作不属于第二阶段图片/PDF 范围，当前未实现。",
        })
    }
  }

  const safelyRunOperation = async (file: FileInfo, operation: FileOperation) => {
    try {
      await runOperation(file, operation)
    } catch (error) {
      await Dialog.alert({ title: operation.title, message: errorMessage(error) })
    }
  }

  const shareFiles = async (paths: string[], label: string) => {
    if (runningRef.current) return
    runningRef.current = true
    setBusy(true)
    try {
      const completed = await shareOutputFiles(paths)
      setStatus(completed ? `已分享${label}` : "已关闭分享表单")
    } catch (error) {
      await Dialog.alert({ title: "无法分享文件", message: errorMessage(error) })
    } finally {
      runningRef.current = false
      setBusy(false)
    }
  }

  const saveFiles = async (paths: string[]) => {
    if (runningRef.current) return
    runningRef.current = true
    setBusy(true)
    try {
      const saved = await saveOutputFiles(paths)
      setStatus(saved.length ? `已保存 ${saved.length} 个结果到“文件”` : "已取消保存")
    } catch (error) {
      await Dialog.alert({ title: "无法保存到文件", message: errorMessage(error) })
    } finally {
      runningRef.current = false
      setBusy(false)
    }
  }

  const deleteResults = async (paths: string[]) => {
    if (runningRef.current) return
    const confirmed = await Dialog.confirm(`确定删除 ${paths.length} 个 FileKit 结果吗？此操作不可撤销。`)
    if (!confirmed) return
    runningRef.current = true
    setBusy(true)
    try {
      await deleteOutputFiles(paths)
      const deleted = new Set(paths)
      setOutputs(current => current.filter(file => !deleted.has(file.path)))
      setCompressionResults([])
      setStatus(`已删除 ${paths.length} 个结果`)
    } catch (error) {
      await Dialog.alert({ title: "无法删除结果", message: errorMessage(error) })
    } finally {
      runningRef.current = false
      setBusy(false)
    }
  }

  const continueProcessing = async (paths: string[]) => {
    if (!paths.length || runningRef.current) return
    const loaded = await loadPaths(paths)
    if (loaded) setStatus(`已载入 ${paths.length} 个已有结果，可继续处理`)
  }

  const closeView = async () => {
    await removeStagedInputs(stagedInputDirectoryRef.current)
    stagedInputDirectoryRef.current = null
    DocumentPicker.stopAcessingSecurityScopedResources()
    dismiss(outputs.map(file => file.path))
  }

  const changeResizeFormat = async () => {
    const choice = await Dialog.actionSheet({
      title: "缩放输出格式",
      actions: [{ label: "JPEG" }, { label: "PNG" }],
    })
    if (choice === 0) setResizeFormat("jpeg")
    if (choice === 1) setResizeFormat("png")
  }

  const changeJPEGQuality = async () => {
    const input = await Dialog.prompt({
      title: "JPEG 默认质量",
      message: "输入 5–100。普通压缩预设不受此项影响。",
      defaultValue: String(Math.round(jpegQuality * 100)),
      keyboardType: "numberPad",
    })
    if (input == null) return
    const value = Number(input)
    if (!Number.isFinite(value) || value < 5 || value > 100) {
      await Dialog.alert({ title: "质量无效", message: "请输入 5–100 之间的数字。" })
      return
    }
    setJPEGQuality(value / 100)
    savePreferences({ jpegQuality: value / 100 })
  }

  const images = selectedImages()
  const pdfs = selectedPDFs()
  const firstImage = images[0] ?? null
  const firstPDF = pdfs[0] ?? null
  const actionFile = files.length === 1 ? files[0] ?? null : null
  const imageCompressOperation = operationFor("image", "image-compress")
  const imageConvertOperation = operationFor("image", "image-convert")
  const imageResizeOperation = operationFor("image", "image-resize")
  const imageToPDFOperation = operationFor("image", "images-to-pdf")
  const imageMetadataOperation = operationFor("image", "image-remove-metadata")
  const pdfMergeOperation = operationFor("pdf", "pdf-merge")
  const pdfExtractOperation = operationFor("pdf", "pdf-extract")
  const pdfDeleteOperation = operationFor("pdf", "pdf-delete")
  const pdfReorderOperation = operationFor("pdf", "pdf-reorder")
  const pdfSplitOperation = operationFor("pdf", "pdf-split")
  const singleFileActionOperations = actionFile
    ? primaryOperationsFor(actionFile.kind).filter(operation => !isBatchOperation(operation))
    : []
  const singleFileMoreOperations = actionFile
    ? [
      ...singleFileActionOperations.slice(3),
      ...moreOperationsFor(actionFile.kind).filter(operation => !isBatchOperation(operation)),
    ]
    : []
  const singleFileVisibleOperations = singleFileActionOperations.slice(0, 3)
  const promotedOperationIds = new Set([
    ...singleFileVisibleOperations,
    ...singleFileMoreOperations,
  ].map(operation => operation.id))
  const totalInputSize = files.reduce((total, file) => total + file.size, 0)
  const hiddenInputCount = Math.max(0, files.length - MAX_VISIBLE_INPUTS)
  const inputKinds = [...new Set(files.map(file => fileKindLabel(file.kind)))].join("、")
  const statusIsFailure = status.includes("失败")
  const resultActionsDisabled = busy && !status.startsWith("处理完成")
  const hasImagePrimary = images.length > 0
  const hasPDFPrimary = pdfs.length > 1
  const hasSingleFileActions = !!actionFile && !hasImagePrimary && !hasPDFPrimary && (
    singleFileActionOperations.length > 0 || singleFileMoreOperations.length > 0
  )
  const canPromoteSingleFileAction = !!actionFile && !hasImagePrimary && !hasPDFPrimary && outputs.length === 0

  const hasActionSection = hasImagePrimary || hasPDFPrimary || hasSingleFileActions

  const inputRow = (file: FileInfo) => {
    const rowPrimaryOperations = primaryOperationsFor(file.kind).filter(operation => (
      !isBatchOperation(operation) && !promotedOperationIds.has(operation.id)
    ))
    const rowMoreOperations = moreOperationsFor(file.kind).filter(operation => (
      !isBatchOperation(operation) && !promotedOperationIds.has(operation.id)
    ))
    return (
      <HStack spacing={8} listRowSeparator="hidden">
        <Image systemName={fileIcon(file.kind)} font={20} foregroundStyle="secondaryLabel" />
        <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font="body" lineLimit={1}>{file.name}</Text>
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {file.format} · {formatFileSize(file.size)}
          </Text>
        </VStack>
        <Menu
          label={<Image systemName="ellipsis.circle" font={16} accessibilityLabel="文件操作" />}
          disabled={busy}
        >
          {rowPrimaryOperations.map(operation => (
            <Button
              title={operation.title}
              systemImage={operation.systemImage}
              action={() => void safelyRunOperation(file, operation)}
            />
          ))}
          {rowMoreOperations.length ? (
            <Menu title="更多" systemImage="ellipsis">
              {rowMoreOperations.map(operation => (
                <Button
                  title={operation.title}
                  systemImage={operation.systemImage}
                  action={() => void safelyRunOperation(file, operation)}
                />
              ))}
            </Menu>
          ) : null}
          <Button
            title="分享原文件"
            systemImage="square.and.arrow.up"
            action={() => void shareFiles([file.path], ` ${file.name}`)}
          />
        </Menu>
      </HStack>
    )
  }

  return (
    <NavigationStack interactiveDismissDisabled>
      {files.length === 0 ? (
        <List
          listStyle="plain"
          navigationTitle="FileKit"
          navigationBarTitleDisplayMode="inline"
          toolbar={{
            topBarLeading: (
              <Button
                title=""
                systemImage="xmark"
                accessibilityLabel="关闭"
                disabled={busy}
                action={() => void closeView()}
              />
            ),
          }}
        >
          <Section
            header={<Text font="headline">添加文件</Text>}
            footer={
              <Text font="footnote" foregroundStyle="secondaryLabel">
                选择照片或文件开始处理；原文件不会被覆盖。
              </Text>
            }
          >
            <HStack spacing={12}>
              <Image
                systemName={statusIsFailure ? "exclamationmark.triangle" : "doc.badge.plus"}
                font={24}
                foregroundStyle="secondaryLabel"
              />
              <VStack alignment="leading" spacing={4}>
                <Text font="headline">{statusIsFailure ? "无法读取文件" : "选择文件开始处理"}</Text>
                <Text font="subheadline" foregroundStyle="secondaryLabel">
                  {statusIsFailure ? "请重新选择照片或文件。" : "支持照片、PDF、Office 和文本文件"}
                </Text>
              </VStack>
            </HStack>
            <Button
              title="选择照片"
              systemImage="photo.on.rectangle"
              disabled={busy}
              action={handlePickPhotos}
            />
            <Button
              title="选择文件"
              systemImage="folder"
              disabled={busy}
              action={handlePickFiles}
            />
            {busy ? <ProgressView title={status} /> : null}
          </Section>
        </List>
      ) : (
        <List
          listStyle="plain"
          listRowSpacing={hasImagePrimary ? 0 : undefined}
          listSectionSpacing={hasImagePrimary ? "compact" : "default"}
          navigationTitle="FileKit"
          navigationBarTitleDisplayMode="inline"
          toolbar={{
            topBarLeading: (
              <Button
                title=""
                systemImage="xmark"
                accessibilityLabel="关闭"
                disabled={busy}
                action={() => void closeView()}
              />
            ),
            topBarTrailing: (
              <Menu title="" systemImage="plus" disabled={busy}>
                <Button title="选择照片" systemImage="photo" action={handlePickPhotos} />
                <Button title="选择文件" systemImage="folder" action={handlePickFiles} />
              </Menu>
            ),
          }}
        >
          <Section header={<Text font="caption" foregroundStyle="secondaryLabel">当前输入（{files.length}）</Text>}>
            {files.length > 1 ? (
              <HStack spacing={10}>
                <Image systemName="doc.on.doc" foregroundStyle="secondaryLabel" />
                <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Text font="headline">{files.length} 个文件</Text>
                  <Text font="subheadline" foregroundStyle="secondaryLabel">
                    {formatByteSize(totalInputSize)} · {inputKinds}
                  </Text>
                </VStack>
              </HStack>
            ) : null}

            {statusIsFailure && !busy ? (
              <HStack spacing={10}>
                <Image systemName="exclamationmark.triangle" foregroundStyle="red" />
                <Text foregroundStyle="secondaryLabel" lineLimit={2}>{status}</Text>
              </HStack>
            ) : null}

            {busy && !status.startsWith("处理完成") ? (
              <VStack alignment="leading" spacing={8}>
                <HStack spacing={10}>
                  <Image systemName="hourglass" foregroundStyle="accentColor" />
                  <Text lineLimit={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>{status}</Text>
                  {progress.total > 0 ? (
                    <Text font="footnote" foregroundStyle="secondaryLabel">{progress.completed} / {progress.total}</Text>
                  ) : null}
                </HStack>
                {progress.total > 0 ? (
                  <ProgressView
                    value={progress.completed}
                    total={progress.total}
                    title={progress.message}
                    progressViewStyle="linear"
                  />
                ) : (
                  <ProgressView title={status} />
                )}
              </VStack>
            ) : null}

            {files.slice(0, MAX_VISIBLE_INPUTS).map(inputRow)}
            {hiddenInputCount > 0 ? (
              <DisclosureGroup
                title={`其余 ${hiddenInputCount} 个文件`}
                isExpanded={showAllInputs}
                onChanged={setShowAllInputs}
              >
                {files.slice(MAX_VISIBLE_INPUTS).map(inputRow)}
              </DisclosureGroup>
            ) : null}

            {images.length > 1 ? (
              <DisclosureGroup
                title={`调整图片顺序（${images.length}）`}
                isExpanded={orderExpanded}
                onChanged={setOrderExpanded}
              >
                <Text font="footnote" foregroundStyle="secondaryLabel">生成 PDF 时会按当前顺序排列图片。</Text>
                <Menu title="批量排序" systemImage="line.3.horizontal.decrease.circle" disabled={busy}>
                  <Button title="按文件名升序" action={() => sortImages("ascending")} />
                  <Button title="按文件名降序" action={() => sortImages("descending")} />
                  <Button title="反转顺序" action={() => sortImages("reverse")} />
                  <Button title="恢复原始选择顺序" action={() => sortImages("original")} />
                </Menu>
                {images.map((image, index) => (
                  <HStack spacing={10}>
                    <Text font="footnote" foregroundStyle="secondaryLabel">{index + 1}</Text>
                    <Text lineLimit={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>{image.name}</Text>
                    <Menu title="调整顺序" systemImage="arrow.up.arrow.down" disabled={busy}>
                      <Button title="上移" systemImage="arrow.up" action={() => moveImage(image.path, "up")} />
                      <Button title="下移" systemImage="arrow.down" action={() => moveImage(image.path, "down")} />
                      <Button title="移到顶部" systemImage="arrow.up.to.line" action={() => moveImage(image.path, "top")} />
                      <Button title="移到底部" systemImage="arrow.down.to.line" action={() => moveImage(image.path, "bottom")} />
                    </Menu>
                  </HStack>
                ))}
              </DisclosureGroup>
            ) : null}
          </Section>

        {hasActionSection ? (
          <Section
            header={<Text font="caption" foregroundStyle="secondaryLabel">{hasImagePrimary ? "图片操作" : "操作"}</Text>}
            listSectionSeparator={hasImagePrimary ? "hidden" : "automatic"}
          >
             {firstImage && imageCompressOperation ? (
                <Button
                  buttonStyle="plain"
                  listRowSeparator="hidden"
                  disabled={busy}
                  action={() => void safelyRunOperation(firstImage, imageCompressOperation)}
               >
                 <HStack spacing={10} listRowSeparator="hidden">
                   <Image systemName={imageCompressOperation.systemImage} font={18} foregroundStyle="accentColor" />
                   <Text font="body" frame={{ maxWidth: "infinity", alignment: "leading" }}>
                     {scopedOperationTitle(imageCompressOperation, images.length)}
                   </Text>
                   <Image systemName="chevron.right" font={13} foregroundStyle="secondaryLabel" />
                 </HStack>
               </Button>
             ) : null}
             {firstImage && imageConvertOperation ? (
                <Button
                  buttonStyle="plain"
                  listRowSeparator="hidden"
                  disabled={busy}
                  action={() => void safelyRunOperation(firstImage, imageConvertOperation)}
               >
                 <HStack spacing={10} listRowSeparator="hidden">
                   <Image systemName={imageConvertOperation.systemImage} font={18} foregroundStyle="accentColor" />
                   <Text font="body" frame={{ maxWidth: "infinity", alignment: "leading" }}>
                     {scopedOperationTitle(imageConvertOperation, images.length)}
                   </Text>
                   <Image systemName="chevron.right" font={13} foregroundStyle="secondaryLabel" />
                 </HStack>
               </Button>
             ) : null}
             {firstImage && imageResizeOperation ? (
                <DisclosureGroup
                  buttonStyle="plain"
                  listRowSeparator="hidden"
                  label={
                   <HStack spacing={10} listRowSeparator="hidden">
                     <Image systemName={imageResizeOperation.systemImage} font={18} foregroundStyle="accentColor" />
                     <Text font="body" frame={{ maxWidth: "infinity", alignment: "leading" }}>
                       {scopedOperationTitle(imageResizeOperation, images.length)}
                     </Text>
                   </HStack>
                 }
                 isExpanded={advancedExpanded}
                 onChanged={setAdvancedExpanded}
               >
                 <Toggle
                   title="缩放时保持宽高比"
                   value={keepAspectRatio}
                   onChanged={value => {
                     setKeepAspectRatio(value)
                     savePreferences({ keepAspectRatio: value })
                   }}
                 />
                 <Button
                   title={`缩放输出格式：${resizeFormat === "jpeg" ? "JPEG" : "PNG"}`}
                   action={() => void changeResizeFormat()}
                 />
                 <Button
                   title={`JPEG 默认质量：${Math.round(jpegQuality * 100)}`}
                   action={() => void changeJPEGQuality()}
                 />
                 <Button
                   title="开始调整尺寸"
                   systemImage={imageResizeOperation.systemImage}
                   disabled={busy}
                   action={() => void safelyRunOperation(firstImage, imageResizeOperation)}
                 />
               </DisclosureGroup>
             ) : null}
             {firstImage && imageToPDFOperation ? (
                <Button
                  buttonStyle="plain"
                  listRowSeparator="hidden"
                  disabled={busy}
                  action={() => void safelyRunOperation(firstImage, imageToPDFOperation)}
               >
                 <HStack spacing={10} listRowSeparator="hidden">
                   <Image systemName={imageToPDFOperation.systemImage} font={18} foregroundStyle="accentColor" />
                   <Text font="body" frame={{ maxWidth: "infinity", alignment: "leading" }}>
                     {scopedOperationTitle(imageToPDFOperation, images.length)}
                   </Text>
                   <Image systemName="chevron.right" font={13} foregroundStyle="secondaryLabel" />
                 </HStack>
               </Button>
             ) : null}
             {firstImage && imageMetadataOperation ? (
                <Menu
                  buttonStyle="plain"
                  listRowSeparator="hidden"
                  label={
                   <HStack spacing={10} listRowSeparator="hidden">
                     <Image systemName="ellipsis.circle" font={18} foregroundStyle="accentColor" />
                     <Text font="body" frame={{ maxWidth: "infinity", alignment: "leading" }}>更多</Text>
                     <Image systemName="chevron.right" font={13} foregroundStyle="secondaryLabel" />
                   </HStack>
                 }
                 disabled={busy}
               >
                 <Button
                   title={imageMetadataOperation.title}
                   systemImage={imageMetadataOperation.systemImage}
                   action={() => void safelyRunOperation(firstImage, imageMetadataOperation)}
                 />
               </Menu>
             ) : null}
            {firstPDF && pdfs.length > 1 && pdfMergeOperation ? (
              <Button
                title={scopedOperationTitle(pdfMergeOperation, pdfs.length)}
                systemImage={pdfMergeOperation.systemImage}
                buttonStyle={!images.length && !outputs.length ? "borderedProminent" : "automatic"}
                disabled={busy}
                action={() => void safelyRunOperation(firstPDF, pdfMergeOperation)}
              />
            ) : null}
            {firstPDF && files.length === 1 && pdfs.length === 1 && pdfExtractOperation ? (
              <HStack spacing={8}>
                <Button
                  title={pdfExtractOperation.title}
                  systemImage={pdfExtractOperation.systemImage}
                  buttonStyle={outputs.length ? "automatic" : "borderedProminent"}
                  disabled={busy}
                  action={() => void safelyRunOperation(firstPDF, pdfExtractOperation)}
                />
                {pdfDeleteOperation ? (
                  <Button
                    title={pdfDeleteOperation.title}
                    systemImage={pdfDeleteOperation.systemImage}
                    disabled={busy}
                    action={() => void safelyRunOperation(firstPDF, pdfDeleteOperation)}
                  />
                ) : null}
              </HStack>
            ) : null}
            {firstPDF && files.length === 1 && pdfs.length === 1 && pdfReorderOperation ? (
              <Button
                title={pdfReorderOperation.title}
                systemImage={pdfReorderOperation.systemImage}
                disabled={busy}
                action={() => void safelyRunOperation(firstPDF, pdfReorderOperation)}
              />
            ) : null}
             {firstPDF && files.length === 1 && pdfs.length === 1 && pdfSplitOperation ? (
               <Button
                 title={pdfSplitOperation.title}
                 systemImage={pdfSplitOperation.systemImage}
                 disabled={busy}
                 action={() => void safelyRunOperation(firstPDF, pdfSplitOperation)}
               />
             ) : null}
            {actionFile && actionFile.kind !== "pdf" && !hasImagePrimary && !hasPDFPrimary ? (
              <>
                {singleFileVisibleOperations.slice(0, 2).length ? (
                  <HStack spacing={8}>
                    {singleFileVisibleOperations.slice(0, 2).map((operation, index) => (
                      <Button
                        title={operation.title}
                        systemImage={operation.systemImage}
                        buttonStyle={index === 0 && canPromoteSingleFileAction ? "borderedProminent" : "automatic"}
                        disabled={busy}
                        action={() => void safelyRunOperation(actionFile, operation)}
                      />
                    ))}
                  </HStack>
                ) : null}
                {singleFileVisibleOperations.slice(2).map(operation => (
                  <Button
                    title={operation.title}
                    systemImage={operation.systemImage}
                    disabled={busy}
                    action={() => void safelyRunOperation(actionFile, operation)}
                  />
                ))}
                {singleFileMoreOperations.length ? (
                  <Menu title="更多操作" systemImage="ellipsis" disabled={busy}>
                    {singleFileMoreOperations.map(operation => (
                      <Button
                        title={operation.title}
                        systemImage={operation.systemImage}
                        action={() => void safelyRunOperation(actionFile, operation)}
                      />
                    ))}
                  </Menu>
                ) : null}
              </>
            ) : null}
          </Section>
        ) : null}

        {outputs.length ? (
          <Section
            title={outputs.length === 1 ? "结果" : `结果（${outputs.length}）`}
            listSectionSeparator="hidden"
            sectionActions={outputs.length > 1 ? (
              <Menu title="批量操作" systemImage="ellipsis.circle" disabled={resultActionsDisabled}>
                <Button
                  title={`全部保存到文件（${outputs.length}）`}
                  systemImage="folder.badge.plus"
                  action={() => void saveFiles(outputs.map(file => file.path))}
                />
                <Button
                  title={`继续处理全部 ${outputs.length} 个输出`}
                  systemImage="arrow.right.circle"
                  action={() => void continueProcessing(outputs.map(file => file.path))}
                />
                <Button
                  title={`删除全部结果（${outputs.length}）`}
                  systemImage="trash"
                  role="destructive"
                  action={() => void deleteResults(outputs.map(file => file.path))}
                />
              </Menu>
            ) : undefined}
          >
            {outputs.map((file, index) => {
              const compressionResult = compressionResults[index]
              const resolutionSummary = compressionResult ? compressionResolutionSummary(compressionResult) : null
              return (
                <VStack alignment="leading" spacing={4} listRowSeparator="hidden">
                  <HStack spacing={10}>
                    <Image systemName="checkmark.circle.fill" font={19} foregroundStyle="green" />
                    <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                      <Text font="body" lineLimit={1}>{file.name}</Text>
                      <Text font="footnote" foregroundStyle="secondaryLabel">
                        {resultFormatLabel(file)} · {formatFileSize(file.size)}
                      </Text>
                    </VStack>
                    <Menu
                      buttonStyle="plain"
                      listRowSeparator="hidden"
                      label={<Image systemName="ellipsis.circle" font={16} accessibilityLabel="结果操作" />}
                      disabled={resultActionsDisabled}
                    >
                      <Button title="分享" systemImage="square.and.arrow.up" action={() => void shareFiles([file.path], ` ${file.name}`)} />
                      <Button title="保存到文件" systemImage="folder.badge.plus" action={() => void saveFiles([file.path])} />
                      <Button title="继续处理" systemImage="arrow.right.circle" action={() => void continueProcessing([file.path])} />
                      {compressionResult ? (
                        <Button
                          title="详细信息"
                          systemImage="info.circle"
                          action={() => void Dialog.alert({ title: "压缩详细信息", message: compressionResultDetails(compressionResult) })}
                        />
                      ) : null}
                      <Button title="删除结果" systemImage="trash" role="destructive" action={() => void deleteResults([file.path])} />
                    </Menu>
                  </HStack>
                  {compressionResult ? (
                    <Text font="caption" foregroundStyle="secondaryLabel">
                      {compressionResultSummary(compressionResult)}
                    </Text>
                  ) : null}
                  {resolutionSummary ? (
                    <Text font="caption" foregroundStyle="secondaryLabel">
                      {resolutionSummary}
                    </Text>
                  ) : null}
                </VStack>
              )
            })}
            {outputs.length === 1 ? (
              <Button
                buttonStyle="borderedProminent"
                controlSize="regular"
                disabled={resultActionsDisabled}
                action={() => void shareFiles([outputs[0].path], ` ${outputs[0].name}`)}
              >
                <HStack spacing={8}>
                  <Image systemName="square.and.arrow.up" font={17} />
                  <Text font="body">分享</Text>
                </HStack>
              </Button>
            ) : (
              <Button
                buttonStyle="borderedProminent"
                controlSize="regular"
                disabled={resultActionsDisabled}
                action={() => void shareFiles(outputs.map(file => file.path), `全部 ${outputs.length} 个输出`)}
              >
                <HStack spacing={8}>
                  <Image systemName="square.and.arrow.up.on.square" font={17} />
                  <Text font="body">{`分享全部 ${outputs.length} 个输出`}</Text>
                </HStack>
              </Button>
            )}
          </Section>
        ) : null}
          </List>
        )}
    </NavigationStack>
  )
}

type FileKitPreviewProps = {
  initialPaths?: string[]
  source?: FileKitViewProps["source"]
}

export default function FileKitPreview({ initialPaths = [], source = "main" }: FileKitPreviewProps) {
  return <FileKitView initialPaths={initialPaths} source={source} />
}
