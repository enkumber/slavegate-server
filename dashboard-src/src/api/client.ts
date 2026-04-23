/**
 * api/client.ts
 * Typed API client — wraps fetch with auth, error handling, base URL.
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000/api";

let accessToken: string | null = localStorage.getItem("access_token");
let refreshToken: string | null = localStorage.getItem("refresh_token");

function setTokens(access: string, refresh?: string) {
  accessToken = access;
  localStorage.setItem("access_token", access);
  if (refresh) {
    refreshToken = refresh;
    localStorage.setItem("refresh_token", refresh);
  }
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const { data } = await res.json();
    setTokens(data.accessToken);
    return true;
  } catch {
    return false;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  retry = true
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request<T>(method, path, body, false);
    clearTokens();
    window.location.href = "/login";
    throw new Error("Session expired");
  }

  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? "API error");
  return json.data as T;
}

export const api = {
  get:    <T>(path: string)                => request<T>("GET", path),
  post:   <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch:  <T>(path: string, body: unknown)  => request<T>("PATCH", path, body),
  delete: <T>(path: string)                => request<T>("DELETE", path),

  login: async (username: string, password: string) => {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    setTokens(json.data.accessToken, json.data.refreshToken);
    return json.data;
  },

  isAuthenticated: () => !!accessToken,
};
