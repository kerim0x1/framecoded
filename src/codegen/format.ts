import * as prettier from "prettier";
import { log } from "../util/log.js";

const BASE = { printWidth: 100, semi: true, singleQuote: false } as const;

export async function formatTsx(code: string): Promise<string> {
  return run(code, "babel-ts");
}
export async function formatTs(code: string): Promise<string> {
  return run(code, "babel-ts");
}
export async function formatCss(code: string): Promise<string> {
  return run(code, "css");
}
export async function formatJson(code: string): Promise<string> {
  return run(code, "json");
}

async function run(code: string, parser: prettier.LiteralUnion<prettier.BuiltInParserName, string>): Promise<string> {
  try {
    return await prettier.format(code, { parser, ...BASE });
  } catch (err) {
    log.debug(`prettier(${parser}) failed, emitting unformatted: ${(err as Error).message}`);
    return code.endsWith("\n") ? code : code + "\n";
  }
}
