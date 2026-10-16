export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorHandler(error, _request, response, _next) {
  if (error?.type === "entity.too.large") {
    return response.status(413).json({ error: "Request body is too large.", code: "PAYLOAD_TOO_LARGE" });
  }
  if ((error?.type === "entity.parse.failed" || error instanceof SyntaxError) && error.status === 400 && "body" in error) {
    return response.status(400).json({ error: "Request body must contain valid JSON.", code: "INVALID_JSON" });
  }
  if (error?.code === "P2002") {
    return response.status(409).json({ error: "A record with those details already exists.", code: "CONFLICT" });
  }
  if (error?.code === "P2025") {
    return response.status(404).json({ error: "The requested resource was not found.", code: "NOT_FOUND" });
  }
  if (error instanceof HttpError) {
    return response.status(error.status).json({ error: error.message, code: error.code });
  }
  console.error("Unhandled request error:", error);
  return response.status(500).json({ error: "An unexpected server error occurred.", code: "INTERNAL_ERROR" });
}
