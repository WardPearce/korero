export function messageFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "The request could not be completed.";
}

export function requestError(error: unknown): Error {
  if (error && typeof error === "object" && "value" in error) {
    const value = error.value;
    if (value && typeof value === "object" && "error" in value) {
      return new Error(messageFrom(value.error));
    }
    return new Error(messageFrom(value));
  }
  return new Error(messageFrom(error));
}

