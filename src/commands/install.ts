import type { ArgumentsCamelCase, Argv } from 'yargs'
import { logger } from '../logger'
import { blue, green, red } from 'picocolors'
import {
  clientNames,
  readConfig,
  writeConfig,
  getConfigPath,
  getNestedValue,
  setNestedValue,
  type ClientConfig,
} from '../client-config'
import spawn from 'cross-spawn'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { maybePromptGithubStar } from '../star-prompt'

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'

// ── Membase defaults ────────────────────────────────────────────────
const DEFAULT_URL = 'https://mcp.membase.so/mcp'
const DEFAULT_NAME = 'membase'

// Helper to set a server config in a nested structure
function setServerConfig(
  config: ClientConfig,
  configKey: string,
  serverName: string,
  serverConfig: ClientConfig,
  client: string,
): void {
  // Get or create the nested config object
  let servers = getNestedValue(config, configKey)
  if (!servers) {
    setNestedValue(config, configKey, {})
    servers = getNestedValue(config, configKey)
  }

  // Set the server config
  if (servers) {
    if (client === 'goose') {
      // Goose has a different config structure and uses 'envs' instead of 'env'
      const { env, command, args, ...rest } = serverConfig
      servers[serverName] = {
        name: serverName,
        cmd: command,
        args: args,
        enabled: true,
        envs: env || {},
        type: 'stdio',
        timeout: 300,
        ...rest,
      }
    } else if (client === 'zed') {
      // Zed has a different config structure
      servers[serverName] = {
        source: 'custom',
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env || {},
        ...serverConfig,
      }
    } else if (client === 'opencode') {
      // OpenCode has a different config structure for MCP servers
      if ((serverConfig.command === 'npx' || serverConfig.command === 'npx.cmd') && serverConfig.args?.includes('mcp-remote@latest')) {
        // For remote MCP servers, OpenCode uses a different structure
        const urlIndex = serverConfig.args.indexOf('mcp-remote@latest') + 1
        const url = serverConfig.args[urlIndex]
        const headers: Record<string, string> = {}

        // Extract headers from args
        let i = serverConfig.args.indexOf('--header') + 1
        while (i > 0 && i < serverConfig.args.length) {
          const headerArg = serverConfig.args[i]
          if (headerArg && !headerArg.startsWith('--')) {
            const [key, value] = headerArg.split(':')
            if (key && value) {
              headers[key.trim()] = value.trim()
            }
          }
          i = serverConfig.args.indexOf('--header', i) + 1
        }

        servers[serverName] = {
          type: 'remote',
          url: url,
          enabled: true,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        }
      } else {
        // For local MCP servers
        servers[serverName] = {
          type: 'local',
          command: serverConfig.command,
          args: serverConfig.args || [],
          enabled: true,
          environment: {},
        }
      }
    } else {
      servers[serverName] = serverConfig
    }
  }
}

export interface InstallArgv {
  target?: string
  name?: string
  client?: string
  local?: boolean
  yes?: boolean
  header?: Array<string>
  oauth?: 'yes' | 'no'
  env?: Array<string>
}

export const command = '$0 [target]'
export const describe = 'Install Membase MCP server'

export function builder(yargs: Argv<InstallArgv>): Argv {
  return yargs
    .positional('target', {
      type: 'string',
      description: 'Package name, full command, or URL to install',
      default: DEFAULT_URL,
    })
    .option('name', {
      type: 'string',
      description: 'Name of the server (auto-extracted from target if not provided)',
    })
    .option('client', {
      type: 'string',
      description: 'Client to use for installation',
    })
    .option('local', {
      type: 'boolean',
      description: 'Install to the local directory instead of the default location',
      default: false,
    })
    .option('yes', {
      type: 'boolean',
      alias: 'y',
      description: 'Skip confirmation prompt',
      default: true,
    })
    .option('header', {
      type: 'array',
      description: 'Headers to pass to the server (format: "Header: value")',
      default: [],
    })
    .option('oauth', {
      type: 'string',
      description: 'Whether the server uses OAuth authentication (yes/no). Defaults to yes.',
      choices: ['yes', 'no'],
      default: 'yes',
    } as const)
    .option('env', {
      type: 'array',
      description: 'Environment variables to pass to the server (format: --env key value)',
      default: [],
    })
}

