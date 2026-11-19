import { createInterface } from 'node:readline'

// This test child exercises the real inherited pipe contract without contacting macOS.
process.on('message', ({ frames }) => {
  for (const frame of frames) process.stdout.write(JSON.stringify(frame) + '\n')
  process.send({ written: true })
})
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line)
  process.send({ command })
  if (command.id === 'no-response') continue
  const status =
    { status: 'not-determined', authorize: 'denied' }[command.kind] ??
    'authorized'
  process.stdout.write(
    JSON.stringify({ type: 'result', request: command.request, status }) + '\n',
  )
}
process.disconnect()
