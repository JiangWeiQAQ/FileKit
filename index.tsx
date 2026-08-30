import { Navigation, Script } from "scripting"
import { FileKitView } from "./src/file-kit-view"

async function run() {
  try {
    await Navigation.present(<FileKitView source="main" />)
  } catch (error) {
    await Dialog.alert({
      title: "FileKit 已停止",
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    DocumentPicker.stopAcessingSecurityScopedResources()
    Script.exit()
  }
}

run()
