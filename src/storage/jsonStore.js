import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { prepareDbForStorage, prepareDbFromStorage } from "../services/tokenStorage.js";

export function createJsonStore(dbPath, initialDb, env = process.env) {
  function ensureDb() {
    const dataDir = dirname(dbPath);
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    if (!existsSync(dbPath)) writeFileSync(dbPath, JSON.stringify(initialDb(), null, 2));
  }

  return {
    read() {
      ensureDb();
      return prepareDbFromStorage(JSON.parse(readFileSync(dbPath, "utf8")), env);
    },
    write(db) {
      writeFileSync(dbPath, JSON.stringify(prepareDbForStorage(db, env), null, 2));
    }
  };
}
