#!/usr/bin/env node
import { main } from '../src/cli.mjs'

const code = await main(process.argv.slice(2))
// Set exitCode instead of calling process.exit(): a hard exit while the
// WebSocket is closing aborts Node on Windows (libuv async assertion).
process.exitCode = code
