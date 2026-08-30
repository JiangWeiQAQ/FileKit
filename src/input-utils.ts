import { Path } from "scripting"

const INPUT_ROOT_NAME = "FileKitInputs"
const READ_ATTEMPTS = 6
const COPY_ATTEMPTS = 3
const STALE_INPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type StagedInputs = {
  paths: string[]
  directory: string
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function normalizedInputPath(value: string): string {
  if (!value.startsWith("file://")) return value
  try {
    return decodeURIComponent(new URL(value).pathname)
  } catch {
    return value.replace(/^file:\/\//, "")
  }
}

async function ensureLocallyReadable(path: string): Promise<void> {
  try {
    if (FileManager.isFileStoredIniCloud(path) && !FileManager.isiCloudFileDownloaded(path)) {
      const downloaded = await FileManager.downloadFileFromiCloud(path)
      if (!downloaded) throw new Error("iCloud 文件下载失败。")
    }
  } catch (error) {
    if (error instanceof Error && error.message === "iCloud 文件下载失败。") throw error
    // Non-iCloud file providers may reject the iCloud-specific probes. Readability is verified below.
  }

  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    if (await FileManager.exists(path)) {
      if (await FileManager.isFile(path)) return
      throw new Error(`输入不是普通文件：${Path.basename(path)}`)
    }
    await delay(300 * (attempt + 1))
  }
  throw new Error(`文件尚不可读或云端下载未完成：${Path.basename(path)}`)
}

async function uniquePath(directory: string, name: string): Promise<string> {
  const extension = Path.extname(name)
  const stem = Path.basename(name, extension) || "file"
  let candidate = Path.join(directory, name || "file")
  let suffix = 2
  while (await FileManager.exists(candidate)) {
    candidate = Path.join(directory, `${stem}_${suffix}${extension}`)
    suffix += 1
  }
  return candidate
}

async function copyWithRetry(source: string, destination: string): Promise<void> {
  let lastError = "未知错误"
  for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt += 1) {
    try {
      if (await FileManager.exists(destination)) await FileManager.remove(destination)
      await FileManager.copyFile(source, destination)
      if (!(await FileManager.isFile(destination))) throw new Error("暂存结果不是普通文件。")
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (await FileManager.exists(destination)) await FileManager.remove(destination)
      if (attempt + 1 < COPY_ATTEMPTS) await delay(400 * (attempt + 1))
    }
  }
  throw new Error(lastError)
}

async function cleanStaleInputSessions(root: string): Promise<void> {
  if (!(await FileManager.exists(root))) return
  const now = Date.now()
  const entries = await FileManager.readDirectory(root)
  for (const entry of entries) {
    const path = Path.join(root, entry)
    if (!Path.basename(path).startsWith("session_")) continue
    const stat = await FileManager.stat(path)
    if (await FileManager.isDirectory(path) && now - stat.modificationDate > STALE_INPUT_MAX_AGE_MS) {
      await FileManager.remove(path)
    }
  }
}

export async function stageInputFiles(paths: string[]): Promise<StagedInputs> {
  if (!paths.length) throw new Error("没有可暂存的输入文件。")
  const root = Path.join(FileManager.temporaryDirectory, INPUT_ROOT_NAME)
  await FileManager.createDirectory(root, true)
  await cleanStaleInputSessions(root)
  const directory = Path.join(root, `session_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`)
  await FileManager.createDirectory(directory, true)
  const stagedPaths: string[] = []

  try {
    for (const input of paths) {
      const source = normalizedInputPath(input)
      await ensureLocallyReadable(source)
      const destination = await uniquePath(directory, Path.basename(source))
      await copyWithRetry(source, destination)
      stagedPaths.push(destination)
    }
    return { paths: stagedPaths, directory }
  } catch (error) {
    if (await FileManager.exists(directory)) await FileManager.remove(directory)
    throw error
  }
}

export async function removeStagedInputs(directory: string | null): Promise<void> {
  if (directory && await FileManager.exists(directory)) await FileManager.remove(directory)
}
