import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function createJsonStore(dbPath, initialDb) {
  function ensureDb() {
    const dataDir = dirname(dbPath);
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    if (!existsSync(dbPath)) writeFileSync(dbPath, JSON.stringify(initialDb(), null, 2));
  }

  return {
    read() {
      ensureDb();
      return JSON.parse(readFileSync(dbPath, "utf8"));
    },
    write(db) {
      writeFileSync(dbPath, JSON.stringify(db, null, 2));
    }
  };
}
