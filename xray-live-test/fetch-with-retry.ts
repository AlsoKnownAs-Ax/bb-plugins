import { retryDelayMs } from "./retry";

export async function fetchWithRetry(url: string, attempts: number): Promise<Response> {
  for (let attempt = 0; attempt < attempts - 1; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return response;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
  }
  return fetch(url);
}
