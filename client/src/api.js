const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000/api";

export async function api(path, { token, ...options } = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(data?.error || "The request could not be completed.");
    error.status = response.status;
    error.code = data?.code;
    throw error;
  }
  return data;
}
