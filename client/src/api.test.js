import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";

afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("sends the bearer token and JSON request body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ item: { id: "item-1" } })
    });
    const result = await api("/items", {
      token: "demo-token",
      method: "POST",
      body: JSON.stringify({ title: "New item" })
    });
    expect(result.item.id).toBe("item-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/items",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer demo-token",
          "Content-Type": "application/json"
        })
      })
    );
  });

  it("preserves HTTP conflict status and API error code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "This item changed.", code: "STALE_VERSION" })
    });
    await expect(api("/items/item-1", { token: "demo-token" })).rejects.toMatchObject({
      message: "This item changed.",
      status: 409,
      code: "STALE_VERSION"
    });
  });
});
