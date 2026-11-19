// Points a launcher link at another build, as one rename: a launch at that
// moment finds the old link or the new one, never none.

import { promises as fs } from "node:fs";
import { dirname, join, basename } from "node:path";

export async function relinkLauncher(link: string, target: string): Promise<void> {
  const stat = await fs.lstat(link);
  if (!stat.isSymbolicLink()) throw new Error(`${link} is not a link`);
  const temporary = join(dirname(link), `.${basename(link)}.codara-${process.pid}`);
  await fs.rm(temporary, { force: true });
  await fs.symlink(target, temporary);
  try {
    await fs.rename(temporary, link);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
