import { Path, Script } from "scripting"
import {
  compressImage,
  compressImageToSize,
  convertImage,
  imagesToPDF,
  removeImageMetadata,
  resizeImage,
} from "./src/image-tools"
import {
  deletePDFPages,
  exportPDFPagesToImages,
  estimatedDeletePageCount,
  estimatedExtractPageCount,
  extractPDFPages,
  mergePDFs,
  parsePageRange,
  reorderPDFPages,
} from "./src/pdf-tools"
import { runSerialImageBatch } from "./src/batch-utils"
import { inspectFiles } from "./src/file-types"
import { loadPreferences, savePreferences } from "./src/preferences"
import { formatByteSize, outputDirectory } from "./src/output-utils"
import { removeStagedInputs, stageInputFiles } from "./src/input-utils"

type TestResult = { name: string; success: boolean; detail: string }

async function resultFor(name: string, test: () => Promise<string>): Promise<TestResult> {
  try {
    return { name, success: true, detail: await test() }
  } catch (error) {
    return { name, success: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function statSize(path: string): Promise<number> {
  return FileManager.stat(path).then(stat => stat.size)
}

async function pageFingerprints(path: string): Promise<string[]> {
  const document = PDFDocument.fromFilePath(path)
  if (!document) throw new Error("无法打开 PDF 以检查页面顺序。")
  const fingerprints: string[] = []
  for (let index = 0; index < document.pageCount; index += 1) {
    const page = document.pageAt(index)
    const bytes = page ? (await page.data)?.toUint8Array() : null
    if (!bytes) throw new Error(`无法读取第 ${index + 1} 页数据。`)
    let checksum = 0
    const stride = Math.max(1, Math.floor(bytes.length / 1024))
    for (let offset = 0; offset < bytes.length; offset += stride) checksum = (checksum * 31 + bytes[offset]) >>> 0
    fingerprints.push(`${bytes.length}:${checksum}`)
  }
  return fingerprints
}

async function run() {
  const sampleDirectory = Path.join(FileManager.temporaryDirectory, "FileKitPhase2Samples")
  if (await FileManager.exists(sampleDirectory)) await FileManager.remove(sampleDirectory)
  await FileManager.createDirectory(sampleDirectory, true)

  const symbol = UIImage.fromSFSymbol("photo.on.rectangle.angled")
  const secondSymbol = UIImage.fromSFSymbol("doc.richtext")
  const thirdSymbol = UIImage.fromSFSymbol("star.fill")
  if (!symbol || !secondSymbol || !thirdSymbol) throw new Error("无法创建测试图片。")
  const firstImage = symbol.renderedIn({ width: 1600, height: 1200 })
  const secondImage = secondSymbol.renderedIn({ width: 1200, height: 1600 })
  const thirdImage = thirdSymbol.renderedIn({ width: 900, height: 900 })
  if (!firstImage || !secondImage || !thirdImage) throw new Error("无法渲染测试图片。")

  const pngPath = Path.join(sampleDirectory, "sample.png")
  const secondPNGPath = Path.join(sampleDirectory, "sample-2.png")
  const thirdPNGPath = Path.join(sampleDirectory, "sample-3.png")
  const pngData = firstImage.toPNGData()
  const secondPNGData = secondImage.toPNGData()
  const thirdPNGData = thirdImage.toPNGData()
  if (!pngData || !secondPNGData || !thirdPNGData) throw new Error("无法编码测试 PNG。")
  await FileManager.writeAsData(pngPath, pngData)
  await FileManager.writeAsData(secondPNGPath, secondPNGData)
  await FileManager.writeAsData(thirdPNGPath, thirdPNGData)

  let jpegPath = ""
  let imagePDF = ""
  let twoImagePDF = ""
  let twoPagePDF = ""
  let threePagePDF = ""
  let fivePagePDF = ""
  const results: TestResult[] = []

  results.push(await resultFor("PNG → JPEG", async () => {
    jpegPath = await convertImage(pngPath, "jpeg", 0.88)
    const image = UIImage.fromFile(jpegPath)
    if (!image || !jpegPath.endsWith(".jpg")) throw new Error("JPEG 输出无法解码。")
    return `${Path.basename(jpegPath)}, ${await statSize(jpegPath)} B`
  }))

  results.push(await resultFor("JPEG 压缩", async () => {
    if (!jpegPath) throw new Error("前置 JPEG 测试未通过。")
    const output = await compressImage(jpegPath, "small")
    const before = await statSize(jpegPath)
    const after = output.size
    if (after >= before) throw new Error(`输出未缩小：${before} → ${after}`)
    return `${before} → ${after} B`
  }))

  results.push(await resultFor("JPEG 压缩到指定大小", async () => {
    if (!jpegPath) throw new Error("前置 JPEG 测试未通过。")
    const minimumData = UIImage.fromFile(jpegPath)?.toJPEGData(0.05)
    const minimumBytes = minimumData?.toUint8Array()?.length
    if (!minimumBytes) throw new Error("无法估算最低质量大小。")
    const target = Math.max(1024, minimumBytes + 512)
    const output = await compressImageToSize(jpegPath, target, { mode: "qualityOnly" })
    if (output.size > target) throw new Error(`${output.size} > ${target}`)
    if (output.sourceWidth !== output.outputWidth || output.sourceHeight !== output.outputHeight) {
      throw new Error("qualityOnly 不应改变分辨率。")
    }
    return `${output.size} / ${target} B, quality=${output.quality.toFixed(3)}, ${output.outputWidth}x${output.outputHeight}`
  }))

  results.push(await resultFor("2 MB 指定大小压缩", async () => {
    if (!jpegPath) throw new Error("前置 JPEG 测试未通过。")
    const target = 2 * 1024 * 1024
    const output = await compressImageToSize(jpegPath, target, { mode: "qualityOnly" })
    if (output.size > target) throw new Error(`2 MB 输出超限：${output.size}`)
    return `${formatByteSize(output.size)} / 2 MB`
  }))

  results.push(await resultFor("自动压缩会在需要时降低分辨率", async () => {
    if (!jpegPath) throw new Error("前置 JPEG 测试未通过。")
    const qualityOnlyMinimum = UIImage.fromFile(jpegPath)?.toJPEGData(0.05)?.toUint8Array()?.length
    if (!qualityOnlyMinimum || qualityOnlyMinimum < 2048) throw new Error("测试图不适合验证自动缩放。")
    const target = Math.max(1024, Math.floor(qualityOnlyMinimum * 0.75))
    const output = await compressImageToSize(jpegPath, target, {
      mode: "auto",
      maxScaleRounds: 8,
      minimumLongEdge: 160,
    })
    if (output.size > target) throw new Error(`${output.size} > ${target}`)
    if (output.scaleRounds < 1 || output.outputWidth >= output.sourceWidth) {
      throw new Error("自动模式未降低分辨率。")
    }
    return `${output.sourceWidth}x${output.sourceHeight} → ${output.outputWidth}x${output.outputHeight}, ${output.size}/${target} B`
  }))

  results.push(await resultFor("图片缩放", async () => {
    const output = await resizeImage(pngPath, { width: 800, height: 800, keepAspectRatio: true, outputFormat: "png" })
    const image = UIImage.fromFile(output)
    if (!image || image.width !== 800 || image.height !== 600) {
      throw new Error(`尺寸不符：${image ? `${image.width}x${image.height}` : "无法解码"}`)
    }
    return `${image.width}x${image.height}`
  }))

  results.push(await resultFor("删除 EXIF / metadata", async () => {
    const taggedPath = Path.join(sampleDirectory, "tagged.jpg")
    await ImageIO.writeImage({
      image: firstImage,
      to: taggedPath,
      format: "jpeg",
      quality: 0.9,
      metadata: { exif: { UserComment: "FileKit test" }, tiff: { Software: "FileKit" } },
    })
    const before = await ImageIO.readMetadata(taggedPath)
    if (!before.exif && !before.tiff) throw new Error("测试 metadata 未写入。")
    const output = await removeImageMetadata(taggedPath)
    const after = await ImageIO.readMetadata(output)
    const exifComment = after.exif ? Reflect.get(after.exif, "UserComment") : undefined
    const tiffSoftware = after.tiff ? Reflect.get(after.tiff, "Software") : undefined
    if (exifComment === "FileKit test" || tiffSoftware === "FileKit") {
      throw new Error(`自定义 metadata 仍存在：${JSON.stringify(after)}`)
    }
    return `自定义 EXIF/TIFF 已移除；编码器结构字段：${JSON.stringify(after)}`
  }))

  results.push(await resultFor("图片 → PDF", async () => {
    imagePDF = await imagesToPDF([pngPath])
    const document = PDFDocument.fromFilePath(imagePDF)
    if (!document || document.pageCount !== 1) throw new Error("单页 PDF 验证失败。")
    twoImagePDF = await imagesToPDF([pngPath, secondPNGPath])
    const multiDocument = PDFDocument.fromFilePath(twoImagePDF)
    if (!multiDocument || multiDocument.pageCount !== 2) throw new Error("多图 PDF 验证失败。")
    threePagePDF = await imagesToPDF([pngPath, secondPNGPath, thirdPNGPath])
    const orderedDocument = PDFDocument.fromFilePath(threePagePDF)
    if (!orderedDocument || orderedDocument.pageCount !== 3) throw new Error("三页 PDF 验证失败。")
    fivePagePDF = await imagesToPDF([pngPath, secondPNGPath, thirdPNGPath, pngPath, secondPNGPath])
    const fivePageDocument = PDFDocument.fromFilePath(fivePagePDF)
    if (!fivePageDocument || fivePageDocument.pageCount !== 5) throw new Error("五页 PDF 验证失败。")
    return `${Path.basename(imagePDF)} 1 page；${Path.basename(twoImagePDF)} 2 pages；${Path.basename(threePagePDF)} 3 pages；${Path.basename(fivePagePDF)} 5 pages`
  }))

  results.push(await resultFor("多图自定义顺序生成 PDF", async () => {
    const original = await pageFingerprints(threePagePDF)
    const output = await imagesToPDF([thirdPNGPath, pngPath, secondPNGPath])
    const reordered = await pageFingerprints(output)
    if (reordered.join("|") !== [original[2], original[0], original[1]].join("|")) {
      throw new Error("图片 PDF 未按传入顺序生成页面。")
    }
    return "3,1,2 图片顺序已映射为 PDF 页序"
  }))

  results.push(await resultFor("两个 PDF 合并", async () => {
    const secondPDF = await imagesToPDF([secondPNGPath])
    twoPagePDF = await mergePDFs([imagePDF, secondPDF])
    const document = PDFDocument.fromFilePath(twoPagePDF)
    if (!document || document.pageCount !== 2) throw new Error(`合并页数错误：${document?.pageCount ?? 0}`)
    return `${Path.basename(twoPagePDF)}, 2 pages`
  }))

  results.push(await resultFor("PDF 提取页面", async () => {
    const expectedExtracted = estimatedExtractPageCount(twoPagePDF, "2")
    const output = await extractPDFPages(twoPagePDF, "2")
    const document = PDFDocument.fromFilePath(output)
    if (!document || document.pageCount !== expectedExtracted || expectedExtracted !== 1) throw new Error("提取页数错误。")
    return `${Path.basename(output)}, 1 page`
  }))

  results.push(await resultFor("PDF 删除页面", async () => {
    const expectedRemaining = estimatedDeletePageCount(twoPagePDF, "1")
    const output = await deletePDFPages(twoPagePDF, "1")
    const document = PDFDocument.fromFilePath(output)
    if (!document || document.pageCount !== expectedRemaining || expectedRemaining !== 1) throw new Error("删除后页数错误。")
    return `${Path.basename(output)}, 1 page`
  }))

  results.push(await resultFor("PDF 页面重排与完整顺序校验", async () => {
    if (!fivePagePDF) throw new Error("前置五页 PDF 测试未通过。")
    const original = await pageFingerprints(fivePagePDF)
    const output = await reorderPDFPages(fivePagePDF, "1,3,2,5,4")
    const reordered = await pageFingerprints(output)
    if (reordered.join("|") !== [original[0], original[2], original[1], original[4], original[3]].join("|")) {
      throw new Error(`重排页序不符：${reordered.join("|")}`)
    }
    for (const input of ["1,1,2,3,4", "1,2,3,4"]) {
      let rejected = false
      try { await reorderPDFPages(fivePagePDF, input) } catch { rejected = true }
      if (!rejected) throw new Error(`未拒绝非法完整重排：${input}`)
    }
    return "1,3,2,5,4 页序正确；重复和遗漏页均被拒绝"
  }))

  results.push(await resultFor("保序页码解析", async () => {
    const ordered = parsePageRange("3,1-2", 3, { preserveOrder: true })
    const defaultOrder = parsePageRange("3,1-2", 3)
    if (ordered.indexes.join(",") !== "2,0,1" || defaultOrder.indexes.join(",") !== "0,1,2") {
      throw new Error("保序或默认升序行为不符。")
    }
    return "重排保留输入顺序，既有提取默认升序未改变"
  }))

  results.push(await resultFor("最近图片参数恢复", async () => {
    const original = loadPreferences()
    try {
      savePreferences({ targetSize: "2 MB", targetSizeUnit: "MB", targetCompressionMode: "auto", autoCompressionAllowsResize: true, lastBatchImageOperation: "compress-target", resizeLongEdge: "1600" })
      const restored = loadPreferences()
      if (restored.targetSize !== "2 MB" || restored.targetSizeUnit !== "MB" || restored.targetCompressionMode !== "auto" || !restored.autoCompressionAllowsResize || restored.lastBatchImageOperation !== "compress-target" || restored.resizeLongEdge !== "1600") {
        throw new Error("最近参数未完整恢复。")
      }
      return "目标大小、单位、模式、自动降分辨率与批量设置均可恢复"
    } finally {
      savePreferences(original)
    }
  }))

  results.push(await resultFor("10 张图片串行转换 JPEG", async () => {
    const batchPaths: string[] = []
    for (let index = 0; index < 10; index += 1) {
      const path = Path.join(sampleDirectory, `batch-${index + 1}.png`)
      await FileManager.copyFile(pngPath, path)
      batchPaths.push(path)
    }
    const inputs = await inspectFiles(batchPaths)
    const progress: number[] = []
    const batch = await runSerialImageBatch(inputs, image => convertImage(image.path, "jpeg"), completed => progress.push(completed), error => error instanceof Error ? error.message : String(error))
    if (batch.successes.length !== 10 || batch.failures.length || progress.join(",") !== "1,2,3,4,5,6,7,8,9,10") {
      throw new Error("批量 JPEG 转换未完整串行完成。")
    }
    return "10/10 JPEG 输出，进度按 1–10 串行推进"
  }))

  results.push(await resultFor("批量单项失败仍保留成功输出", async () => {
    const invalidPath = Path.join(sampleDirectory, "damaged.jpg")
    await FileManager.writeAsString(invalidPath, "not an image")
    const inputs = await inspectFiles([pngPath, invalidPath, secondPNGPath])
    const batch = await runSerialImageBatch(inputs, image => convertImage(image.path, "jpeg"), () => {}, error => error instanceof Error ? error.message : String(error))
    if (batch.successes.length !== 2 || batch.failures.length !== 1 || batch.failures[0].name !== "damaged.jpg") {
      throw new Error(`批量失败处理不符：${JSON.stringify(batch)}`)
    }
    for (const path of batch.successes) if (!(await FileManager.exists(path))) throw new Error("成功输出未保留。")
    return "2 个成功输出保留；损坏图片被单独记录"
  }))

  results.push(await resultFor("输出可重新暂存继续处理", async () => {
    if (!jpegPath || !twoPagePDF) throw new Error("前置输出未生成。")
    const staged = await stageInputFiles([jpegPath, twoPagePDF])
    try {
      const inputs = await inspectFiles(staged.paths)
      if (inputs.map(input => input.kind).join(",") !== "image,pdf") throw new Error("重新载入后的文件类型不正确。")
      const imageOutput = await compressImage(inputs[0].path, "small")
      const pdfOutput = await extractPDFPages(inputs[1].path, "1")
      if (!(await FileManager.exists(imageOutput.path)) || !(await FileManager.exists(pdfOutput))) throw new Error("继续处理未生成新的输出。")
      return "JPEG 可再次压缩，合并 PDF 可重新提取页面"
    } finally {
      await removeStagedInputs(staged.directory)
    }
  }))
  results.push(await resultFor("页面范围校验", async () => {
    const valid = parsePageRange("1-2, 4, 6-7", 7)
    if (valid.indexes.join(",") !== "0,1,3,5,6") throw new Error("合法范围解析错误。")
    const invalidInputs = ["1-3,3", "0", "8", "3-1", "1,,2", "a"]
    for (const input of invalidInputs) {
      let rejected = false
      try { parsePageRange(input, 7) } catch { rejected = true }
      if (!rejected) throw new Error(`未拒绝非法输入：${input}`)
    }
    return "合法范围通过；重复/越界/倒序/空项/非法字符均被拒绝"
  }))

  results.push(await resultFor("Share Sheet 输入暂存：中文名与重名", async () => {
    const firstDirectory = Path.join(sampleDirectory, "provider-a")
    const secondDirectory = Path.join(sampleDirectory, "provider-b")
    await FileManager.createDirectory(firstDirectory, true)
    await FileManager.createDirectory(secondDirectory, true)
    const first = Path.join(firstDirectory, "测试 文件.pdf")
    const second = Path.join(secondDirectory, "测试 文件.pdf")
    await FileManager.copyFile(twoPagePDF, first)
    await FileManager.copyFile(twoPagePDF, second)
    const staged = await stageInputFiles([first, second])
    try {
      const names = staged.paths.map(path => Path.basename(path))
      if (new Set(names).size !== 2 || !names[0].includes("测试 文件")) {
        throw new Error(`暂存文件名处理错误：${names.join(", ")}`)
      }
      for (const path of staged.paths) {
        if (!(await FileManager.exists(path))) throw new Error(`暂存文件不存在：${path}`)
      }
      return names.join("；")
    } finally {
      await removeStagedInputs(staged.directory)
    }
  }))

  results.push(await resultFor("最终输出位于持久 Documents 目录", async () => {
    const directory = await outputDirectory()
    if (!directory.startsWith(FileManager.documentsDirectory)) {
      throw new Error(`输出目录不是 Documents 子目录：${directory}`)
    }
    if (directory.startsWith(FileManager.temporaryDirectory)) {
      throw new Error("输出目录仍位于 temporaryDirectory。")
    }
    return directory
  }))

  results.push(await resultFor("PDF 页面 → 图片（预期能力缺口）", async () => {
    let message = ""
    try { await exportPDFPagesToImages() } catch (error) { message = error instanceof Error ? error.message : String(error) }
    if (!message.includes("未提供页面光栅化")) throw new Error("未返回明确能力缺口提示。")
    return message
  }))

  console.log(JSON.stringify(results, null, 2))
  const failures = results.filter(result => !result.success)
  console.log(`SUMMARY ${results.length - failures.length}/${results.length} checks passed`)
  if (failures.length) throw new Error(`${failures.length} 项测试失败。`)
  Script.exit()
}

run()
