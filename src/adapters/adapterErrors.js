export class AdapterNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdapterNotConfiguredError";
    this.statusCode = 501;
  }
}

export class AdapterHttpError extends Error {
  constructor(message, statusCode, details = {}) {
    super(message);
    this.name = "AdapterHttpError";
    this.statusCode = statusCode;
    this.details = details;
  }
}
