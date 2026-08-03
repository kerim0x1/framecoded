import pc from "picocolors";

let verbose = false;
let activeProgress: TerminalProgress | undefined;

export interface ProgressReporter {
  stage(label: string, from: number, ceiling: number): void;
  update(value: number, label?: string): void;
  complete(label?: string): void;
  fail(label: string): void;
}

export function setVerbose(value: boolean): void {
  verbose = value;
}

function rawWrite(value: string): void {
  if (typeof process !== "undefined" && process.stderr) {
    process.stderr.write(value);
    return;
  }
  if (typeof console !== "undefined") {
    // eslint-disable-next-line no-console
    console.log(value.replace(/\n$/, ""));
  }
}

function out(value: string): void {
  const progress = activeProgress;
  progress?.clear();
  rawWrite(value);
  progress?.render();
}

function interactiveTerminal(): boolean {
  return Boolean(
    typeof process !== "undefined" &&
      process.stderr?.isTTY &&
      !process.env.CI &&
      process.env.TERM !== "dumb",
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function elapsedClock(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function elapsedLabel(startedAt: number): string {
  const elapsed = (Date.now() - startedAt) / 1000;
  if (elapsed < 60) return `${elapsed.toFixed(1)}s`;
  const minutes = Math.floor(elapsed / 60);
  return `${minutes}m ${String(Math.floor(elapsed % 60)).padStart(2, "0")}s`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 3))}...`;
}

class TerminalProgress implements ProgressReporter {
  private current = 0;
  private ceiling = 0;
  private label: string;
  private readonly startedAt = Date.now();
  private readonly interactive = interactiveTerminal();
  private readonly timer?: ReturnType<typeof setInterval>;
  private spinnerFrame = 0;
  private finished = false;

  constructor(label: string, from: number, ceiling: number) {
    activeProgress?.stop();
    activeProgress = this;
    this.label = label;
    this.current = clamp(from, 0, 99);
    this.ceiling = clamp(Math.max(this.current, ceiling), 0, 99);

    if (this.interactive) {
      this.timer = setInterval(() => this.tick(), 80);
      const timer = this.timer as ReturnType<typeof setInterval> & { unref?: () => void };
      timer.unref?.();
      this.render();
    } else {
      this.printStage();
    }
  }

  stage(label: string, from: number, ceiling: number): void {
    if (this.finished) return;
    this.label = label;
    this.current = clamp(Math.max(this.current, from), 0, 99);
    this.ceiling = clamp(Math.max(this.current, ceiling), 0, 99);
    if (this.interactive) this.render();
    else this.printStage();
  }

  update(value: number, label?: string): void {
    if (this.finished) return;
    this.current = clamp(Math.max(this.current, value), 0, 99);
    this.ceiling = this.current;
    if (label) this.label = label;
    if (this.interactive) this.render();
  }

  complete(label = "Export complete"): void {
    if (this.finished) return;
    this.finished = true;
    this.current = 100;
    this.ceiling = 100;
    this.label = label;
    if (this.timer) clearInterval(this.timer);

    if (this.interactive) {
      this.render(true);
      rawWrite("\n");
    } else {
      rawWrite(`${pc.green("[100%]")} ${label} ${pc.dim(`(${elapsedLabel(this.startedAt)})`)}\n`);
    }
    if (activeProgress === this) activeProgress = undefined;
  }

  fail(label: string): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearInterval(this.timer);
    this.clear();
    rawWrite(`${pc.red("[failed]")} ${pc.red(label)} ${pc.dim(`(${elapsedLabel(this.startedAt)})`)}\n`);
    if (activeProgress === this) activeProgress = undefined;
  }

  clear(): void {
    if (this.interactive && !this.finished) rawWrite("\r\x1b[2K");
  }

  render(final = false): void {
    if (!this.interactive || (this.finished && !final)) return;

    const columns = process.stderr.columns || 100;
    const barWidth = clamp(Math.floor(columns * 0.28), 16, 34);
    const percentage = Math.round(this.current);
    const filled = Math.round((barWidth * percentage) / 100);
    const bar =
      percentage >= 100
        ? "=".repeat(barWidth)
        : `${"=".repeat(Math.max(0, filled - 1))}${filled > 0 ? ">" : ""}${".".repeat(
            Math.max(0, barWidth - filled),
          )}`;
    const reserved = barWidth + 23;
    const label = truncate(this.label, Math.max(12, columns - reserved));
    const spinner = final ? "+" : ["|", "/", "-", "\\"][this.spinnerFrame % 4];

    rawWrite(
      `\r\x1b[2K ${pc.cyan(spinner)} ${pc.dim("[")}${pc.cyan(bar)}${pc.dim("]")} ${pc.bold(
        `${String(percentage).padStart(3, " ")}%`,
      )} ${label} ${pc.dim(elapsedClock(this.startedAt))}`,
    );
  }

  private tick(): void {
    if (this.finished) return;
    this.spinnerFrame += 1;
    if (this.current < this.ceiling) {
      const remaining = this.ceiling - this.current;
      this.current = Math.min(this.ceiling, this.current + Math.max(0.04, remaining * 0.018));
    }
    this.render();
  }

  private printStage(): void {
    rawWrite(`${pc.cyan(`[${String(Math.round(this.current)).padStart(3, " ")}%]`)} ${this.label}\n`);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.clear();
    this.finished = true;
  }
}

export const log = {
  intro(title: string, source: string) {
    out(`\n${pc.bgCyan(pc.black(pc.bold(" FRAMECODED ")))} ${pc.bold(title)}\n`);
    out(`${pc.dim("Source")}  ${source}\n\n`);
  },
  progress(label: string, from = 0, ceiling = 10): ProgressReporter {
    return new TerminalProgress(label, from, ceiling);
  },
  summary(title: string, rows: Array<[label: string, value: string | number]>) {
    const width = rows.reduce((longest, [label]) => Math.max(longest, label.length), 0);
    out(`\n${pc.bold(title)}\n`);
    for (const [label, value] of rows) {
      out(`  ${pc.dim(label.padEnd(width))}  ${value}\n`);
    }
  },
  info(msg: string) {
    out(`${pc.cyan("[i]")} ${msg}\n`);
  },
  step(msg: string) {
    out(`${pc.cyan("[>]")} ${pc.bold(msg)}\n`);
  },
  success(msg: string) {
    out(`${pc.green("[ok]")} ${msg}\n`);
  },
  warn(msg: string) {
    out(`${pc.yellow("[!]")} ${pc.yellow(msg)}\n`);
  },
  error(msg: string) {
    out(`${pc.red("[x]")} ${pc.red(msg)}\n`);
  },
  debug(msg: string) {
    if (verbose) out(`${pc.dim("[.]")} ${pc.dim(msg)}\n`);
  },
  plain(msg: string) {
    out(`${msg}\n`);
  },
};
