export class AdapterNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdapterNotConfiguredError";
    this.statusCode = 501;
  }
}
