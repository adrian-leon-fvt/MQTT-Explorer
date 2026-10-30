import assert from 'node:assert/strict'
import { ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { connectAsync, MqttClient } from 'mqtt'
import { Browser, chromium, Page } from 'playwright'

interface Step {
  messages: Array<{ topic: string; payload: string }>
  name: string | null
  type?: string
  value?: string | number
  status: string
  warning?: string
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  return address.port
}

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
}

async function selectTopic(page: Page, topic: string) {
  const segments = topic.split('/')
  let scope = page.locator('body')
  for (let index = 0; index < segments.length; index += 1) {
    const item = scope.getByRole('treeitem', { name: `Topic: ${segments[index]}`, exact: true }).first()
    await item.waitFor({ state: 'visible' })
    if (index === segments.length - 1 || (await item.getAttribute('aria-expanded')) === 'false') {
      await item.click()
    }
    scope = item.locator('..')
  }
}

async function main() {
  const steps: Step[] = JSON.parse(readFileSync(0, 'utf8'))
  assert(Array.isArray(steps) && steps.length > 0, 'Pipe Python fixtures into this runner')
  const directory = await mkdtemp(path.join(tmpdir(), 'mqtt-sparkplug-e2e-'))
  const children: ChildProcess[] = []
  let browser: Browser | undefined
  let page: Page | undefined
  let publisher: MqttClient | undefined
  let output = ''
  const start = async (command: string, args: string[], env = process.env) => {
    const child = spawn(command, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    child.stdout?.on('data', chunk => {
      output += chunk
    })
    child.stderr?.on('data', chunk => {
      output += chunk
    })
    await once(child, 'spawn')
    return child
  }
  try {
    const brokerPort = await unusedPort()
    const appPort = await unusedPort()
    const broker = await start(process.env.MOSQUITTO || 'mosquitto', ['-p', String(brokerPort)])
    {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        try {
          publisher = await connectAsync(`mqtt://127.0.0.1:${brokerPort}`, {
            reconnectPeriod: 0,
            connectTimeout: 500,
          })
          break
        } catch (error) {
          if (broker.exitCode !== null || Date.now() >= deadline) throw error
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
    }
    assert(publisher)
    await publisher.publishAsync('e2e-ready', 'ready', { retain: true, qos: 1 })
    const server = await start(process.execPath, [path.resolve(__dirname, '..', 'dist', 'src', 'server.js')], {
      ...process.env,
      PORT: String(appPort),
      MQTT_EXPLORER_SKIP_AUTH: 'true',
      MQTT_AUTO_CONNECT_HOST: '',
    })
    const url = `http://127.0.0.1:${appPort}`
    const deadline = Date.now() + 10000
    while (true) {
      try {
        const response = await fetch(url)
        assert(response.ok, `HTTP ${response.status}`)
        break
      } catch (error) {
        if (server.exitCode !== null || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', error => {
      output += `Browser error: ${error.message}\n`
    })
    page.on('console', entry => {
      output += `Browser ${entry.type()}: ${entry.text()}\n`
    })
    page.setDefaultTimeout(15000)
    await page.goto(url)
    await page.locator('//label[text()="Host"]/..//input').fill('127.0.0.1')
    await page.locator('//label[text()="Port"]/..//input').fill(String(brokerPort))
    await page.getByTestId('connect-button').click()
    await page.locator('span[data-test-topic="e2e-ready"]').waitFor()
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      for (let messageIndex = 0; messageIndex < step.messages.length; messageIndex += 1) {
        const item = step.messages[messageIndex]
        await publisher.publishAsync(item.topic, Buffer.from(item.payload, 'base64'), { qos: 1 })
      }
      await selectTopic(page, step.messages[step.messages.length - 1].topic)
      await page.locator('#valueRendererDisplayMode-raw').click()
      await page.waitForFunction(expected => {
        const text = document.querySelector('[data-testid="decoded-value"] div[tabindex="0"] > pre')?.textContent
        if (!text) return false
        let payload
        try {
          payload = JSON.parse(text)
        } catch {
          return false // UI may be between renders.
        }
        const metric = payload.metrics?.[0]
        return (
          payload.sparkplug?.status === expected.status &&
          (metric?.name ?? null) === expected.name &&
          (expected.type === undefined || metric?.type === expected.type) &&
          (expected.value === undefined || metric?.value === expected.value) &&
          (expected.warning
            ? payload.sparkplug.warnings.some((warning: string) => warning.includes(expected.warning!))
            : payload.sparkplug.warnings.length === 0)
        )
      }, step)
      if (step.warning) {
        assert((await page.getByRole('alert').textContent())?.includes(step.warning))
      }
      console.log(`PASS ${index + 1}: ${step.name ?? step.warning ?? step.status}`)
    }
  } catch (error) {
    if (page && !page.isClosed()) {
      console.error(
        'Rendered value:',
        await page.evaluate(() => document.querySelector('[data-testid="decoded-value"]')?.textContent)
      )
    }
    console.error(output)
    throw error
  } finally {
    await browser?.close()
    await publisher?.endAsync()
    await Promise.all(children.reverse().map(stop))
    await rm(directory, { recursive: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
