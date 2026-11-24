/**
 * The `courier` command line. Plain Node: no Electron, no window, no desktop userData.
 *
 *   courier run <collection> [options]
 *   courier mock <collection> [options]
 *   courier help [command] | --help | --version
 *
 * Subcommands are `CommandSpec`s (args.ts) dispatched from `COMMANDS`; add one there to add a command.
 */
import { version } from '../../package.json'
import { toErrorInfo } from '../main/errors'
import { UsageError, commandHelp, parseCommand, type CommandSpec } from './args'
import { RUN_SPEC, runCommand, runConfig, type CliIO } from './run'
import { MOCK_SPEC, mockCommand, mockConfig } from './mock'

export const VERSION: string = version

interface Command {
  spec: CommandSpec
  run(argv: string[], io: CliIO): Promise<number>
}

const COMMANDS: Record<string, Command> = {
  run: {
    spec: RUN_SPEC,
    async run(argv, io) {
      const parsed = parseCommand(RUN_SPEC, argv)
      if (parsed.values.help) {
        io.stdout.write(commandHelp(RUN_SPEC))
        return 0
      }
      return runCommand(runConfig(parsed), io, VERSION)
    }
  },
  mock: {
    spec: MOCK_SPEC,
    async run(argv, io) {
      const parsed = parseCommand(MOCK_SPEC, argv)
      if (parsed.values.help) {
        io.stdout.write(commandHelp(MOCK_SPEC))
        return 0
      }
      return mockCommand(mockConfig(parsed), io)
    }
  }
}

export function mainHelp(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length)) + 3
  return [
    `Courier ${VERSION}: run Courier and Postman collections, and serve their saved examples, from the command line.`,
    '',
    'Usage: courier <command> [options]',
    '',
    'Commands:',
    ...Object.values(COMMANDS).map((c) => `  ${c.spec.name.padEnd(width)}${c.spec.brief}`),
    `  ${'help'.padEnd(width)}Show help for a command (courier help run).`,
    '',
    'Options:',
    '  -h, --help       Show this help.',
    '  -v, --version    Print the version.',
    '',
    'Azure sign-in: managed identity or the Azure CLI (az login), only when a run needs it: a team',
    'collection download, a {{vault:…}} reference, or Azure identity auth. No browser sign-in.',
    '',
    `"courier help <command>" shows one command's help. All of it:`
  ].join('\n') + '\n' + Object.values(COMMANDS).map((c) => `\n${'─'.repeat(100)}\n${commandHelp(c.spec)}`).join('')
}

/** Runs the command line; returns the exit code (0 passed, 1 failures, 2 usage/configuration error). */
export async function main(argv: string[], io: CliIO): Promise<number> {
  const [first, ...rest] = argv
  let current: string | undefined
  try {
    if (first === undefined || first === '--help' || first === '-h') {
      io.stdout.write(mainHelp())
      return first === undefined ? 2 : 0
    }
    if (first === '--version' || first === '-v') {
      io.stdout.write(`${VERSION}\n`)
      return 0
    }
    if (first === 'help') {
      const target = rest[0]
      if (target === undefined) io.stdout.write(mainHelp())
      else if (COMMANDS[target]) io.stdout.write(commandHelp(COMMANDS[target].spec))
      else throw new UsageError(`Unknown command "${target}".`)
      return 0
    }
    const cmd = COMMANDS[first]
    current = cmd ? first : undefined
    if (!cmd) throw new UsageError(first.startsWith('-') ? `Unknown option "${first}" (a command comes first, e.g. courier run <collection>).` : `Unknown command "${first}".`)
    return await cmd.run(rest, io)
  } catch (err) {
    if (err instanceof UsageError) {
      const command = err.command ?? current
      io.stderr.write(`courier: ${err.message}\nRun "courier ${command ? `help ${command}` : '--help'}" for usage.\n`)
      return 2
    }
    const e = toErrorInfo(err)
    io.stderr.write(`courier: error [${e.code}]: ${e.message}\n`)
    return 2
  }
}
