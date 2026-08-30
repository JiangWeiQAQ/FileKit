import { Path } from "scripting"

const OUTPUT_ROOT_NAME = "FileKit"
const OUTPUT_DIRECTORY_NAME = "Outputs"
const WORKING_DIRECTORY_NAME = "FileKitWork"
const STALE_WORK_MAX_AGE_MS = 24 * 60 * 60 * 1000

export async function outputDirectory(): Promise<string> {
  const directory = Path.join(FileManager.documentsDirectory, OUTPUT_ROOT_NAME, OUTPUT_DIRECTORY_NAME)
  if (!(await FileManager.exists(directory))) {
    await FileManager.createDirectory(directory, true)
  }
  return directory
}

function cleanStem(stem: string): string {
  const cleaned = stem.trim().replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "")
  return cleaned || "file"
}

export function fileStem(path: string): string {
  const extension = Path.extname(path)
  return cleanStem(Path.basename(path, extension))
}

async function uniqueFinalPath(stem: string, extension: string): Promise<string> {
  const directory = await outputDirectory()
  const safeStem = cleanStem(stem)
  const safeExtension = extension.replace(/^\./, "").toLowerCase()
  let candidate = Path.join(directory, `${safeStem}.${safeExtension}`)
  let suffix = 2
  while (await FileManager.exists(candidate)) {
    candidate = Path.join(directory, `${safeStem}_${suffix}.${safeExtension}`)
    suffix += 1
  }
  return candidate
}

async function cleanStaleWorkingFiles(directory: string): Promise<void> {
  const now = Date.now()
  for (const path of await FileManager.readDirectory(directory)) {
    const stat = await FileManager.stat(path)
    if (now - stat.modificationDate > STALE_WORK_MAX_AGE_MS) await FileManager.remove(path)
  }
}

export async function workingOutputPath(stem: string, extension: string): Promise<string> {
  const directory = Path.join(FileManager.temporaryDirectory, WORKING_DIRECTORY_NAME)
  await FileManager.createDirectory(directory, true)
  await cleanStaleWorkingFiles(directory)
  const safeStem = cleanStem(stem)
  const safeExtension = extension.replace(/^\./, "").toLowerCase()
  return Path.join(directory, `${safeStem}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}.${safeExtension}`)
}

export async function finalizeOutputFile(workingPath: string, stem: string, extension: string): Promise<string> {
  const workingDirectory = Path.join(FileManager.temporaryDirectory, WORKING_DIRECTORY_NAME)
  const prefix = workingDirectory.endsWith("/") ? workingDirectory : `${workingDirectory}/`
  if (!workingPath.startsWith(prefix) || workingPath.slice(prefix.length).includes("/")) {
    throw new Error("拒绝提交非 FileKit 工作文件。")
  }
  if (!(await FileManager.isFile(workingPath))) throw new Error("FileKit 工作文件不存在。")
  const finalPath = await uniqueFinalPath(stem, extension)
  await FileManager.rename(workingPath, finalPath)
  return finalPath
}

export function dataByteLength(data: Data): number {
  const bytes = data.toUint8Array()
  if (!bytes) throw new Error("无法读取生成文件的二进制数据。")
  return bytes.length
}

export async function shareOutputFiles(paths: string[]): Promise<boolean> {
  if (!paths.length) throw new Error("当前没有可分享的输出文件。")
  for (const path of paths) {
    if (!(await FileManager.exists(path))) throw new Error(`输出文件不存在：${path}`)
  }
  return ShareSheet.present(paths)
}

export async function saveOutputFiles(paths: string[]): Promise<string[]> {
  if (!paths.length) throw new Error("当前没有可保存的输出文件。")
  const files: { data: Data; name: string }[] = []
  const maximumInMemoryExportSize = 250 * 1024 * 1024
  let totalSize = 0
  for (const path of paths) {
    if (!(await FileManager.exists(path))) throw new Error(`输出文件不存在：${path}`)
    const stat = await FileManager.stat(path)
    totalSize += stat.size
    if (stat.size > maximumInMemoryExportSize || totalSize > maximumInMemoryExportSize) {
      throw new Error(`所选结果超过 250 MB，系统“保存到文件”接口需要整批载入内存。为避免崩溃，请直接在“文件 → 在我的 iPhone → Scripting → FileKit → Outputs”中移动结果。`)
    }
  }
  for (const path of paths) {
    files.push({ data: await FileManager.readAsData(path), name: Path.basename(path) })
  }
  return DocumentPicker.exportFiles({ files })
}

function isFileKitOutputPath(path: string, directory: string): boolean {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`
  return path.startsWith(prefix) && !path.slice(prefix.length).includes("/")
}

export async function deleteOutputFiles(paths: string[]): Promise<void> {
  const directory = await outputDirectory()
  for (const path of paths) {
    if (!isFileKitOutputPath(path, directory)) {
      throw new Error(`拒绝删除非 FileKit 输出：${Path.basename(path)}`)
    }
  }
  for (const path of paths) {
    if (await FileManager.exists(path)) await FileManager.remove(path)
  }
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 102400 ? 0 : 1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 2)} MB`
}
