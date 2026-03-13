#!/usr/bin/env node
import cli from './cli/cli.js'

cli.serve().then(() => process.exit(0))