function isUrl(input: string): boolean {
  return input.startsWith('http://') || input.startsWith('https://')
}

function isCommand(input: string): boolean {
  return input.includes(' ') || input.startsWith('npx ') || input.startsWith('node ')
}

function inferNameFromInput(input: string): string {
  if (isUrl(input)) {
    // For URLs like https://example.com/path -> example-com
    try {
      const url = new URL(input)
      return url.hostname.replace(/\./g, '-')
    } catch {
      // Fallback for malformed URLs
      const parts = input.split('/')
      return parts[parts.length - 1] || 'server'
    }
  } else if (isCommand(input)) {
    // For commands, extract package name
    const parts = input.split(' ')
    if (parts[0] === 'npx' && parts.length > 1) {
      // Skip flags like -y and get the package name
      const packageIndex = parts.findIndex((part, index) => index > 0 && !part.startsWith('-'))
      if (packageIndex !== -1) {
        return parts[packageIndex] || 'server'
      }
    }
    return parts[0] || 'server'
  } else {
    // Simple package name like "mcp-server" or "@org/mcp-server"
    return input
  }
}

function buildCommand(input: string): string {
  if (isUrl(input)) {
    return input // URLs are handled separately
  } else if (isCommand(input)) {
    return input // Already a full command
  } else {
    // Simple package name, convert to npx command
    return `npx ${input}`
  }
}

// Parse environment variables from array format into key-value object
function parseEnvVars(envArray?: Array<string>): { [key: string]: string } | undefined {
  if (!envArray || envArray.length === 0) {
    return undefined
  }

  const envObj: { [key: string]: string } = {}
  for (let i = 0; i < envArray.length; i += 2) {
    const key = envArray[i]
    const value = envArray[i + 1]
    if (key && value !== undefined) {
      envObj[key] = value
    }
  }

  return Object.keys(envObj).length > 0 ? envObj : undefined
}

