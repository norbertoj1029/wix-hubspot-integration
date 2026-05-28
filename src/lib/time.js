import crypto from "node:crypto";

export function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function now() {
  return new Date().toISOString();
}
