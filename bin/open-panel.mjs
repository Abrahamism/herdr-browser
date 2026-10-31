#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const herdr = process.env.HERDR_BIN_PATH || 'herdr'
const result = spawnSync(herdr, ['plugin', 'pane', 'open', '--plugin', 'herdr.browser', '--entrypoint', 'tab-list'], {
  stdio: 'inherit'
})
process.exitCode = result.status ?? (result.error ? 1 : 0)