async function runAuthentication(url: string): Promise<void> {
  logger.info(`Running authentication for ${url}`)
  return new Promise((resolve, reject) => {
    const child = spawn(npxCmd, ['-y', '-p', 'mcp-remote@latest', 'mcp-remote-client', url], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Authentication exited with code ${code}`))
      }
    })

    child.on('error', reject)
  })
}

// ── AGENTS.md injection ──────────────────────────────────────────────

const MEMBASE_MARKER_START = '<!-- MEMBASE:START -->'
const MEMBASE_MARKER_END = '<!-- MEMBASE:END -->'

const AGENTS_BLOCK = `${MEMBASE_MARKER_START}
## Membase Memory

You have access to Membase long-term memory via MCP.

**Rules:**
1) For user-specific context questions, call search_memory before answering.
2) Use resources strategically: read membase://profile for stable user settings and read membase://recent for latest-context questions or after resource update notifications.
3) When durable user context is learned, call add_memory without asking for permission first.
4) Never store secrets (passwords, tokens, API keys, OTPs).
5) Do not store transient one-off states unless the user explicitly asks.
6) Membase syncs with user's Google Calendar and Gmail. Use search_memory to answer questions about their schedule, meetings, or emails.
${MEMBASE_MARKER_END}`

function injectAgentsGuide(): void {
  const agentsPath = join(process.cwd(), 'AGENTS.md')

  if (existsSync(agentsPath)) {
    const existing = readFileSync(agentsPath, 'utf-8')

    if (existing.includes(MEMBASE_MARKER_START)) {
      const updated = existing.replace(
        new RegExp(`${MEMBASE_MARKER_START}[\\s\\S]*?${MEMBASE_MARKER_END}`),
        AGENTS_BLOCK,
      )
      writeFileSync(agentsPath, updated, 'utf-8')
      logger.log(green('  ✓ Updated Membase section in AGENTS.md'))
    } else {
      const separator = existing.endsWith('\n') ? '\n' : '\n\n'
      writeFileSync(agentsPath, `${existing}${separator}${AGENTS_BLOCK}\n`, 'utf-8')
      logger.log(green('  ✓ Added Membase section to AGENTS.md'))
    }
  } else {
    writeFileSync(agentsPath, `${AGENTS_BLOCK}\n`, 'utf-8')
    logger.log(green('  ✓ Created AGENTS.md with Membase section'))
  }
}

export async function handler(argv: ArgumentsCamelCase<InstallArgv>) {
  let client = argv.client

  if (!client || !clientNames.includes(client)) {
    client = (await logger.prompt('Select a client to install for:', {
      type: 'select',
      options: clientNames.map((name) => ({ value: name, label: name })),
    })) as string
  }

  // Default target to Membase MCP URL
  let target = argv.target || DEFAULT_URL
  const name = argv.name || (target === DEFAULT_URL ? DEFAULT_NAME : inferNameFromInput(target))
  const command = buildCommand(target)
  const envVars = parseEnvVars(argv.env)

  if (client === 'warp') {
    logger.log('')
    logger.info('Warp requires a manual installation through their UI.')
    logger.log('  Please copy the following configuration object and add it to your Warp MCP config:\n')

    // Build args array for Warp
    let warpArgs: Array<string>
    if (isUrl(target)) {
      warpArgs = ['-y', 'mcp-remote@latest', target]
      // Add headers as arguments
      if (argv.header && argv.header.length > 0) {
        for (const header of argv.header) {
          warpArgs.push('--header', String(header))
        }
      }
    } else {
      warpArgs = command.split(' ').slice(1)
    }

    logger.log(
      JSON.stringify(
        {
          [name]: {
            command: isUrl(target) ? npxCmd : command.split(' ')[0],
            args: warpArgs,
            env: envVars || {},
            working_directory: null,
            start_on_launch: true,
          },
        },
        null,
        2,
      )
        .split('\n')
        .map((line) => green(`  ${line}`))
        .join('\n'),
    )
    logger.box("Read Warp's documentation at", blue('https://docs.warp.dev/knowledge-and-collaboration/mcp'))
    return
  }

  logger.info(`Installing MCP server "${name}" for ${client}${argv.local ? ' (locally)' : ''}`)

  let ready = argv.yes
  if (!ready) {
    ready = await logger.prompt(green(`Install MCP server "${name}" in ${client}?`), {
      type: 'confirm',
    })
  }

  if (ready) {
    if (isUrl(target)) {
      // Determine if we should use OAuth
      let usesOAuth: boolean
      if (argv.oauth === 'yes') {
        usesOAuth = true
      } else if (argv.oauth === 'no') {
        usesOAuth = false
      } else {
        // Ask if the server uses OAuth
        usesOAuth = await logger.prompt('Does this server use OAuth authentication?', {
          type: 'confirm',
        })
      }

      if (usesOAuth) {
        try {
          await runAuthentication(target)
        } catch {
          logger.error(red('Authentication failed.'))
          logger.info('')
          logger.info(blue(`💡 Try running without OAuth:`))
          logger.info(green(`   npx -y membase --client ${client} --oauth=no`))
          logger.info('')
          logger.info('You can also authenticate later through your client.')
          return
        }
      }
    }

    try {
      const config = readConfig(client, argv.local)
      const configPath = getConfigPath(client, argv.local)
      const configKey = configPath.configKey

      if (isUrl(target)) {
        // URL-based installation
        const args = ['-y', 'mcp-remote@latest', target]
        // Add headers as arguments
        if (argv.header && argv.header.length > 0) {
          for (const header of argv.header) {
            args.push('--header', String(header))
          }
        }
        const serverConfig: ClientConfig = {
          command: npxCmd,
          args: args,
        }
        if (envVars) {
          serverConfig.env = envVars
        }
        setServerConfig(config, configKey, name, serverConfig, client)
      } else {
        // Command-based installation (including simple package names)
        const cmdParts = command.split(' ')
        const serverConfig: ClientConfig = {
          command: cmdParts[0] === 'npx' ? npxCmd : cmdParts[0],
          args: cmdParts.slice(1),
        }
        if (envVars) {
          serverConfig.env = envVars
        }
        setServerConfig(config, configKey, name, serverConfig, client)
      }

      writeConfig(config, client, argv.local)
      logger.box(
        green(`Successfully installed MCP server "${name}" in ${client}${argv.local ? ' (locally)' : ''}`),
      )
      injectAgentsGuide()
      await maybePromptGithubStar({
        logFn: (msg) => logger.log(msg),
        warnFn: (msg) => logger.warn(msg),
      })
      logger.log('')
    } catch (e) {
      logger.error(red((e as Error).message))
    }
  }
}
