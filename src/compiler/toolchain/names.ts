/**
 * The names a backend hands a target, and the scopes they are declared in.
 *
 * A name the IR holds is the name the source wrote, and a target needs a name
 * no other declaration holds: a name declared again in a nested block is a
 * different variable, and a target whose blocks do not shadow — Nim refuses a
 * second `var total` in a nested `if` — would refuse a program the language
 * accepts. Deciding which name each declaration is written as is a backend's
 * work, and both backends do it the same way, so it lives here.
 *
 * The type a name is declared at is kept with it, because a use converts
 * inside a kind and a target whose numbers do not convert on their own needs
 * the conversion written rather than assumed.
 */

import type { SemanticType } from "../core/semantic-ir.ts";

/**
 * The scope of declarations a backend is writing, and the names they are
 * written as. Escaping belongs to the target, so it is passed in: the C driver
 * escapes a name its own prelude holds, and the C function backend escapes a
 * name its includes and the runtime hold.
 */
export class NameScope {
  private readonly scopes: { name: string; emitted: string; type: SemanticType | null }[][] = [[]];
  private readonly taken = new Set<string>();

  /** Writes a name the way this target spells one that is not already taken. */
  private readonly escape: (name: string) => string;

  constructor(escape: (name: string) => string) {
    this.escape = escape;
  }

  /** Opens a scope, so the declarations made inside it stop at its close. */
  enter(): void {
    this.scopes.push([]);
  }

  /** Closes the scope opened last, and its declarations with it. */
  leave(): void {
    this.scopes.pop();
  }

  /**
   * Declares a name, writing it as a name no other declaration holds. The name
   * the source wrote is what the IR keeps; this is the name the target reads.
   */
  declare(name: string, type: SemanticType | null = null): string {
    let emitted = name;
    for (let index = 2; this.taken.has(emitted); index += 1) emitted = `${name}_${index}`;
    this.taken.add(emitted);
    this.scopes[this.scopes.length - 1].push({ name, emitted, type });
    return this.escape(emitted);
  }

  /** The declaration a name is read as, or null where nothing declares it. */
  declared(name: string): { emitted: string; type: SemanticType | null } | null {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const found = this.scopes[index].find((entry) => entry.name === name);
      if (found !== undefined) return { emitted: found.emitted, type: found.type };
    }
    return null;
  }

  /** The name the target knows a declared name by, or the name itself if none. */
  read(name: string): string {
    const declared = this.declared(name);
    return this.escape(declared === null ? name : declared.emitted);
  }

  /** The type a name is declared at, where a use has to be written at that type. */
  typeOf(name: string, otherwise: SemanticType): SemanticType {
    return this.declared(name)?.type ?? otherwise;
  }
}
