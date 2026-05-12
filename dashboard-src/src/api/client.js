/**
 * api/client.ts
 * Typed API client — wraps fetch with auth, error handling, base URL.
 */
const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000/api";
let accessToken = localStorage.getItem("access_token");
let refreshToken = localStorage.getItem("refresh_token");
function setTokens(access, refresh) {
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
async function refreshAccessToken() {
    if (!refreshToken)
        return false;
    try {
        const res = await fetch(`${BASE_URL}/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok)
            return false;
        const { data } = await res.json();
        setTokens(data.accessToken);
        return true;
    }
    catch {
        return false;
    }
}
async function request(method, path, body, retry = true) {
    const headers = { "Content-Type": "application/json" };
    if (accessToken)
        headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry) {
        const refreshed = await refreshAccessToken();
        if (refreshed)
            return request(method, path, body, false);
        clearTokens();
        window.location.href = "/login";
        throw new Error("Session expired");
    }
    const json = await res.json();
    if (!json.ok)
        throw new Error(json.error ?? "API error");
    return json.data;
}
export const api = {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path) => request("DELETE", path),
    login: async (username, password) => {
        const res = await fetch(`${BASE_URL}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        const json = await res.json();
        if (!json.ok)
            throw new Error(json.error);
        setTokens(json.data.accessToken, json.data.refreshToken);
        return json.data;
    },
    isAuthenticated: () => !!accessToken,
};
