#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = process.env.HERDR_PLUGIN_ROOT || process.cwd()
const cli = path.join(root, 'bin', 'herdr-browser.mjs')

const url = process.env.HERDR_PLUGIN_CLICKED_URL
const args = url ? ['open', url] : ['open']

const result = spawnSync('node', [cli, ...args], { stdio: 'inherit' })
process.exitCode = result.status ?? (result.error ? 1 : 0)
