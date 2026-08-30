import { Button, List, Navigation, NavigationStack, Script, Text, useState } from "scripting"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function PickerAPITest() {
  const [status, setStatus] = useState("请选择测试")

  const testPhotos = async () => {
    setStatus("正在调用 Photos.pick")
    try {
      const results = await Photos.pick({
        filter: PHPickerFilter.images(),
        limit: 5,
      })
      setStatus(`Photos.pick 返回选择数量：${results.length}`)
    } catch (error) {
      setStatus(`Photos.pick 错误：${errorMessage(error)}`)
    }
  }

  const testFiles = async () => {
    try {
      const paths = await DocumentPicker.pickFiles()
      setStatus(`DocumentPicker.pickFiles 返回选择数量：${paths.length}`)
    } catch (error) {
      setStatus(`DocumentPicker.pickFiles 错误：${errorMessage(error)}`)
    }
  }

  return (
    <NavigationStack>
      <List navigationTitle="Picker API 测试">
        <Text>{status}</Text>
        <Button title="测试 Photos" action={() => void testPhotos()} />
        <Button title="测试 Files" action={() => void testFiles()} />
      </List>
    </NavigationStack>
  )
}

export default function PickerAPITestPage() {
  return <PickerAPITest />
}

async function run() {
  await Navigation.present(<PickerAPITest />)
  Script.exit()
}

run()
