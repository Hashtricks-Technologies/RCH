import { hash, verify } from "@node-rs/argon2";

// Argon2id is the library's default algorithm (its `Algorithm` export is a `const enum`, which
// `verbatimModuleSyntax` forbids importing across a compiled package boundary — TS2748), so it is
// left unset here and only the cost parameters are pinned.
const OPTS = { memoryCost: 65536, timeCost: 3, parallelism: 1 };

export const hashPassword = (plain: string): Promise<string> => hash(plain, OPTS);

export const verifyPassword = async (h: string, plain: string): Promise<boolean> => {
  try { return await verify(h, plain); } catch { return false; }
};
