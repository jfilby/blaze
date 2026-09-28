/**
 * Writes the project files a build reads. A project is TOML, so a test states
 * it as the data it is and this turns it into the file the compiler parses,
 * rather than pasting a quoted document into every test that needs one.
 */

import { writeFile } from "node:fs/promises";
import { stringify } from "smol-toml";

/** Writes a project file: the TOML a build reads, from the project as data. */
export async function writeProject(path: string, project: object): Promise<void> {
  await writeFile(path, stringify(project), "utf8");
}
