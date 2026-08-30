import type { FileInfo } from "./types"

export type BatchFailure = {
  index: number
  path: string
  name: string
  message: string
}

export type BatchResult<T> = {
  successes: T[]
  failures: BatchFailure[]
}

export async function runSerialImageBatch<T>(
  images: FileInfo[],
  worker: (image: FileInfo) => Promise<T>,
  onProgress: (completed: number, message: string) => void,
  errorMessage: (error: unknown) => string,
): Promise<BatchResult<T>> {
  const successes: T[] = []
  const failures: BatchFailure[] = []
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index]
    try {
      const output = await worker(image)
      successes.push(output)
      try {
        onProgress(index + 1, `已处理 ${image.name}`)
      } catch {
        // A UI progress update must not turn a committed output into a failed item.
      }
    } catch (error) {
      failures.push({ index, path: image.path, name: image.name, message: errorMessage(error) })
      try {
        onProgress(index + 1, `已跳过 ${image.name}`)
      } catch {
        // Continue the serial batch even if the view can no longer receive progress updates.
      }
    }
  }
  return { successes, failures }
}
