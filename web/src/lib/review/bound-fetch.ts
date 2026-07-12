// The global `fetch`, bound to the realm global. Storing bare `fetch` in a
// variable and calling it (`const f = fetch; f(url)`) throws
// "TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation" in
// browser realms — which silently broke every browser owner-share flow (the
// Node owner-live test passes only because it injects its own bound fetch).
// Use this as the default whenever a `fetchImpl` seam is optional.
export const boundFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
