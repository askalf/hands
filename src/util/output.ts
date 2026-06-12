import chalk from 'chalk';

// HANDS_QUIET=1 suppresses all non-error output. Used by the agent-loop
// tests (heavy stdout from inside node:test child processes can corrupt
// the runner's serialized protocol stream on some Node versions), by
// `hands run --json` (stdout must carry only the result object), and
// available to operators who want hands silent in scripts.
function quiet(): boolean {
  return process.env['HANDS_QUIET'] === '1';
}

/** Exported for callers that gate non-output.* rendering (e.g. the CLI-mode spinner). */
export function isQuiet(): boolean {
  return quiet();
}

export function info(msg: string): void {
  if (quiet()) return;
  console.log(chalk.blue('ℹ'), msg);
}

export function success(msg: string): void {
  if (quiet()) return;
  console.log(chalk.green('✔'), msg);
}

export function warn(msg: string): void {
  if (quiet()) return;
  console.log(chalk.yellow('⚠'), msg);
}

export function error(msg: string): void {
  console.error(chalk.red('✖'), msg);
}

export function step(n: number, total: number, msg: string): void {
  if (quiet()) return;
  console.log(chalk.dim(`[${n}/${total}]`), msg);
}

export function header(msg: string): void {
  if (quiet()) return;
  console.log();
  console.log(chalk.bold.white(msg));
  console.log(chalk.dim('─'.repeat(Math.min(msg.length + 4, 60))));
}

export function cost(tokens: { input: number; output: number }, costUsd: number, turns: number): void {
  if (quiet()) return;
  console.log();
  console.log(chalk.dim('─'.repeat(40)));
  console.log(chalk.dim('Tokens:'), `${tokens.input.toLocaleString()} in / ${tokens.output.toLocaleString()} out`);
  console.log(chalk.dim('Cost:'), chalk.yellow(`$${costUsd.toFixed(4)}`));
  console.log(chalk.dim('Turns:'), turns);
  console.log(chalk.dim('─'.repeat(40)));
}

export function action(tool: string, detail?: string): void {
  if (quiet()) return;
  const label = chalk.cyan(`[${tool}]`);
  console.log(label, detail ?? '');
}
