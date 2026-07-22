/**
 * Read-only, sandboxed tools for the pi kernel v0.
 *
 * v0 is deliberately read-only: no file writes, no shell. That keeps the very
 * first self-owned agent runtime safe by construction while still being genuinely
 * useful (codebase questions, "find where X is handled"). Every path is confined
 * to a root — resolved, symlink-followed, and re-checked for containment — so a
 * model cannot escape the root via `..` or a symlink.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ToolExecutor, ToolResult, ToolSpec } from './kernel.js';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_DIR_ENTRIES = 500;

export const READ_ONLY_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file, relative to the task root. Returns up to 64 KiB.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to the task root.' } }, required: ['path'] },
  },
  {
    name: 'list_dir',
    description: 'List the entries (files and folders) of a directory relative to the task root.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory path relative to the task root (use "." for the root).' } }, required: ['path'] },
  },
];

/** Resolve a requested path inside `root`, following symlinks, refusing any escape. */
async function resolveWithin(root: string, requested: unknown): Promise<string> {
  const rel = typeof requested === 'string' ? requested : '';
  const candidate = path.resolve(root, rel);
  // Lexical containment first (covers `..` before touching disk).
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error('path escapes the task root');
  }
  // Then follow symlinks and re-check, so a symlink inside root can't point out.
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    real = candidate; // not yet existing / unreadable — let the caller's op report it
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error('path escapes the task root');
  }
  return candidate;
}

async function readFileTool(root: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    const target = await resolveWithin(root, input.path);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return { content: `${input.path} is a directory; use list_dir.`, isError: true };
    const handle = await fs.open(target, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES, stat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const truncated = stat.size > MAX_FILE_BYTES ? `\n\n[truncated: file is ${stat.size} bytes, showed first ${MAX_FILE_BYTES}]` : '';
      return { content: `${text}${truncated}` };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { content: error instanceof Error ? error.message : 'read_file failed', isError: true };
  }
}

async function listDirTool(root: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    const target = await resolveWithin(root, input.path);
    const entries = await fs.readdir(target, { withFileTypes: true });
    const lines = entries.slice(0, MAX_DIR_ENTRIES).map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'}  ${entry.name}`);
    const more = entries.length > MAX_DIR_ENTRIES ? `\n… ${entries.length - MAX_DIR_ENTRIES} more` : '';
    return { content: `${lines.join('\n')}${more}` || '(empty)' };
  } catch (error) {
    return { content: error instanceof Error ? error.message : 'list_dir failed', isError: true };
  }
}

/** Build the read-only tool executor bound to a task root. */
export function createReadOnlyTools(root: string): { specs: ToolSpec[]; execute: ToolExecutor } {
  const resolvedRoot = path.resolve(root);
  const execute: ToolExecutor = async (name, input) => {
    if (name === 'read_file') return readFileTool(resolvedRoot, input);
    if (name === 'list_dir') return listDirTool(resolvedRoot, input);
    return { content: `unknown tool: ${name}`, isError: true };
  };
  return { specs: READ_ONLY_TOOL_SPECS, execute };
}
