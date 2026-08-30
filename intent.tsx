import { Intent, Navigation, Path, Script } from "scripting"
import { FileKitView } from "./src/file-kit-view"
import type { BridgeResponse } from "./src/types"

function failure(message: string): BridgeResponse {
  return { success: false, message, files: [], data: null }
}

async function fallbackImagePaths(): Promise<string[]> {
  if (Intent.imagePathsParameter?.length) return Intent.imagePathsParameter
  const images = Intent.imagesParameter ?? []
  if (!images.length) return []
  const directory = Path.join(FileManager.temporaryDirectory, `FileKitIntentImages_${Date.now()}`)
  await FileManager.createDirectory(directory, true)
  const paths: string[] = []
  for (let index = 0; index < images.length; index += 1) {
    const data = images[index].toJPEGData(1)
    if (!data) throw new Error(`无法读取第 ${index + 1} 张分享图片。`)
    const path = Path.join(directory, `shared_image_${index + 1}.jpg`)
    await FileManager.writeAsData(path, data)
    paths.push(path)
  }
  return paths
}

async function run() {
  let response: BridgeResponse
  let fallbackDirectory: string | null = null
  try {
    const imageFiles = await fallbackImagePaths()
    if (!Intent.imagePathsParameter?.length && imageFiles.length) fallbackDirectory = Path.dirname(imageFiles[0])
    const inputFiles = [...new Set([...(Intent.fileURLsParameter ?? []), ...imageFiles])]
    if (!inputFiles.length) {
      response = failure("没有收到 Share Sheet 文件或图片。")
    } else {
      const presented = await Navigation.present<string[] | undefined>(
        <FileKitView initialPaths={inputFiles} source="shareSheet" />,
      )
      const outputFiles = presented ?? []
      response = {
        success: true,
        message: outputFiles.length
          ? `已生成 ${outputFiles.length} 个持久输出文件。`
          : `已接收 ${inputFiles.length} 个文件，未返回输出文件。`,
        files: outputFiles,
        data: { source: "shareSheet", inputCount: inputFiles.length, outputCount: outputFiles.length },
      }
    }
  } catch (error) {
    response = failure(error instanceof Error ? error.message : String(error))
  } finally {
    if (fallbackDirectory && await FileManager.exists(fallbackDirectory)) await FileManager.remove(fallbackDirectory)
    DocumentPicker.stopAcessingSecurityScopedResources()
  }
  Script.exit(Intent.json(response))
}

run()
